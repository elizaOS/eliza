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
  const revokedChecks: string[] = [];
  mock.module("@/lib/voice-session/jwt", () => ({
    claimVoiceSessionToken: async () => true,
    isVoiceSessionTokenRevoked: async (jti: string) => {
      revokedChecks.push(jti);
      return false;
    },
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
        conversationId: "conversation",
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
            conversationId: "11111111-1111-4111-8111-111111111111",
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
  });
} else {
  test("runs the harness assertions in a fresh Bun process", () => {
    // SEC-21: auth isolation for CI logs. Spawn with a minimal env:
    // keep only PATH (for process.execPath lookup), NODE_OPTIONS/BUN_* (runtime),
    // and CI markers. Redact all API keys, tokens, and credentials.
    const allowedEnvKeys = new Set([
      "PATH",
      "NODE_OPTIONS",
      "BUN_WORKDIR",
      "BUN_RUNTIME",
      "CI",
      "GITHUB_ACTIONS",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_NUMBER",
      "GITHUB_WORKFLOW",
      "GITHUB_JOB",
      "GITHUB_REF",
      "GITHUB_SHA",
      "HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "PWD",
    ]);
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (allowedEnvKeys.has(key) && typeof value === "string") {
        cleanEnv[key] = value;
      }
    }
    cleanEnv.ELIZA_PROCESS_ISOLATED_TEST = "1";

    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url), "--timeout", "120000"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: cleanEnv,
      },
    );
    if (result.status !== 0) {
      // Diagnostic output: include cleaned status and stdout/stderr WITHOUT
      // credentials (cleanEnv ensures no leaks from the subprocess).
      const diagnostics = [
        `isolated harness failed (exit ${result.status ?? "unknown"})`,
        result.stdout ? `stdout:\n${result.stdout}` : undefined,
        result.stderr ? `stderr:\n${result.stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      throw new Error(diagnostics);
    }
  });
}
