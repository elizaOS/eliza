/**
 * Integration-backed tests for the loopback real-voice harness transport,
 * session mint scope, provider seams, and shutdown behavior. Provider sockets
 * are deterministic mocks while the HTTP and WebSocket servers are real.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const calls: string[] = [];
const CONVERSATION_ID = "legacy-channel";
const fakeSockets: FakeSocket[] = [];

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    fakeSockets.push(this);
  }
  addEventListener() {}
  close() {}
  send() {}
}

if (process.env.ELIZA_PROCESS_ISOLATED_TEST === "1") {
  mock.module("ws", () => ({
    default: FakeSocket,
    WebSocket: FakeSocket,
    WebSocketServer: class {
      clients = new Set<FakeSocket>();
      close(callback: () => void) {
        callback();
      }
      handleUpgrade(
        _request: unknown,
        _socket: unknown,
        _head: unknown,
        callback: (socket: FakeSocket) => void,
      ) {
        callback(new FakeSocket());
      }
    },
  }));

  mock.module("@/lib/cache/redis-factory", () => ({
    buildRedisClient: () => ({ eval() {} }),
  }));
  mock.module("@/lib/services/voice-usage-meter", () => ({
    createDurableVoiceUsageStore: () => ({ durable: true }),
    InMemoryVoiceUsageStore: class {},
  }));
  mock.module("@/lib/voice-session/config", () => ({
    resolveElizaModel: () => "test-model",
    resolveMaxSessions: () => 2,
    resolveVoiceUsageLimits: () => ({}),
  }));
  mock.module("@/lib/voice-session/consent-nonce", () => ({
    issueConsentNonce: async () => ({ nonce: "consent" }),
    consumeConsentNonce: async () => {
      calls.push("consumed");
      return true;
    },
  }));
  const revokedChecks: string[] = [];
  mock.module("@/lib/voice-session/jwt", () => ({
    claimVoiceSessionToken: async () => true,
    isVoiceSessionTokenRevoked: async (jti: string) => {
      revokedChecks.push(jti);
      return false;
    },
    mintVoiceSessionToken: async () => {
      calls.push("minted-token");
      return {
        token: "signed-token",
        jti: "jti",
        expSeconds: 123,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
    recordVoiceSessionJti: async () => calls.push("recorded"),
    revokeVoiceSessionToken: async () => undefined,
  }));
  mock.module("@/lib/voice-session/session-registry", () => ({
    __resetVoiceSessionRegistryForTests: () => calls.push("reset"),
    getVoiceSessionRegistry: () => ({ size: () => 0 }),
  }));
  mock.module("@/lib/voice-session/test-signing", () => ({
    installVoiceSessionTestSigningKey: async () => calls.push("signing"),
  }));
  mock.module("@/lib/voice-session/ws-handler", () => ({
    attachVoiceWsHandler: (
      _socket: unknown,
      options: {
        buildSession(input: {
          claims: Record<string, string>;
          jti: string;
          tokenExpSeconds: number;
          downlink: object;
        }): unknown;
      },
    ) => {
      calls.push("attached");
      options.buildSession({
        claims: {
          sessionId: "session",
          organizationId: "org",
          userId: "user",
          agentId: "agent",
          conversationId: CONVERSATION_ID,
        },
        jti: "jti",
        tokenExpSeconds: 123,
        downlink: {},
      });
    },
  }));
  let lastSessionOptions: {
    isRevoked?: (jti: string) => Promise<boolean>;
    onTeardownRevoke?: unknown;
    fetchImpl?: typeof fetch;
  } | null = null;
  mock.module("../lib/session", () => ({
    VoiceSession: class {
      constructor(options: {
        isRevoked?: (jti: string) => Promise<boolean>;
        onTeardownRevoke?: unknown;
        fetchImpl?: typeof fetch;
        cartesiaInkWebSocketFactory(request: {
          url: string;
          headers: Record<string, string>;
        }): { addEventListener(type: string, listener: () => void): void };
        cartesiaWebSocketFactory(
          url: string,
          options: { headers: Record<string, string> },
        ): { addEventListener(type: string, listener: () => void): void };
      }) {
        lastSessionOptions = options;
        const ink = options.cartesiaInkWebSocketFactory({
          url: "ws://127.0.0.1:1/provider",
          headers: { "X-API-Key": "test" },
        });
        ink.addEventListener("error", () => undefined);
        const cartesia = options.cartesiaWebSocketFactory(
          "ws://127.0.0.1:1/provider",
          {
            headers: { "X-API-Key": "test" },
          },
        );
        cartesia.addEventListener("error", () => undefined);
      }
    },
  }));

  let harness: typeof import("../lib/harness-real-server");

  beforeAll(async () => {
    harness = await import("../lib/harness-real-server");
  });

  afterAll(() => {
    mock.restore();
  });

  describe("harness real server", () => {
    test("installs signing, starts, mints, serves HTTP fallback, and stops", async () => {
      await harness.installHarnessSigningKey();
      const logs: string[] = [];
      const server = await harness.startRealVoiceServer({
        cartesiaApiKey: "cartesia",
        cartesiaVoiceId: "voice",
        elizaEndpoint: "http://127.0.0.1/eliza",
        elizaAuthorization: "Bearer test",
        organizationId: "org",
        userId: "user",
        agentId: "agent",
        conversationId: CONVERSATION_ID,
        fetchImpl: fetch,
        hooks: { log: (_level, message) => logs.push(message) },
      });

      const response = await fetch(server.httpUrl);
      expect(response.status).toBe(426);
      expect(await response.text()).toBe("expected a websocket upgrade");

      const health = await fetch(
        `${server.httpUrl}/api/v1/voice/session/health`,
      );
      expect(health.status).toBe(200);
      expect((await health.json()) as unknown).toEqual({ ready: true });

      const consent = await fetch(
        `${server.httpUrl}/api/v1/voice/session/consent`,
        { method: "POST" },
      );
      expect(consent.status).toBe(200);
      const consentBody = (await consent.json()) as { consentNonce: string };
      expect(consentBody.consentNonce).toBe("consent");

      const mismatchedMint = await fetch(
        `${server.httpUrl}/api/v1/voice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: "other-legacy-channel",
            consentNonce: consentBody.consentNonce,
            transport: "websocket",
          }),
        },
      );
      expect(mismatchedMint.status).toBe(403);
      expect((await mismatchedMint.json()) as unknown).toEqual({
        code: "conversation_scope_mismatch",
      });
      expect(calls).not.toContain("recorded");

      const browserMint = await fetch(
        `${server.httpUrl}/api/v1/voice/session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-Host": "localhost:2138",
            "X-Forwarded-Proto": "http",
          },
          body: JSON.stringify({
            agentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            conversationId: CONVERSATION_ID,
            consentNonce: consentBody.consentNonce,
            transport: "websocket",
          }),
        },
      );
      expect(browserMint.status).toBe(200);
      const browserMintBody = (await browserMint.json()) as {
        sessionId: string;
        wsUrl: string;
      };
      expect(browserMintBody).toMatchObject({
        token: "signed-token",
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
      });
      const publicWsUrl = new URL(browserMintBody.wsUrl);
      expect(publicWsUrl.origin).toBe("ws://localhost:2138");
      expect(publicWsUrl.pathname).toBe("/api/v1/voice/session/ws");
      expect(publicWsUrl.searchParams.get("sessionId")).toBe(
        browserMintBody.sessionId,
      );

      await new Promise<void>((resolve, reject) => {
        const url = new URL(`${server.wsUrl}session`);
        const socket = connect(Number(url.port), url.hostname, () => {
          socket.write(
            `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          );
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 10);
        });
        socket.once("error", reject);
      });

      // Production-parity wiring (#16663/#16667): the harness session carries
      // NO teardown revoke (production dropped it in #16636) so evidence runs
      // certify production behavior, and its revocation poll is wired through
      // the real jwt module.
      expect(lastSessionOptions).not.toBeNull();
      const providerSockets = fakeSockets.filter(
        (socket) => socket.listenerCount("error") >= 2,
      );
      expect(providerSockets).toHaveLength(2);
      for (const socket of providerSockets) {
        // Simulate a completed provider context detaching its own mapped error
        // listener while the shared transport remains open. The permanent DOM
        // compatibility sink must keep a later Node `error` event non-fatal.
        const mappedListener = socket.listeners("error").at(-1);
        expect(mappedListener).toBeDefined();
        if (mappedListener) socket.off("error", mappedListener);
        expect(() =>
          socket.emit("error", new Error("late provider error")),
        ).not.toThrow();
      }
      expect(lastSessionOptions?.fetchImpl).toBe(fetch);
      expect(
        lastSessionOptions && "onTeardownRevoke" in lastSessionOptions
          ? lastSessionOptions.onTeardownRevoke
          : undefined,
      ).toBeUndefined();
      await lastSessionOptions?.isRevoked?.("jti-parity");
      expect(revokedChecks).toContain("jti-parity");

      const minted = await server.mint();
      expect(minted.token).toBe("signed-token");
      expect(minted.sessionId).toBeTruthy();
      expect(calls).toContain("signing");
      expect(calls).toContain("recorded");
      expect(logs).toContain("real voice server listening");
      expect(logs).toContain("minted real voice-session token");

      await server.stop();
      expect(calls.filter((call) => call === "reset")).toHaveLength(2);
    });

    test("authorizes a newly selected local-runtime conversation before mint", async () => {
      await harness.installHarnessSigningKey();
      const requestedConversationIds: string[] = [];
      const server = await harness.startRealVoiceServer({
        cartesiaApiKey: "cartesia",
        cartesiaVoiceId: "voice",
        elizaEndpoint: "http://127.0.0.1/eliza",
        elizaAuthorization: "Bearer test",
        organizationId: "org",
        userId: "user",
        agentId: "agent",
        conversationId: CONVERSATION_ID,
        authorizeConversationId: async (conversationId) => {
          requestedConversationIds.push(conversationId);
          if (conversationId === "throwing-local-conversation") {
            throw new Error("runtime unavailable");
          }
          return conversationId === "new-local-conversation"
            ? "authorized"
            : "forbidden";
        },
        fetchImpl: fetch,
        hooks: { log: () => undefined },
      });

      try {
        const protectedCallCounts = () => ({
          consumed: calls.filter((call) => call === "consumed").length,
          minted: calls.filter((call) => call === "minted-token").length,
          recorded: calls.filter((call) => call === "recorded").length,
        });
        const beforeInvalidRequests = protectedCallCounts();
        for (const [conversationId, expectedStatus] of [
          ["denied-local-conversation", 403],
          ["throwing-local-conversation", 503],
        ] as const) {
          const deniedConsent = await fetch(
            `${server.httpUrl}/api/v1/voice/session/consent`,
            { method: "POST" },
          );
          const deniedConsentBody = (await deniedConsent.json()) as {
            consentNonce: string;
          };
          const denied = await fetch(`${server.httpUrl}/api/v1/voice/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              consentNonce: deniedConsentBody.consentNonce,
              transport: "websocket",
            }),
          });
          expect(denied.status).toBe(expectedStatus);
          expect((await denied.json()) as { code: string }).toEqual({
            code:
              expectedStatus === 403
                ? "conversation_scope_mismatch"
                : "conversation_authorization_unavailable",
          });
        }

        const invalidTransportConsent = await fetch(
          `${server.httpUrl}/api/v1/voice/session/consent`,
          { method: "POST" },
        );
        const invalidTransportNonce =
          (await invalidTransportConsent.json()) as {
            consentNonce: string;
          };
        const invalidTransport = await fetch(
          `${server.httpUrl}/api/v1/voice/session`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: "transport-probe-conversation",
              consentNonce: invalidTransportNonce.consentNonce,
              transport: "webrtc",
            }),
          },
        );
        expect(invalidTransport.status).toBe(400);
        expect(requestedConversationIds).not.toContain(
          "transport-probe-conversation",
        );
        expect(protectedCallCounts()).toEqual(beforeInvalidRequests);

        const consent = await fetch(
          `${server.httpUrl}/api/v1/voice/session/consent`,
          { method: "POST" },
        );
        const { consentNonce } = (await consent.json()) as {
          consentNonce: string;
        };
        const allowed = await fetch(`${server.httpUrl}/api/v1/voice/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: "new-local-conversation",
            consentNonce,
            transport: "websocket",
          }),
        });
        expect(allowed.status).toBe(200);
        expect(requestedConversationIds).toEqual([
          "denied-local-conversation",
          "throwing-local-conversation",
          "new-local-conversation",
        ]);
      } finally {
        await server.stop();
      }
    });
  });
} else {
  test("runs the harness assertions in a fresh Bun process", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url), "--timeout", "120000"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, ELIZA_PROCESS_ISOLATED_TEST: "1" },
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `isolated harness failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
    }
  }, 120_000);
}
