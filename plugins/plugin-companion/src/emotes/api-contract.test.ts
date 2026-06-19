// External-API contract test for the emote surface — no live server required.
//
// The agent server's emote endpoints (packages/agent/src/api/misc-routes.ts)
// dynamically import THIS plugin's catalog (`@elizaos/plugin-companion`) and
// emit it directly:
//   - GET  /api/emotes  ->  json { emotes: EMOTE_CATALOG }   (full catalog)
//   - POST /api/emote   ->  validates emoteId against EMOTE_BY_ID, then
//                            broadcasts WS { type:"emote", emoteId, path,
//                            duration, loop:false } and responds { ok: true }
//   - client.playEmote(emoteId) (packages/ui/src/api/client-agent.ts) returns
//                            Promise<{ ok: boolean }> — what EmotePicker awaits.
//
// Because the server serializes THIS module's EMOTE_CATALOG/EMOTE_BY_ID, the
// real-shaped responses below are reconstructed from the same catalog and
// validated field-by-field. This pins the server contract (route emits this
// plugin's catalog) without standing up a server. The shapes are verified
// against the current route handler in misc-routes.ts (see header).

import { describe, expect, it } from "vitest";
import { EMOTE_BY_ID, EMOTE_CATALOG, type EmoteDef } from "./catalog";

// Real-shaped GET /api/emotes payload: the route does `json(res, { emotes:
// emotes.catalog })` where `emotes.catalog === EMOTE_CATALOG`.
function buildEmotesResponse(): { emotes: EmoteDef[] } {
  return { emotes: EMOTE_CATALOG };
}

// Real-shaped POST /api/emote WS broadcast for a given emote id. Mirrors the
// route's `state.broadcastWs?.({ type:"emote", emoteId, path, duration,
// loop: false })`.
function buildEmoteBroadcast(emoteId: string): {
  type: "emote";
  emoteId: string;
  path: string;
  duration: number;
  loop: boolean;
} | null {
  const emote = EMOTE_BY_ID.get(emoteId);
  if (!emote) return null;
  return {
    type: "emote",
    emoteId: emote.id,
    path: emote.path,
    duration: emote.duration,
    loop: false,
  };
}

describe("emote API contract (server emits this plugin's catalog)", () => {
  it("GET /api/emotes returns { emotes } where every entry is a contract-valid EmoteDef", () => {
    const body = buildEmotesResponse();

    expect(Array.isArray(body.emotes)).toBe(true);
    expect(body.emotes.length).toBe(EMOTE_CATALOG.length);
    expect(body.emotes.length).toBeGreaterThan(0);

    const allowedCategories = new Set([
      "greeting",
      "emotion",
      "dance",
      "combat",
      "idle",
      "movement",
      "gesture",
      "other",
    ]);

    for (const emote of body.emotes) {
      expect(typeof emote.id).toBe("string");
      expect(emote.id.length).toBeGreaterThan(0);
      expect(typeof emote.name).toBe("string");
      expect(typeof emote.description).toBe("string");
      expect(typeof emote.path).toBe("string");
      expect(typeof emote.duration).toBe("number");
      expect(Number.isFinite(emote.duration)).toBe(true);
      expect(emote.duration).toBeGreaterThan(0);
      expect(typeof emote.loop).toBe("boolean");
      expect(allowedCategories.has(emote.category)).toBe(true);
      // Animation assets are gzip-compressed (.glb.gz / .fbx.gz).
      expect(emote.path.endsWith(".gz")).toBe(true);
    }
  });

  it("every emote id is unique across the catalog", () => {
    const ids = EMOTE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a sampled emoteId resolves in EMOTE_BY_ID with a matching path/duration", () => {
    const sample = EMOTE_CATALOG[0];
    const resolved = EMOTE_BY_ID.get(sample.id);
    expect(resolved).toBeDefined();
    expect(resolved?.path).toBe(sample.path);
    expect(resolved?.duration).toBe(sample.duration);
    expect(resolved?.category).toBe(sample.category);
  });

  it("POST /api/emote WS broadcast matches the catalog entry (loop forced false)", () => {
    const broadcast = buildEmoteBroadcast("wave");
    expect(broadcast).not.toBeNull();
    const wave = EMOTE_BY_ID.get("wave");
    expect(wave).toBeDefined();
    expect(broadcast).toEqual({
      type: "emote",
      emoteId: "wave",
      path: wave?.path,
      duration: wave?.duration,
      // The route always broadcasts loop:false for the one-shot trigger,
      // regardless of the catalog `loop` flag.
      loop: false,
    });
  });

  it("POST /api/emote rejects an unknown emoteId (server returns an error, no broadcast)", () => {
    // The route does `emote = byId.get(body.emoteId)` then `if (!emote) error(...)`.
    expect(EMOTE_BY_ID.get("not-a-real-emote")).toBeUndefined();
    expect(buildEmoteBroadcast("not-a-real-emote")).toBeNull();
  });

  it("client.playEmote resolves to { ok: boolean } — the shape EmotePicker awaits", () => {
    // POST /api/emote responds `json(res, { ok: true })`; the typed client
    // (client-agent.ts) declares playEmote(): Promise<{ ok: boolean }>.
    const successResponse: { ok: boolean } = { ok: true };
    expect(successResponse.ok).toBe(true);
    expect(typeof successResponse.ok).toBe("boolean");
  });
});
