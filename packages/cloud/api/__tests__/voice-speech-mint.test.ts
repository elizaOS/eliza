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
  CONSENT_NONCE_TTL_SECONDS: 300,
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

let touched: { name: string; path: string }[] = [];
const sessions = {
  getByName: (name: string) => ({
    fetch: async (url: string, init: RequestInit) => {
      touched.push({ name, path: new URL(url).pathname });
      if (url === "https://speech-relay.internal/warm")
        return new Response(null, { status: 200 });
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
  touched = [];
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

test("the hosting probe is staging only and reports each script's first touch", async () => {
  const stub = { fetch: async () => new Response(null, { status: 404 }) };
  const namespaces = {
    INFERENCE_ADMISSION_GATES: { getByName: () => stub },
    SPEECH_RELAY_SESSIONS: { getByName: () => stub },
  };
  const probe = (overrides: Record<string, unknown>) =>
    app.request(
      "/api/v1/voice/speech/hosting-probe?first=lean",
      { method: "POST" },
      env({ ...namespaces, ...overrides }),
    );
  expect((await probe({ ENVIRONMENT: "production" })).status).toBe(404);
  const staging = await probe({});
  expect(staging.status).toBe(200);
  expect(Object.keys((await staging.json()) as object).sort()).toEqual([
    "apiLiveMs",
    "apiNewMs",
    "leanLiveMs",
    "leanNewMs",
  ]);
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

test("consent warms the session object that the mint then initializes", async () => {
  const consent = await app.request(
    "/api/v1/voice/speech/consent",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    env(),
  );
  expect(consent.status).toBe(200);
  // The warm is not awaited by the route; let it dispatch.
  for (let n = 0; n < 50 && touched.length < 1; n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(touched).toHaveLength(1);
  expect(touched[0]!.path).toBe("/warm");
  const response = await settle(mint());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionId: string; wsUrl: string };
  expect(touched[1]).toEqual({ name: touched[0]!.name, path: "/initialize" });
  expect(body.sessionId).toBe(touched[0]!.name);
  expect(new URL(body.wsUrl).searchParams.get("sessionId")).toBe(
    body.sessionId,
  );
});

test("a consent session name is a UUID bound to its user and nonce", async () => {
  const { speechSessionIdForConsent } = await import(
    "../src/speech-relay-coordinator"
  );
  const id = speechSessionIdForConsent(USER, NONCE);
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(speechSessionIdForConsent(USER, NONCE)).toBe(id);
  expect(speechSessionIdForConsent(ORG, NONCE)).not.toBe(id);
  expect(
    speechSessionIdForConsent(USER, "44444444-4444-4444-8444-444444444444"),
  ).not.toBe(id);
  expect(id).not.toContain(NONCE.slice(0, 8));
});

test("prepared consent names remain compatible with existing speech clients", async () => {
  const { preparedSpeechSessionIdForConsent } = await import(
    "../src/speech-relay-coordinator"
  );
  const id = preparedSpeechSessionIdForConsent(USER, NONCE);
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(preparedSpeechSessionIdForConsent(USER, NONCE)).toBe(id);
  expect(preparedSpeechSessionIdForConsent(ORG, NONCE)).not.toBe(id);
});
