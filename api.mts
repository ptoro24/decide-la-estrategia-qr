import type { Config, Context } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

/*
 * Decide la estrategia — API de votación por QR
 *
 * Claves en el store (por sala <CODE>):
 *   <CODE>/meta                        { key, createdAt }
 *   <CODE>/state                       estado público publicado por el profesor (+ endsAt, savedAt)
 *   <CODE>/v/<i>/<voter>/<ts>-<opt>    voto vigente (el valor va en la clave: el profesor lo lee con un solo list)
 *   <CODE>/p/<team>/<device>           presencia de un celular en un equipo   (modo equipos)
 *   <CODE>/u/<pid>/<nombre-b64url>     alumno registrado                      (modo individual)
 */

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function store() {
  const opts = { name: "decide-estrategia", consistency: "strong" as const };
  if (Netlify.context?.deploy?.context === "production") return getStore(opts);
  return getDeployStore(opts);
}
type Store = ReturnType<typeof store>;

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

const clean = (s: unknown, max = 40) => String(s ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, max);
const code4 = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const b64e = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const b64d = (s: string) => { try { return Buffer.from(s, "base64url").toString("utf8"); } catch { return ""; } };
const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);

function randomCode(n = 4) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALPHA[x % ALPHA.length]).join("");
}
function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function isHost(st: Store, code: string, key: unknown) {
  if (!code || !key) return false;
  const meta = await st.get(`${code}/meta`, { type: "json" });
  return !!meta && meta.key === key;
}

function votingOpen(state: any, i: number, now: number) {
  if (!state || state.phase !== "case" || state.revealed) return false;
  if (state.i !== i) return false;
  if (state.endsAt && now > state.endsAt + 2500) return false;
  if (state.timed && !state.running && typeof state.remaining === "number" && state.remaining <= 0) return false;
  return true;
}

/* Lee los votos vigentes de un caso: { votante: opción } con un solo list */
async function readVotes(st: Store, code: string, i: number) {
  const { blobs } = await st.list({ prefix: `${code}/v/${i}/` });
  const best: Record<string, { ts: number; opt: string }> = {};
  for (const b of blobs) {
    const parts = b.key.split("/");
    const voter = parts[3];
    const [tsRaw, opt] = (parts[4] || "").split("-");
    const ts = parseInt(tsRaw, 36) || 0;
    if (!voter || !opt) continue;
    if (!best[voter] || ts >= best[voter].ts) best[voter] = { ts, opt };
  }
  const out: Record<string, string> = {};
  for (const [v, o] of Object.entries(best)) out[v] = o.opt;
  return out;
}

async function writeVote(st: Store, code: string, i: number, voter: string, opt: string | null, now: number) {
  const prefix = `${code}/v/${i}/${voter}/`;
  let newKey = "";
  if (opt) {
    newKey = `${prefix}${now.toString(36)}-${opt}`;
    await st.set(newKey, "1");
  }
  const { blobs } = await st.list({ prefix });
  await Promise.all(blobs.filter((b) => b.key !== newKey).map((b) => st.delete(b.key)));
}

async function readPlayers(st: Store, code: string) {
  const { blobs } = await st.list({ prefix: `${code}/u/` });
  const map: Record<string, string> = {};
  for (const b of blobs) {
    const [, , pid, enc] = b.key.split("/");
    if (pid && enc) map[pid] = b64d(enc);
  }
  return Object.entries(map).map(([id, name]) => ({ id, name }));
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const st = store();
  const now = Date.now();

  try {
    /* ── Crear sala (profesor) ── */
    if (route === "room" && req.method === "POST") {
      let code = "";
      for (let t = 0; t < 8; t++) {
        const c = randomCode(4);
        if (!(await st.get(`${c}/meta`))) { code = c; break; }
      }
      if (!code) return json({ error: "no_code" }, 503);
      const key = randomKey();
      const body = await req.json().catch(() => ({}));
      await st.setJSON(`${code}/meta`, { key, createdAt: now });
      await st.setJSON(`${code}/state`, { phase: "lobby", mode: body.mode === "ind" ? "ind" : "team", v: 0, savedAt: now });
      return json({ code, key });
    }

    /* ── Publicar estado (profesor) ── */
    if (route === "state" && req.method === "POST") {
      const body = await req.json();
      const code = code4(body.code);
      if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
      const s = body.state || {};
      s.savedAt = now;
      s.endsAt = typeof s.remaining === "number" && s.running ? now + Math.max(0, s.remaining) * 1000 : null;
      await st.setJSON(`${code}/state`, s);
      return json({ ok: true, savedAt: now, endsAt: s.endsAt });
    }

    /* ── Estado para los celulares (igual para todos: se cachea 2 s en el CDN) ── */
    if (route === "state" && req.method === "GET") {
      const code = code4(url.searchParams.get("code"));
      const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
      if (!state) return json({ error: "no_room" }, 404);
      let tv: Record<string, string> | null = null;
      let nv = 0;
      if (state.phase === "case" && typeof state.i === "number" && !state.revealed) {
        const votes = await readVotes(st, code, state.i);
        nv = Object.keys(votes).length;
        if (state.mode !== "ind") tv = votes; // en modo equipos, cada equipo ve su voto vigente
      }
      return json({ state, tv, nv, serverNow: now }, 200, {
        "cache-control": "public, max-age=0, must-revalidate",
        "netlify-cdn-cache-control": "public, durable, s-maxage=2",
        "netlify-vary": "query=code",
      });
    }

    /* ── Unirse (celular) ── */
    if (route === "join" && req.method === "POST") {
      const body = await req.json();
      const code = code4(body.code);
      const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
      if (!state) return json({ error: "no_room" }, 404);
      if (state.mode === "ind") {
        const pid = clean(body.pid, 24), name = cleanName(body.name);
        if (!pid || !name) return json({ error: "bad_request" }, 400);
        const { blobs } = await st.list({ prefix: `${code}/u/${pid}/` });
        await Promise.all(blobs.map((b) => st.delete(b.key)));
        await st.set(`${code}/u/${pid}/${b64e(name)}`, "1");
        return json({ ok: true, name });
      }
      const team = clean(body.team, 2), dev = clean(body.device, 32);
      if (team === "" || !dev) return json({ error: "bad_request" }, 400);
      await st.set(`${code}/p/${team}/${dev}`, String(now));
      return json({ ok: true });
    }

    /* ── Votar (celular o profesor) ── */
    if (route === "vote" && req.method === "POST") {
      const body = await req.json();
      const code = code4(body.code);
      const i = Number(body.i);
      const opt = body.opt === null ? null : clean(body.opt, 12);
      if (!code || !Number.isInteger(i)) return json({ error: "bad_request" }, 400);
      const host = body.key ? await isHost(st, code, body.key) : false;
      const state = await st.get(`${code}/state`, { type: "json" });
      if (!state) return json({ error: "no_room" }, 404);
      const voter = state.mode === "ind" ? clean(body.voter, 24) : clean(body.team, 2);
      if (voter === "") return json({ error: "bad_request" }, 400);
      if (!host) {
        if (!votingOpen(state, i, now)) return json({ error: "closed" }, 409);
        if (!(state.opts || []).some((o: any) => o.id === opt)) return json({ error: "bad_option" }, 400);
        if (state.mode === "ind") {
          const { blobs } = await st.list({ prefix: `${code}/u/${voter}/` });
          if (!blobs.length) return json({ error: "not_registered" }, 403);
        }
      }
      await writeVote(st, code, i, voter, opt, now);
      return json({ ok: true, vote: opt });
    }

    /* ── Sondeo del profesor: votos del caso + conectados ── */
    if (route === "poll" && req.method === "GET") {
      const code = code4(url.searchParams.get("code"));
      if (!(await isHost(st, code, url.searchParams.get("key")))) return json({ error: "forbidden" }, 403);
      const mode = url.searchParams.get("mode") === "ind" ? "ind" : "team";
      const out: any = { votes: {}, present: {}, players: [], serverNow: now };
      const iParam = url.searchParams.get("i");
      const jobs: Promise<unknown>[] = [];
      if (iParam !== null && iParam !== "") jobs.push(readVotes(st, code, Number(iParam)).then((v) => (out.votes = v)));
      if (mode === "ind") jobs.push(readPlayers(st, code).then((p) => (out.players = p)));
      else jobs.push(st.list({ prefix: `${code}/p/` }).then(({ blobs }) => {
        for (const b of blobs) { const t = b.key.split("/")[2]; out.present[t] = (out.present[t] || 0) + 1; }
      }));
      await Promise.all(jobs);
      return json(out);
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
