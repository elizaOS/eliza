/**
 * POST /api/v1/voice/speech/session runs its consent consume and Durable
 * Object ledger write concurrently and reports each phase in Server-Timing.
 * Real route; caller auth, the consent store and the session DO are stubbed.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.NODE_ENV = "test";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const NONCE = "33333333-3333-4333-8333-333333333333";
let consented = true;
let order: string[] = [];
let releaseConsume: () => void = () => {};
let releaseInitialize: () => void = () => {};

const realAuth = {
  ...(await import("@/api-app/lib/generative-route-auth")),
};
mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...realAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: USER, organization_id: ORG },
    apiKeyId: "key-1",
    authSource: "combined_cache",
    appScopeId: null,
    credential: { kind: "api_key", credentialId: "key-1", userId: USER },
  }),
}));
mock.module("@elizaos/cloud-shared/lib/voice-session/consent-nonce", () => ({
  issueConsentNonce: async () => ({
    nonce: NONCE,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }),
  consumeConsentNonce: async (userId: string, nonce: string) => {
    expect([userId, nonce]).toEqual([USER, NONCE]);
    order.push("consume-start");
    await new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    order.push("consume-end");
    return consented;
  },
}));

const { Hono } = await import("hono");
const { default: speechRoute } = await import("../v1/voice/speech/route");
const app = new Hono().route("/api/v1/voice/speech", speechRoute);

const sessions = {
  getByName: () => ({
    fetch: async (url: string, init: RequestInit) => {
      expect(url).toBe("https://speech-relay.internal/initialize");
      const body = JSON.parse(String(init.body));
      expect(body.caller.user).toEqual({ id: USER, organization_id: ORG });
      order.push("initialize-start");
      await new Promise<void>((resolve) => {
        releaseInitialize = resolve;
      });
      order.push("initialize-end");
      return Response.json({ initialized: true });
    },
  }),
};
const mint = () =>
  app.request(
    "/api/v1/voice/speech/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentNonce: NONCE }),
    },
    { VOICE_SPEECH_RELAY_ENABLED: "true", SPEECH_RELAY_SESSIONS: sessions },
  );
async function settle(pending: Promise<Response>) {
  // Both remote waits start before either is allowed to finish.
  for (let n = 0; n < 50 && order.length < 2; n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(order.slice(0, 2).sort()).toEqual([
    "consume-start",
    "initialize-start",
  ]);
  releaseInitialize();
  releaseConsume();
  return pending;
}

beforeEach(() => {
  consented = true;
  order = [];
});

test("consent consume and the session ledger write overlap, each with its own timing", async () => {
  const response = await settle(mint());
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "expiresAt",
    "sessionId",
    "token",
    "version",
    "wsUrl",
  ]);
  const timing = response.headers.get("server-timing") ?? "";
  for (const phase of [
    "speech_identity_rate",
    "speech_consent_consume",
    "speech_session_init",
  ])
    expect(timing).toMatch(new RegExp(`${phase};dur=[0-9.]+`));
  expect(timing).not.toContain(NONCE);
  expect(timing).not.toContain(String(body.token));
});

test("a refused consent never returns the capability for the ledger already written", async () => {
  consented = false;
  const response = await settle(mint());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "speech_consent_required" });
});

test("consent issue reports identity and write phases", async () => {
  const response = await app.request(
    "/api/v1/voice/speech/consent",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    { VOICE_SPEECH_RELAY_ENABLED: "true", SPEECH_RELAY_SESSIONS: sessions },
  );
  expect(response.status).toBe(200);
  const timing = response.headers.get("server-timing") ?? "";
  expect(timing).toMatch(/speech_identity_rate;dur=[0-9.]+/);
  expect(timing).toMatch(/speech_consent_write;dur=[0-9.]+/);
});
