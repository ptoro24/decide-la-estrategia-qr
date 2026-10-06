import type { Config, Context } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

/*
 * Decide la estrategia — API de votación por QR
 *
 * Claves en el store:
 *   <CODE>/meta              { key, createdAt }
 *   <CODE>/state             estado público publicado por el profesor (+ endsAt, savedAt)
 *   <CODE>/v/<i>/<team>      { opt, at, by }   voto vigente del equipo para el caso i
 *   <CODE>/p/<team>/<dev>    { at }            presencia de un celular en un equipo
 */

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function store() {
  const opts = { name: "decide-estrategia", consistency: "strong" as const };
  if (Netlify.context?.deploy?.context === "production") return getStore(opts);
  return getDeployStore(opts);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const clean = (s: unknown, max = 40) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, max);
const code4 = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

function randomCode(n = 4) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALPHA[x % ALPHA.length]).join("");
}
function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function isHost(st: ReturnType<typeof store>, code: string, key: unknown) {
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

export default async (req: Request, context: Context) => {
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
      await st.setJSON(`${code}/meta`, { key, createdAt: now });
      await st.setJSON(`${code}/state`, { phase: "lobby", v: 0, savedAt: now });
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

    /* ── Estado para el celular ── */
    if (route === "state" && req.method === "GET") {
      const code = code4(url.searchParams.get("code"));
      const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
      if (!state) return json({ error: "no_room" }, 404);
      const team = url.searchParams.get("team");
      let teamVote = null;
      if (team !== null && team !== "" && state.phase === "case" && typeof state.i === "number") {
        const v = await st.get(`${code}/v/${state.i}/${clean(team, 2)}`, { type: "json" });
        teamVote = v ? v.opt : null;
      }
      return json({ state, teamVote, serverNow: now });
    }

    /* ── Unirse a un equipo (celular) ── */
    if (route === "join" && req.method === "POST") {
      const body = await req.json();
      const code = code4(body.code);
      const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
      if (!state) return json({ error: "no_room" }, 404);
      const team = clean(body.team, 2), dev = clean(body.device, 32);
      if (team === "" || !dev) return json({ error: "bad_request" }, 400);
      await st.setJSON(`${code}/p/${team}/${dev}`, { at: now });
      return json({ ok: true });
    }

    /* ── Votar (celular o profesor) ── */
    if (route === "vote" && req.method === "POST") {
      const body = await req.json();
      const code = code4(body.code);
      const team = clean(body.team, 2);
      const i = Number(body.i);
      const opt = body.opt === null ? null : clean(body.opt, 12);
      if (!code || team === "" || !Number.isInteger(i)) return json({ error: "bad_request" }, 400);
      const host = body.key ? await isHost(st, code, body.key) : false;
      const state = await st.get(`${code}/state`, { type: "json" });
      if (!state) return json({ error: "no_room" }, 404);
      if (!host) {
        if (!votingOpen(state, i, now)) return json({ error: "closed" }, 409);
        const valid = (state.opts || []).some((o: any) => o.id === opt);
        if (!valid) return json({ error: "bad_option" }, 400);
        const dev = clean(body.device, 32);
        if (dev) await st.setJSON(`${code}/p/${team}/${dev}`, { at: now });
      }
      const k = `${code}/v/${i}/${team}`;
      if (opt) await st.setJSON(k, { opt, at: now, by: host ? "host" : "phone" });
      else await st.delete(k);
      return json({ ok: true, teamVote: opt });
    }

    /* ── Sondeo del profesor: votos del caso + celulares conectados ── */
    if (route === "poll" && req.method === "GET") {
      const code = code4(url.searchParams.get("code"));
      if (!(await isHost(st, code, url.searchParams.get("key")))) return json({ error: "forbidden" }, 403);
      const out: { votes: Record<string, string>; present: Record<string, number>; serverNow: number } = { votes: {}, present: {}, serverNow: now };
      const iParam = url.searchParams.get("i");
      if (iParam !== null && iParam !== "") {
        const i = Number(iParam);
        const { blobs } = await st.list({ prefix: `${code}/v/${i}/` });
        const got = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" }).then((v) => [b.key.split("/").pop(), v] as const)));
        for (const [t, v] of got) if (t !== undefined && v && v.opt) out.votes[t] = v.opt;
      }
      const { blobs: pres } = await st.list({ prefix: `${code}/p/` });
      for (const b of pres) {
        const t = b.key.split("/")[2];
        out.present[t] = (out.present[t] || 0) + 1;
      }
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
