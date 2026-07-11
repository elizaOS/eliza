import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const calls: string[] = [];

class FakeSocket {
  addEventListener() {}
  close() {}
  on() {}
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
    consumeConsentNonce: async () => true,
  }));
  mock.module("@/lib/voice-session/jwt", () => ({
    claimVoiceSessionToken: async () => true,
    isVoiceSessionTokenRevoked: async () => false,
    mintVoiceSessionToken: async () => ({
      token: "signed-token",
      jti: "jti",
      expSeconds: 123,
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
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
          conversationId: "conversation",
        },
        jti: "jti",
        tokenExpSeconds: 123,
        downlink: {},
      });
    },
  }));
  mock.module("../lib/session", () => ({
    VoiceSession: class {
      constructor(options: {
        deepgramWebSocketFactory(request: {
          url: string;
          headers: Record<string, string>;
        }): { addEventListener(type: string, listener: () => void): void };
        cartesiaWebSocketFactory(
          url: string,
          options: { headers: Record<string, string> },
        ): { addEventListener(type: string, listener: () => void): void };
      }) {
        const dg = options.deepgramWebSocketFactory({
          url: "ws://127.0.0.1:1/provider?channels=1",
          headers: { Authorization: "Token test" },
        });
        dg.addEventListener("error", () => undefined);
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
        deepgramApiKey: "dg",
        cartesiaApiKey: "cartesia",
        cartesiaVoiceId: "voice",
        elizaEndpoint: "http://127.0.0.1/eliza",
        elizaAuthorization: "Bearer test",
        organizationId: "org",
        userId: "user",
        agentId: "agent",
        conversationId: "conversation",
        hooks: { log: (_level, message) => logs.push(message) },
      });

      const httpUrl = server.wsUrl
        .replace("ws://", "http://")
        .split("/api/")[0];
      const response = await fetch(httpUrl);
      expect(response.status).toBe(426);
      expect(await response.text()).toBe("expected a websocket upgrade");

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
  });
}
