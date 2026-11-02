/**
 * POST /api/v1/voice/speech/session runs its consent consume and Durable
 * Object ledger write concurrently, reports each phase in Server-Timing on
 * staging only, and offers session renewal in a header, never in the body.
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
const env = (overrides: Record<string, unknown> = {}) => ({
  VOICE_SPEECH_RELAY_ENABLED: "true",
  SPEECH_RELAY_SESSIONS: sessions,
  ENVIRONMENT: "staging",
  ...overrides,
});
const mint = async (overrides: Record<string, unknown> = {}) =>
  app.request(
    "/api/v1/voice/speech/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentNonce: NONCE }),
    },
    env(overrides),
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
    "speech_directory_write",
  ])
    expect(timing).toMatch(new RegExp(`${phase};dur=[0-9.]+`));
  expect(timing).not.toContain(NONCE);
  expect(timing).not.toContain(String(body.token));
  expect(response.headers.get("X-Eliza-Speech-Extend")).toBe("1");
});

test("production reports no phases; a single-window deployment offers no renewal", async () => {
  const response = await settle(
    mint({ ENVIRONMENT: "production", VOICE_SPEECH_RELAY_MAX_WINDOWS: "1" }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("server-timing")).toBeNull();
  expect(response.headers.has("X-Eliza-Speech-Extend")).toBe(false);
});

test("an invalid window bound disables renewal instead of refusing speech", async () => {
  for (const bound of ["0", "121", "2.5", "1e1", "ten"]) {
    order = [];
    const response = await settle(
      mint({ VOICE_SPEECH_RELAY_MAX_WINDOWS: bound }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("X-Eliza-Speech-Extend")).toBe(false);
  }
});

test("a refused consent never returns the capability for the ledger already written", async () => {
  consented = false;
  const response = await settle(mint());
  expect(response.status).toBe(403);
  const body: unknown = await response.json();
  expect(body).toEqual({ error: "speech_consent_required" });
  expect(response.headers.has("X-Eliza-Speech-Extend")).toBe(false);
});

test("consent issue reports identity and write phases", async () => {
  const response = await app.request(
    "/api/v1/voice/speech/consent",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    env(),
  );
  expect(response.status).toBe(200);
  const timing = response.headers.get("server-timing") ?? "";
  expect(timing).toMatch(/speech_identity_rate;dur=[0-9.]+/);
  expect(timing).toMatch(/speech_consent_write;dur=[0-9.]+/);
});

test("the window bound is an integer 1-120 and defaults to 10", async () => {
  const { resolveSpeechRelayMaxWindows } = await import(
    "../src/speech-relay-coordinator"
  );
  expect(resolveSpeechRelayMaxWindows(undefined)).toBe(10);
  expect(resolveSpeechRelayMaxWindows(" ")).toBe(10);
  expect(resolveSpeechRelayMaxWindows("1")).toBe(1);
  expect(resolveSpeechRelayMaxWindows(" 120 ")).toBe(120);
  for (const bound of ["0", "121", "-1", "2.5", "1e1", "0x10", "ten"])
    expect(() => resolveSpeechRelayMaxWindows(bound)).toThrow();
});
