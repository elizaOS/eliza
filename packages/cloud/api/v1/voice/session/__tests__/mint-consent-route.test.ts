/**
 * Mint route: flag gate, SEC-21 consent precondition, pcm16-only advertisement,
 * and revoke honesty. Auth + consent store are mocked; the mint/consent logic
 * (jwt sign, nonce consume) is real.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const fakeLogger = {
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
};
mock.module("@/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: unknown) => a,
}));
// Auth: return a fixed authed user.
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
// Tenancy repos: the caller owns agent-1; conversation is new (not found).
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: async (id: string, org: string) =>
      id === "11111111-1111-4111-8111-111111111111" && org === "org-1"
        ? { id, organization_id: org, user_id: "user-1" }
        : undefined,
  },
}));
mock.module("@/db/repositories/conversations", () => ({
  conversationsRepository: {
    findById: async () => undefined,
  },
}));
// Consent store + jwt directory: in-memory fake so the real mint runs.
const consentNonces = new Set<string>();
mock.module("@/lib/voice-session/consent-nonce", () => ({
  isConsentStoreConfigured: () => true,
  issueConsentNonce: async () => {
    const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
    consentNonces.add(nonce);
    return { nonce, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  },
  consumeConsentNonce: async (_userId: string, nonce: string) => {
    if (consentNonces.has(nonce)) {
      consentNonces.delete(nonce);
      return true;
    }
    return false;
  },
}));

import { installVoiceSessionTestSigningKey } from "../../../../../shared/src/lib/voice-session/test-signing";

const { default: mintRoute } = await import("../route");
const { default: consentRoute } = await import("../consent/route");

beforeAll(async () => {
  await installVoiceSessionTestSigningKey();
});

function appWithFlag(flag: string | undefined) {
  const app = new Hono();
  const env = { VOICE_REALTIME_WS_ENABLED: flag };
  app.use("*", async (c, next) => {
    // Inject env into the hono context the routes read via c.env.
    (c as unknown as { env: unknown }).env = env;
    await next();
  });
  app.route("/api/v1/voice/session/consent", consentRoute);
  app.route("/api/v1/voice/session", mintRoute);
  return app;
}

describe("voice-session mint route", () => {
  test("returns 404 when the flag is off (client falls back to batch)", async () => {
    const app = appWithFlag(undefined);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a",
        conversationId: "c",
        consentNonce: "x",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("refuses to mint an agent the caller does not own", async () => {
    const app = appWithFlag("true");
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: "33333333-3333-4333-8333-333333333333",
        conversationId: "22222222-2222-4222-8222-222222222222",
        consentNonce: "x",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("agent_not_found");
  });

  test("refuses to mint without a valid consent nonce (SEC-21)", async () => {
    const app = appWithFlag("true");
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        consentNonce: "bogus",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("consent_required");
  });

  test("issues a nonce then mints a pcm16-only session", async () => {
    const app = appWithFlag("true");
    // 1. Get a consent nonce.
    const consentRes = await app.request("/api/v1/voice/session/consent", {
      method: "POST",
    });
    expect(consentRes.status).toBe(200);
    const { consentNonce } = (await consentRes.json()) as {
      consentNonce: string;
    };
    expect(consentNonce).toBeTruthy();

    // 2. Mint with it.
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        consentNonce,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      token: string;
      wsUrl: string;
      uplink: { codecs: string[] };
      downlink: { codecs: string[] };
    };
    expect(body.token.split(".").length).toBe(3);
    expect(body.wsUrl).toContain("/api/v1/voice/session/ws");
    // Phase 1: pcm16 ONLY, opus must NOT be advertised.
    expect(body.uplink.codecs).toEqual(["pcm16"]);
    expect(body.downlink.codecs).toEqual(["pcm16"]);

    // 3. The nonce is single-use: minting again with it is refused.
    const replay = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        consentNonce,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(replay.status).toBe(403);
  });

  test("mint response never contains a provider key", async () => {
    const app = appWithFlag("true");
    const consentRes = await app.request("/api/v1/voice/session/consent", {
      method: "POST",
    });
    const { consentNonce } = (await consentRes.json()) as {
      consentNonce: string;
    };
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        consentNonce,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const raw = await res.text();
    expect(raw.toLowerCase()).not.toContain("deepgram");
    expect(raw.toLowerCase()).not.toContain("cartesia");
    expect(raw).not.toContain("Token ");
  });
});
