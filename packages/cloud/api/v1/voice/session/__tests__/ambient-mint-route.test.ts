/**
 * Ambient mint branch (AMBIENT-MODE-DESIGN §1.1): consent precondition (SEC-21)
 * enforced doubly, pendant-session create/bind + first-lease acquire, ambient
 * response shape (empty downlink, pendantSessionId + captureLeaseToken, cloud
 * processing-location), and resume owner-scope check (SEC-8). Auth/consent/store
 * are mocked; the mint + ambient-branch logic (jwt sign with ambient claims,
 * provisioner orchestration, response shaping) is real.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const fakeLogger = { logger: { error: mock(), info: mock(), warn: mock(), debug: mock() } };
mock.module("@/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: unknown) => a,
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({ id: "user-1", organization_id: "org-1" }),
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: async (id: string, org: string) =>
      id === "11111111-1111-4111-8111-111111111111" && org === "org-1"
        ? { id, organization_id: org, user_id: "user-1" }
        : undefined,
  },
}));
mock.module("@/db/repositories/conversations", () => ({
  conversationsRepository: { findById: async () => undefined },
}));
const consentNonces = new Set<string>();
mock.module("@/lib/voice-session/consent-nonce", () => ({
  isConsentStoreConfigured: () => true,
  issueConsentNonce: async () => {
    const nonce = "nonce-" + Math.random().toString(36).slice(2);
    consentNonces.add(nonce);
    return { nonce, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  },
  consumeConsentNonce: async (_u: string, nonce: string) => {
    if (consentNonces.has(nonce)) {
      consentNonces.delete(nonce);
      return true;
    }
    return false;
  },
}));

// Fake pendant store client: records create/lease/exists calls.
const storeState = {
  createCalls: 0,
  leaseCalls: 0,
  existsReturns: true,
  lastLeaseHolder: "",
  leaseThrows: false,
};
mock.module("@/lib/voice-session/pendant-store-client", () => {
  class AmbientStoreError extends Error {
    constructor(msg: string, public code: string, public status?: number) {
      super(msg);
    }
  }
  return {
    AmbientStoreError,
    createHttpPendantSegmentStore: () => ({
      async createSession(_loc: string) {
        storeState.createCalls++;
        return { pendantSessionId: "pendant-created-1" };
      },
      async sessionExists(_id: string) {
        return storeState.existsReturns;
      },
      async acquireLease(_p: string, holder: string, leaseMs: number) {
        storeState.leaseCalls++;
        storeState.lastLeaseHolder = holder;
        if (storeState.leaseThrows) throw new AmbientStoreError("held", "lease_conflict", 409);
        return {
          leaseToken: "lease-plain-1",
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        };
      },
    }),
  };
});

import { installVoiceSessionTestSigningKey } from "../../../../../shared/src/lib/voice-session/test-signing";
const { default: mintRoute } = await import("../route");
const { default: consentRoute } = await import("../consent/route");

beforeAll(async () => {
  await installVoiceSessionTestSigningKey();
});

const AGENT = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

function appWithEnv(env: Record<string, string | undefined>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { env: unknown }).env = env;
    await next();
  });
  app.route("/api/v1/voice/session/consent", consentRoute);
  app.route("/api/v1/voice/session", mintRoute);
  return app;
}

const AMBIENT_ENV = {
  VOICE_REALTIME_WS_ENABLED: "true",
  VOICE_AMBIENT_ENABLED: "true",
  VOICE_AMBIENT_PENDANT_BASE_URL: "http://agent.local",
  VOICE_AMBIENT_PENDANT_AUTHORIZATION: "Bearer server-held",
};

async function getNonce(app: ReturnType<typeof appWithEnv>): Promise<string> {
  const res = await app.request("/api/v1/voice/session/consent", { method: "POST" });
  const { consentNonce } = (await res.json()) as { consentNonce: string };
  return consentNonce;
}

describe("ambient mint route", () => {
  test("404 when ambient is not enabled (realtime on, ambient off)", async () => {
    const app = appWithEnv({ VOICE_REALTIME_WS_ENABLED: "true" });
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({ agentId: AGENT, conversationId: CONV, mode: "ambient", consentNonce: nonce }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("ambient_disabled");
  });

  test("403 when consent nonce is missing (SEC-21 doubly enforced for ambient)", async () => {
    const app = appWithEnv(AMBIENT_ENV);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({ agentId: AGENT, conversationId: CONV, mode: "ambient", consentNonce: "bogus" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("consent_required");
  });

  test("new ambient session: creates pendant session, acquires lease, returns ambient response", async () => {
    storeState.createCalls = 0;
    storeState.leaseCalls = 0;
    const app = appWithEnv(AMBIENT_ENV);
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({ agentId: AGENT, conversationId: CONV, mode: "ambient", consentNonce: nonce }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      pendantSessionId: string;
      captureLeaseToken: string;
      leaseExpiresAt: string;
      uplink: { codecs: string[] };
      downlink: { codecs: string[] };
      processingLocation: string;
      token: string;
    };
    expect(storeState.createCalls).toBe(1);
    expect(storeState.leaseCalls).toBe(1);
    expect(body.mode).toBe("ambient");
    expect(body.pendantSessionId).toBe("pendant-created-1");
    expect(body.captureLeaseToken).toBe("lease-plain-1");
    // AMBIENT: empty downlink by contract.
    expect(body.downlink.codecs).toEqual([]);
    expect(body.uplink.codecs).toEqual(["pcm16"]);
    // Honest processing-location.
    expect(body.processingLocation).toBe("cloud");
    // The token is an ambient token (carries the pendant + mode claims).
    const { verifyVoiceSessionToken } = await import(
      "../../../../../shared/src/lib/voice-session/jwt"
    );
    const verified = await verifyVoiceSessionToken(body.token);
    expect(verified.claims.mode).toBe("ambient");
    expect(verified.claims.pendantSessionId).toBe("pendant-created-1");
  });

  test("mint response never leaks the lease tokenDigest or a provider key", async () => {
    const app = appWithEnv(AMBIENT_ENV);
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({ agentId: AGENT, conversationId: CONV, mode: "ambient", consentNonce: nonce }),
      headers: { "Content-Type": "application/json" },
    });
    const raw = (await res.text()).toLowerCase();
    expect(raw).not.toContain("deepgram");
    expect(raw).not.toContain("cartesia");
    expect(raw).not.toContain("tokendigest");
  });

  test("resume: an owned pendantSessionId re-binds without creating a new session", async () => {
    storeState.createCalls = 0;
    storeState.existsReturns = true;
    const app = appWithEnv(AMBIENT_ENV);
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: AGENT,
        conversationId: CONV,
        mode: "ambient",
        pendantSessionId: "pendant-existing",
        consentNonce: nonce,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pendantSessionId: string };
    expect(storeState.createCalls).toBe(0); // did NOT create.
    expect(body.pendantSessionId).toBe("pendant-existing");
  });

  test("resume: a pendantSessionId the owner does not own is 404 (SEC-8)", async () => {
    storeState.existsReturns = false;
    const app = appWithEnv(AMBIENT_ENV);
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: AGENT,
        conversationId: CONV,
        mode: "ambient",
        pendantSessionId: "pendant-not-owned",
        consentNonce: nonce,
      }),
      headers: { "Content-Type": "application/json" },
    });
    storeState.existsReturns = true;
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("pendant_session_not_found");
  });

  test("a conversation mint carrying pendantSessionId is rejected", async () => {
    const app = appWithEnv(AMBIENT_ENV);
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({
        agentId: AGENT,
        conversationId: CONV,
        pendantSessionId: "x",
        consentNonce: nonce,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_mode_binding");
  });

  test("409 when the first lease is already held", async () => {
    storeState.leaseThrows = true;
    const app = appWithEnv(AMBIENT_ENV);
    const nonce = await getNonce(app);
    const res = await app.request("/api/v1/voice/session", {
      method: "POST",
      body: JSON.stringify({ agentId: AGENT, conversationId: CONV, mode: "ambient", consentNonce: nonce }),
      headers: { "Content-Type": "application/json" },
    });
    storeState.leaseThrows = false;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("lease_conflict");
  });
});
