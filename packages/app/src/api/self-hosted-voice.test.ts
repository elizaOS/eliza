import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRuntime, logger, type UUID } from "@elizaos/core";
import {
  CloudSpeechRelayClientError,
  createCloudSpeechRelayPorts,
} from "@elizaos/host/voice/cloud-speech-relay-client";
import { createLocalRuntimeConversationFetch } from "@elizaos/host/voice/local-runtime-conversation-fetch";
import {
  VoiceSession,
  type VoiceSessionConfig,
} from "@elizaos/host/voice/session";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { cartesiaEvents } from "../../test/fixtures/cartesia-events";
import { listenLoopbackWebSocket } from "../../test/fixtures/loopback-server.ts";
import type { AuthRepository } from "../services/auth-repository";
import { authStoreForRuntime } from "../services/auth-store";
import { resolveAuthorizedRouteRole } from "./auth";
import { closeSessionSockets } from "./auth/session-sockets";
import {
  CSRF_HEADER_NAME,
  deriveCsrfToken,
  SESSION_COOKIE_NAME,
} from "./auth/sessions";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  createSelfHostedVoice,
  type SelfHostedVoiceOptions,
} from "./self-hosted-voice";

const agentId = randomUUID() as UUID;
const conversationId = randomUUID();
let directory: string, adapter: SQLiteDatabaseAdapter, store: AuthRepository;
let server: Server, origin: string, state: CompatRuntimeState;
let host: ReturnType<typeof createSelfHostedVoice>;
let sessions: VoiceSessionConfig[];
let hostOptions: SelfHostedVoiceOptions;
let streamReply: string;
let upstreamRequests: Array<{ url: string; headers: Record<string, unknown> }>;
let clock: number;
const ownerSession = "private-owner-session";

beforeEach(async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_ENABLED", "1");
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "");
  vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "");
  streamReply = "data: [DONE]\n\n";
  vi.stubEnv("CARTESIA_API_KEY", "private-provider-test-key");
  vi.stubEnv("CARTESIA_API_KEY_FILE", "");
  vi.stubEnv("ELIZA_API_TOKEN", "static-admin-key");
  clock = Date.now();
  directory = await mkdtemp(join(tmpdir(), "self-hosted-voice-"));
  adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
  const runtime = {
    agentId,
    adapter,
    reportError: vi.fn(),
  } as unknown as AgentRuntime;
  const selectedStore = authStoreForRuntime(runtime);
  if (!selectedStore) throw new Error("Missing test auth store");
  store = selectedStore;
  for (const [id, kind] of [
    ["owner", "owner"],
    ["machine", "machine"],
    ["other-owner", "owner"],
  ] as const) {
    await store.createIdentity({ id, kind, displayName: id, createdAt: clock });
    await store.createSession({
      id: id === "owner" ? ownerSession : id,
      identityId: id,
      kind: "machine",
      createdAt: clock,
      lastSeenAt: clock,
      expiresAt: clock + 3600_000,
      rememberDevice: false,
      csrfSecret: "private-csrf-key",
      ip: null,
      userAgent: null,
      scopes: [],
    });
  }
  state = {
    current: runtime,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
  sessions = [];
  upstreamRequests = [];
  hostOptions = {
    now: () => clock,
    buildSession(config) {
      const registry = config.registry;
      if (!registry) throw new Error("Missing test voice registry");
      sessions.push(config);
      const session = {
        sessionId: config.sessionId,
        jti: config.jti,
        organizationId: config.organizationId,
        userId: config.userId,
        start() {
          registry.register(session);
          config.downlink.sendControl({
            t: "ready",
            sessionId: config.sessionId,
            traceId: config.sessionId,
          });
        },
        pushUplinkAudio() {},
        bargeIn() {},
        bye() {
          session.sever();
        },
        sever() {
          registry.unregister(config.sessionId);
          config.downlink.close(1000, "closed");
        },
      };
      return session;
    },
  };
  host = createSelfHostedVoice(state, hostOptions);
  server = createServer(async (req, res) => {
    if (req.url === "/api/conversations") {
      upstreamRequests.push({ url: req.url, headers: { ...req.headers } });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ conversations: [{ id: conversationId }] }));
    } else if (req.url?.includes("/messages/stream")) {
      upstreamRequests.push({ url: req.url, headers: { ...req.headers } });
      // This is the canonical app bridge's cookie/CSRF resolver. Disable local
      // trust so the loopback test cannot hide a broken LAN credential path.
      const auth = await resolveAuthorizedRouteRole(req, {
        state,
        allowTrustedLocalBypass: false,
      });
      if (!auth.ok || auth.role !== "OWNER" || auth.identityId !== "owner") {
        res.statusCode = 403;
        res.end();
        return;
      }
      res.end(streamReply);
    } else if (!(await host.handleRequest(req, res))) {
      res.statusCode = 404;
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    void host.handleUpgrade(req, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await host?.close();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await adapter?.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function request(path: string, body?: unknown, token = ownerSession) {
  return fetch(`${origin}/api/v1/voice/session${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function nonce(token = ownerSession) {
  return (await (await request("/consent", {}, token)).json())
    .consentNonce as string;
}
async function mint() {
  const response = await request("", {
    agentId,
    conversationId,
    transport: "websocket",
    turnTerminal: true,
    consentNonce: await nonce(),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    sessionId: string;
    token: string;
    wsUrl: string;
    expiresAt: number;
    leaseRenewal?: true;
  }>;
}
async function connect(
  ticket: Awaited<ReturnType<typeof mint>>,
  token = ticket.token,
  expectReady = true,
) {
  const ws = new WebSocket(ticket.wsUrl);
  await once(ws, "open");
  const message = once(ws, "message");
  ws.send(
    JSON.stringify({
      t: "hello",
      turnTerminal: true,
      token,
      ...(ticket.leaseRenewal ? { leaseRenewal: true } : {}),
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    }),
  );
  const frame = JSON.parse(String((await message)[0]));
  if (token === ticket.token && expectReady) expect(frame.t).toBe("ready");
  return { ws, frame };
}

it("requires a live owner session, including on loopback, and scopes health", async () => {
  expect(
    (await request(`/health?conversationId=${conversationId}`, undefined, ""))
      .status,
  ).toBe(401);
  expect(
    (
      await request(
        `/health?conversationId=${conversationId}`,
        undefined,
        "static-admin-key",
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await request(
        `/health?conversationId=${conversationId}`,
        undefined,
        "machine",
      )
    ).status,
  ).toBe(403);
  expect(
    await (await request(`/health?conversationId=${conversationId}`)).json(),
  ).toMatchObject({ ready: true, turnTerminal: true, agentId, conversationId });
  expect((await request(`/health?conversationId=${randomUUID()}`)).status).toBe(
    403,
  );
  expect(sessions).toHaveLength(0);
});

it("retains CSRF for cookie credentials and binds consent to its issuing session", async () => {
  const denied = await fetch(`${origin}/api/v1/voice/session/consent`, {
    method: "POST",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${ownerSession}` },
    body: "{}",
  });
  expect(denied.status).toBe(403);
  const consentNonce = await nonce();
  const body = {
    agentId,
    conversationId,
    transport: "websocket",
    turnTerminal: true,
    consentNonce,
  };
  expect((await request("", body, "other-owner")).status).toBe(403);
  expect((await request("", body)).status).toBe(200);
  expect((await request("", body)).status).toBe(403);
});

it("rejects mismatched agents and conversations before opening a provider", async () => {
  expect(
    (
      await request("", {
        agentId: randomUUID(),
        conversationId,
        transport: "websocket",
        turnTerminal: true,
        consentNonce: await nonce(),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("", {
        agentId,
        conversationId: randomUUID(),
        transport: "websocket",
        turnTerminal: true,
        consentNonce: await nonce(),
      })
    ).status,
  ).toBe(403);
  expect(sessions).toHaveLength(0);
});

it("requires the hello secret, claims it once, and preserves authenticated canonical streaming", async () => {
  const ticket = await mint();
  expect(JSON.stringify(ticket)).not.toContain("private-");
  const wrong = await connect(ticket, "wrong-token");
  expect(wrong.frame.code).toBe("invalid_token");
  expect(sessions).toHaveLength(0);
  wrong.ws.terminate();
  const { ws, frame } = await connect(ticket);
  expect(frame.t).toBe("ready");
  expect(sessions).toHaveLength(1);
  const config = sessions[0];
  if (!config.fetchImpl) throw new Error("Missing authenticated fetch");
  expect(config.userId).toBe("owner");
  expect(config.agentId).toBe(agentId);
  expect(config.conversationId).toBe(conversationId);
  expect(config.cartesiaApiKey).toBe("private-provider-test-key");
  const streamed = await config.fetchImpl(
    `${origin}/api/v1/eliza/agents/${agentId}/api/conversations/${conversationId}/messages/stream`,
    {
      method: "POST",
      body: JSON.stringify({
        text: "hello",
        turnTerminal: true,
        streamProtocol: "delta-v2",
        metadata: { clientTransport: "realtime_voice" },
      }),
    },
  );
  expect(streamed.status).toBe(200);
  expect(upstreamRequests.at(-1)?.url).toBe(
    `/api/conversations/${conversationId}/messages/stream`,
  );
  expect(upstreamRequests.at(-1)?.headers.cookie).toBe(
    `${SESSION_COOKIE_NAME}=${ownerSession}`,
  );
  expect(upstreamRequests.at(-1)?.headers[CSRF_HEADER_NAME.toLowerCase()]).toBe(
    deriveCsrfToken({ id: ownerSession, csrfSecret: "private-csrf-key" }),
  );
  const replay = new WebSocket(ticket.wsUrl);
  const rejection = await new Promise<number>((resolve) => {
    replay.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      replay.terminate();
    });
    replay.on("error", () => {});
  });
  expect(rejection).toBe(401);
  ws.terminate();
});

it("pairing revocation closes an admitted socket and blocks its upstream requests", async () => {
  const ticket = await mint();
  const { ws } = await connect(ticket);
  const closed = once(ws, "close");
  await store.revokeSession(ownerSession, clock);
  expect(closeSessionSockets(ownerSession)).toBe(1);
  await closed;
  const config = sessions[0];
  if (!config.isRevoked || !config.fetchImpl)
    throw new Error("Missing auth hooks");
  expect(await config.isRevoked(ticket.sessionId)).toBe(true);
  await expect(config.fetchImpl("http://invalid", {})).rejects.toThrow();
  expect(
    (await request(`/health?conversationId=${conversationId}`)).status,
  ).toBe(401);
});

it("rejects expired tickets and old runtime bindings", async () => {
  const ticket = await mint();
  clock += 120_001;
  const ws = new WebSocket(ticket.wsUrl);
  const status = await new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on("error", () => {});
  });
  expect(status).toBe(401);
  const next = await mint();
  state.current = { ...state.current } as AgentRuntime;
  const old = new WebSocket(next.wsUrl);
  const oldStatus = await new Promise<number>((resolve) => {
    old.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      old.terminate();
    });
    old.on("error", () => {});
  });
  expect(oldStatus).toBe(401);
});

it("explicit revoke and host close tear down live sessions", async () => {
  const ticket = await mint();
  const { ws } = await connect(ticket);
  const closed = once(ws, "close");
  expect((await request(`/${ticket.sessionId}/revoke`, {})).status).toBe(200);
  await closed;
  const next = await connect(await mint());
  const ended = once(next.ws, "close");
  host.close();
  await ended;
});

it("allows only an explicitly bound LAN origin in the local bridge", async () => {
  const scope = { agentId, conversationId };
  expect(() =>
    createLocalRuntimeConversationFetch("http://10.0.0.241:31725", scope),
  ).toThrow();
  const transport = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("data: [DONE]\n\n"),
  );
  const bridge = createLocalRuntimeConversationFetch(
    "http://10.0.0.241:31725",
    { ...scope, boundHostAddress: "10.0.0.241" },
    transport as unknown as typeof fetch,
  );
  await bridge(
    `http://10.0.0.241:31725/api/v1/eliza/agents/${agentId}/api/conversations/${conversationId}/messages/stream`,
    {
      method: "POST",
      body: JSON.stringify({
        text: "hello",
        turnTerminal: true,
        streamProtocol: "delta-v2",
        metadata: { clientTransport: "realtime_voice" },
      }),
    },
  );
  expect(String(transport.mock.calls[0][0])).toBe(
    `http://10.0.0.241:31725/api/conversations/${conversationId}/messages/stream`,
  );
  expect(() =>
    createLocalRuntimeConversationFetch("http://10.0.0.242:31725", {
      ...scope,
      boundHostAddress: "10.0.0.241",
    }),
  ).toThrow();
});

it("reset severs a live session and invalidates outstanding consent", async () => {
  const consentNonce = await nonce();
  const { ws } = await connect(await mint());
  const closed = once(ws, "close");
  host.reset();
  await closed;
  expect(
    (
      await request("", {
        agentId,
        conversationId,
        transport: "websocket",
        turnTerminal: true,
        consentNonce,
      })
    ).status,
  ).toBe(403);
});

it("protected hosts refuse the optional protocol", async () => {
  host.close();
  host = createSelfHostedVoice(state, { protectedHost: true });
  expect(
    (await request(`/health?conversationId=${conversationId}`)).status,
  ).toBe(503);
  expect(sessions).toHaveLength(0);
});

it("the agent host rejects upgrades before invoking protocol extensions", async () => {
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", join(directory, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", join(directory, "eliza.json"));
  vi.stubEnv("ELIZA_API_BIND", "127.0.0.1");
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  const { startApiServer } = await import("@elizaos/agent");
  const extension = vi.fn(async () => false);
  const api = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
    hostAdmission: (_req, boundary) => boundary !== "upgrade",
    handleProtocolUpgrade: extension,
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/some-protocol`);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        ws.terminate();
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
    expect(extension).not.toHaveBeenCalled();
  } finally {
    await api.close();
  }
});

it.each(["disabled", "missing-key-file"])(
  "can revoke an admitted session after configuration becomes %s",
  async (failure) => {
    const ticket = await mint();
    const { ws, frame } = await connect(ticket);
    expect(frame.t).toBe("ready");
    const closed = once(ws, "close");
    if (failure === "disabled")
      vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_ENABLED", "0");
    else vi.stubEnv("CARTESIA_API_KEY_FILE", join(directory, "removed-key"));
    expect(
      (await request(`/${ticket.sessionId}/revoke`, {}, "other-owner")).status,
    ).toBe(404);
    expect((await request(`/${ticket.sessionId}/revoke`, {})).status).toBe(200);
    await closed;
  },
);

it("explicit Cloud speech mode requires its account and never falls back to a personal Cartesia key", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "");
  const response = await request(`/health?conversationId=${conversationId}`);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(
    "private-provider-test-key",
  );
  expect(sessions).toHaveLength(0);
});
it.each([false, true])(
  "Cloud speech admission binds its returned session; diagnostic sink failure=%s",
  async (sinkFails) => {
    const admittedSessionId = randomUUID();
    const admittedExpiresAt = Date.now() + 60000;
    const log = vi.spyOn(logger, "info");
    if (sinkFails)
      log.mockImplementation((...args) => {
        if (args[1] === "[voice-session] Cloud speech admitted")
          throw Error("diagnostic sink unavailable");
      });
    vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
    vi.stubEnv(
      "ELIZAOS_CLOUD_BASE_URL",
      "https://api-staging.eliza.app/api/v1",
    );
    let admitted = 0,
      retired = 0,
      sttEvent:
        | ((
            event: import("@elizaos/host/voice/cartesia-ink").CartesiaInkRealtimeEvent,
          ) => void)
        | undefined;
    const relayOptions: Parameters<
      NonNullable<SelfHostedVoiceOptions["createCloudSpeechPorts"]>
    >[0][] = [];
    host.close();
    host = createSelfHostedVoice(state, {
      ...hostOptions,
      createCloudSpeechPorts: async (options) => {
        admitted++;
        relayOptions.push(options);
        options.assertCurrent();
        expect(await options.credential()).toBe("private-cloud-account");
        expect(options.origin).toBe("https://api-staging.eliza.app");
        return {
          sessionId: admittedSessionId,
          expiresAt: admittedExpiresAt,
          close: async () => {
            retired++;
          },
          speechPorts: {
            openStt: (callback) => {
              sttEvent = callback;
              return { sendAudioChunk() {}, close() {}, cancel() {} };
            },
            tts: {
              createStream(_config, callbacks) {
                let finish!: () => void;
                const closed = new Promise<void>((resolve) => {
                  finish = resolve;
                });
                return {
                  opened: Promise.resolve(),
                  closed,
                  sendPhrase(phrase) {
                    callbacks.onFirstAudio?.({ elapsedMs: 1 });
                    callbacks.onAudioFrame?.({ bytes: new Uint8Array([1, 2]) });
                    if (!phrase.continueContext) {
                      callbacks.onComplete?.({ frameCount: 1 });
                      finish();
                    }
                  },
                  cancel() {
                    finish();
                  },
                };
              },
              close() {},
            },
          },
        };
      },
      buildSession: (config) => {
        sessions.push(config);
        return new VoiceSession(config);
      },
    });
    const health = await (
      await request(`/health?conversationId=${conversationId}`)
    ).json();
    expect(health).toMatchObject({
      ready: true,
      speechRoute: "cloud",
      speechProvider: "cartesia",
      providerAdmission: "at-session-start",
    });
    expect(JSON.stringify(health)).not.toContain("private-");
    expect(admitted).toBe(0);
    const ticket = await mint();
    expect(admitted).toBe(0);
    const { ws, frame } = await connect(ticket);
    expect(frame.t).toBe("ready");
    expect(admitted).toBe(1);
    const receipt = {
      event: "cloud_speech_admitted",
      localVoiceSessionId: ticket.sessionId,
      speechSessionDigest: createHash("sha256")
        .update(JSON.stringify({ cloudSessionId: admittedSessionId }))
        .digest("hex"),
      expiresAt: admittedExpiresAt,
    };
    expect(log).toHaveBeenCalledWith(
      receipt,
      "[voice-session] Cloud speech admitted",
    );
    expect(JSON.stringify(receipt)).not.toContain(admittedSessionId);
    expect(JSON.stringify(receipt)).not.toContain("private-");
    expect(sessions[0].speechProvider).toBe("injected");
    expect(sessions[0].cartesiaApiKey).toBeUndefined();
    streamReply =
      "event: done\ndata: " +
      JSON.stringify({
        type: "done",
        text: "You are on Notes.",
        actionResults: [
          {
            actionName: "VIEWS",
            success: true,
            values: { mode: "open", viewId: "notes" },
          },
        ],
      }) +
      "\n\n";
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (data, binary) => {
      if (!binary) frames.push(JSON.parse(data.toString()));
    });
    sttEvent?.({ type: "connected", raw: {} });
    sttEvent?.({ type: "start-of-turn", transcript: "", raw: {} });
    sttEvent?.({
      type: "transcript-update",
      transcript: "open notes",
      raw: {},
    });
    sttEvent?.({ type: "end-of-turn", transcript: "open notes", raw: {} });
    await vi.waitFor(() =>
      expect(frames.some((value) => value.t === "reply_complete")).toBe(true),
    );
    expect(
      frames
        .filter((value) => value.t === "navigate_view")
        .map((value) => value.viewId),
    ).toEqual(["notes"]);
    const modelRequests = upstreamRequests.filter((r) =>
      r.url.includes("/messages/stream"),
    );
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0].headers.authorization).toBeUndefined();
    expect(modelRequests[0].headers.cookie).toBe(
      `${SESSION_COOKIE_NAME}=${ownerSession}`,
    );
    ws.send(JSON.stringify({ t: "bye" }));
    await vi.waitFor(() => expect(retired).toBe(1));
    expect(relayOptions).toHaveLength(1);
  },
);
it("unavailable Cloud admission closes the local voice attempt without invoking a direct provider", async () => {
  const log = vi.spyOn(logger, "info");
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let attempts = 0;
  host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async () => {
      attempts++;
      throw Error("relay or paid admission unavailable");
    },
  });
  const ticket = await mint();
  const { ws, frame } = await connect(ticket, ticket.token, false);
  expect(frame.t).toBe("error");
  expect(attempts).toBe(1);
  expect(sessions).toHaveLength(0);
  ws.terminate();
  expect(
    log.mock.calls.some(
      (call) => call[1] === "[voice-session] Cloud speech admitted",
    ),
  ).toBe(false);
});

it.each(["socket", "owner"] as const)(
  "ending the %s during asynchronous Cloud admission retires the late session without an admission receipt",
  async (ended) => {
    const log = vi.spyOn(logger, "info");
    vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
    vi.stubEnv(
      "ELIZAOS_CLOUD_BASE_URL",
      "https://api-staging.eliza.app/api/v1",
    );
    let release!: () => void,
      admitted = 0,
      retired = 0,
      sttOpens = 0;
    let providerSignal: AbortSignal | undefined;
    host.close();
    host = createSelfHostedVoice(state, {
      ...hostOptions,
      createCloudSpeechPorts: async (options) => {
        providerSignal = options.signal;
        admitted++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          sessionId: randomUUID(),
          expiresAt: Date.now() + 60000,
          close: async () => {
            retired++;
          },
          speechPorts: {
            openStt() {
              sttOpens++;
              return { sendAudioChunk() {}, close() {}, cancel() {} };
            },
            tts: {
              createStream() {
                throw Error("No TTS on closed caller");
              },
              close() {},
            },
          },
        };
      },
      buildSession: (config) => {
        sessions.push(config);
        return new VoiceSession(config);
      },
    });
    const ticket = await mint(),
      ws = new WebSocket(ticket.wsUrl);
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        t: "hello",
        turnTerminal: true,
        token: ticket.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await vi.waitFor(() => expect(admitted).toBe(1));
    const endedSocket = once(ws, "close");
    if (ended === "socket") {
      ws.terminate();
      await endedSocket;
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    } else {
      await store.revokeSession(ownerSession, clock);
    }
    release();
    await vi.waitFor(() => expect(retired).toBe(1));
    if (ended === "owner") await endedSocket;
    expect(
      log.mock.calls.some(
        (call) => call[1] === "[voice-session] Cloud speech admitted",
      ),
    ).toBe(false);
    expect(sttOpens).toBe(0);
    expect(
      upstreamRequests.filter((r) => r.url.includes("messages/stream")),
    ).toHaveLength(0);
  },
);

it("only Cloud speech advertises the shared60second budget so canonical idle rotation precedes provider expiry", async () => {
  const direct = await mint();
  expect(direct.expiresAt - clock).toBe(120000);
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  const cloud = await mint();
  expect(cloud.expiresAt - clock).toBe(60000);
  expect(cloud.leaseRenewal).toBe(true);
  expect(sessions).toHaveLength(0);
  expect(cloud.token).not.toBe(direct.token);
});

it("a paid Cloud renewal updates the active host lease without reopening speech", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let relayOptions:
    | Parameters<
        NonNullable<SelfHostedVoiceOptions["createCloudSpeechPorts"]>
      >[0]
    | undefined;
  let opens = 0;
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      relayOptions = options;
      opens++;
      return {
        renewable: true,
        sessionId: randomUUID(),
        expiresAt: clock + 60000,
        close: async () => {},
        speechPorts: {
          openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
          tts: {
            createStream() {
              throw Error("No reply requested");
            },
            close() {},
          },
        },
      };
    },
    buildSession: (config) => new VoiceSession({ ...config, now: () => clock }),
  });
  const ticket = await mint();
  const { ws, frame } = await connect(ticket);
  expect(frame.leaseExpiresAt).toBe(clock + 60000);
  const update = once(ws, "message");
  relayOptions!.onLeaseExtended!(clock + 110000);
  expect(JSON.parse(String((await update)[0]))).toEqual({
    t: "lease_extended",
    sessionId: ticket.sessionId,
    expiresAt: clock + 110000,
  });
  clock += 61000;
  expect(() => relayOptions!.assertCurrent()).not.toThrow();
  expect(opens).toBe(1);
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ t: "bye" }));
  await closed;
  expect(() => relayOptions!.assertCurrent()).toThrow();
});

it("ReadAloud requires current owner auth, strict text and direct configuration before provider dispatch", async () => {
  let providerCalls = 0;
  hostOptions.cartesiaWebSocketFactory = () => {
    providerCalls++;
    throw Error("must not open");
  };
  host.close();
  host = createSelfHostedVoice(state, hostOptions);
  const read = (
    body: unknown,
    token = ownerSession,
    id: string = randomUUID(),
  ) =>
    fetch(`${origin}/api/v1/voice/session/read-aloud`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Request-Id": id,
      },
      body: JSON.stringify(body),
    });
  expect((await read({ text: "Owned" }, "machine")).status).toBe(403);
  expect((await read({ text: "Owned" }, "")).status).toBe(401);
  expect((await read({ text: "Owned", apiKey: "untrusted" })).status).toBe(400);
  expect((await read({ text: "Owned" }, ownerSession, "invalid")).status).toBe(
    400,
  );
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "synthetic-cloud");
  expect((await read({ text: "Owned" })).status).toBe(409);
  expect(providerCalls).toBe(0);
});

it("ReadAloud HTTP uses real Sonic composition and returns only owned Cartesia direct WAV", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let closed = 0;
  hostOptions.cartesiaWebSocketFactory = () => {
    const events = cartesiaEvents(),
      emit = events.emit;
    return {
      readyState: 1,
      addEventListener: events.addEventListener,
      removeEventListener: events.removeEventListener,
      send(raw: string) {
        const frame = JSON.parse(raw);
        sent.push(frame);
        if (!frame.transcript) return;
        queueMicrotask(() => {
          emit("message", {
            data: JSON.stringify({
              type: "chunk",
              context_id: frame.context_id,
              data: Buffer.from([0, 128, 255, 127]).toString("base64"),
            }),
          });
          emit("message", {
            data: JSON.stringify({
              type: "done",
              context_id: frame.context_id,
              done: true,
            }),
          });
        });
      },
      close() {
        closed++;
        emit("close", { code: 1000 });
      },
    };
  };
  host.close();
  host = createSelfHostedVoice(state, hostOptions);
  const id = randomUUID();
  const response = await fetch(`${origin}/api/v1/voice/session/read-aloud`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerSession}`,
      "Content-Type": "application/json",
      "X-Request-Id": id,
    },
    body: JSON.stringify({ text: "Selected owned message" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe(id);
  expect(response.headers.get("x-eliza-speech-provider")).toBe("cartesia");
  expect(response.headers.get("x-eliza-speech-route")).toBe("direct");
  expect(response.headers.get("content-type")).toBe("audio/wav");
  const audio = Buffer.from(await response.arrayBuffer());
  expect(audio.toString("ascii", 0, 4)).toBe("RIFF");
  expect([...audio.subarray(44)]).toEqual([0, 128, 255, 127]);
  expect(
    sent.filter((frame) => frame.transcript).map((frame) => frame.transcript),
  ).toEqual(["Selected owned message"]);
  expect(closed).toBe(1);
});

it("prefetched replacement waits for predecessor relay retirement before provider acquisition", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let prepared = 0;
  let opened = 0,
    active = 0,
    maxActive = 0,
    release!: () => void;
  const retired = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      if (options.beforeProviderAdmission) prepared++;
      await options.beforeProviderAdmission?.();
      options.signal?.throwIfAborted();
      options.assertCurrent();
      const index = ++opened;
      active++;
      maxActive = Math.max(maxActive, active);
      let closing: Promise<void> | undefined;
      return {
        sessionId: randomUUID(),
        expiresAt: Date.now() + 60000,
        close: () =>
          (closing ??= (async () => {
            if (index === 1) await retired;
            active--;
          })()),
        speechPorts: {
          openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
          tts: {
            createStream() {
              throw Error("No TTS expected");
            },
            close() {},
          },
        },
      };
    },
  });
  const first = await mint();
  const initial = await connect(first);
  expect(opened).toBe(1);
  const response = await request("", {
    agentId,
    conversationId,
    transport: "websocket",
    turnTerminal: true,
    consentNonce: await nonce(),
    predecessorSessionId: first.sessionId,
  });
  expect(response.status).toBe(200);
  const second = await response.json();
  expect(opened).toBe(1);
  expect(prepared).toBe(1);
  const duplicate = await request("", {
    agentId,
    conversationId,
    transport: "websocket",
    turnTerminal: true,
    consentNonce: await nonce(),
    predecessorSessionId: first.sessionId,
  });
  expect(duplicate.status).toBe(403);
  const pending = connect(second);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(opened).toBe(1);
  expect(maxActive).toBe(1);
  release();
  const replacement = await pending;
  expect(replacement.frame.t).toBe("ready");
  expect(opened).toBe(2);
  expect(maxActive).toBe(1);
  initial.ws.close();
  replacement.ws.close();
});

for (const fault of [
  "retire-reject",
  "stop",
  "owner",
  "expiry",
  "runtime",
] as const) {
  it(`prefetch retirement fence survives ${fault} without another provider`, async () => {
    vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
    vi.stubEnv(
      "ELIZAOS_CLOUD_BASE_URL",
      "https://api-staging.eliza.app/api/v1",
    );
    let rejectRetirement = fault === "retire-reject";
    let opened = 0,
      release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.close();
    host = createSelfHostedVoice(state, {
      ...hostOptions,
      createCloudSpeechPorts: async (options) => {
        await options.beforeProviderAdmission?.();
        options.signal?.throwIfAborted();
        options.assertCurrent();
        opened++;
        return {
          sessionId: randomUUID(),
          expiresAt: clock + 60000,
          close: async () => {
            await wait;
            if (rejectRetirement) throw Error("retirement unconfirmed");
          },
          speechPorts: {
            openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
            tts: {
              createStream() {
                throw Error("No TTS expected");
              },
              close() {},
            },
          },
        };
      },
    });
    const first = await mint();
    const old = await connect(first);
    const result = await request("", {
      agentId,
      conversationId,
      transport: "websocket",
      turnTerminal: true,
      consentNonce: await nonce(),
      predecessorSessionId: first.sessionId,
    });
    expect(result.status).toBe(200);
    const second = await result.json();
    const ws = new WebSocket(second.wsUrl);
    await once(ws, "open");
    const ended = once(ws, "message");
    ws.send(
      JSON.stringify({
        t: "hello",
        turnTerminal: true,
        token: second.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBe(1);
    if (fault === "stop") {
      const closed = once(ws, "close");
      ws.close();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (fault === "owner") await store.revokeSession(ownerSession, clock);
    if (fault === "expiry") clock += 61000;
    if (fault === "runtime") state.current = null;
    release();
    if (fault !== "stop") {
      const message = JSON.parse(String((await ended)[0]));
      expect(message.t).not.toBe("ready");
    } else await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBe(1);
    if (fault === "retire-reject") {
      expect(JSON.parse(String((await ended)[0])).code).toBe(
        "voice_retirement_unconfirmed",
      );
      const unlinked = await mint();
      const blocked = await connect(unlinked, unlinked.token, false);
      expect(blocked.frame.t).not.toBe("ready");
      expect(blocked.frame.code).toBe("voice_retirement_unconfirmed");
      expect(opened).toBe(1);
      blocked.ws.close();
    }
    rejectRetirement = false;
    await host.close();
    old.ws.close();
    ws.close();
  });
}

for (const failure of [
  "owner-after-acquire",
  "constructor",
  "replacement",
] as const) {
  it(`prefetch tracks failed cleanup after ${failure} before any later provider`, async () => {
    vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
    vi.stubEnv(
      "ELIZAOS_CLOUD_BASE_URL",
      "https://api-staging.eliza.app/api/v1",
    );
    const originalRuntime = state.current;
    let opened = 0,
      allowCleanup = false;
    const options: SelfHostedVoiceOptions = {
      ...hostOptions,
      createCloudSpeechPorts: async () => {
        opened++;
        if (failure === "owner-after-acquire") state.current = null;
        return {
          sessionId: randomUUID(),
          expiresAt: clock + 60000,
          close: async () => {
            if (!allowCleanup) throw Error("retirement unknown");
          },
          speechPorts: {
            openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
            tts: {
              createStream() {
                throw Error("No TTS expected");
              },
              close() {},
            },
          },
        };
      },
      buildSession() {
        throw Error("constructor failed");
      },
    };
    await host.close();
    host = createSelfHostedVoice(state, options);
    const first = await mint();
    const failed = await connect(first, first.token, false);
    expect(failed.frame.t).not.toBe("ready");
    expect(opened).toBe(1);
    state.current = originalRuntime;
    if (failure === "replacement") {
      await expect(host.close()).rejects.toThrow(
        "Cloud retirement was not confirmed",
      );
      host = createSelfHostedVoice(state, options);
    }
    const second = await mint();
    const blocked = await connect(second, second.token, false);
    expect(blocked.frame.t).not.toBe("ready");
    expect(opened).toBe(1);
    allowCleanup = true;
    await host.close();
    failed.ws.close();
    blocked.ws.close();
  });
}
it("prefetch tracks late acquisition after Stop before allowing an unlinked provider", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let opened = 0,
    cleanupAttempts = 0,
    allowCleanup = false,
    release!: () => void,
    notifyAbort!: () => void,
    notifyCleanup!: () => void;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    serverAborted = new Promise<void>((resolve) => {
      notifyAbort = resolve;
    }),
    cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanup = resolve;
    });
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      opened++;
      const signal = options.signal;
      if (!signal) throw Error("Missing Cloud startup cancellation signal");
      if (signal.aborted) notifyAbort();
      else signal.addEventListener("abort", notifyAbort, { once: true });
      await pending;
      return {
        sessionId: randomUUID(),
        expiresAt: clock + 60000,
        close: async () => {
          cleanupAttempts++;
          notifyCleanup();
          if (!allowCleanup) throw Error("retirement unknown");
        },
        speechPorts: {
          openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
          tts: {
            createStream() {
              throw Error("No TTS expected");
            },
            close() {},
          },
        },
      };
    },
  });
  const first = await mint();
  const ws = new WebSocket(first.wsUrl);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      t: "hello",
      turnTerminal: true,
      token: first.token,
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    }),
  );
  for (let n = 0; n < 100 && opened === 0; n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(opened).toBe(1);
  const closed = once(ws, "close");
  ws.close();
  await closed;
  await serverAborted;
  release();
  try {
    await cleanupStarted;
    expect(cleanupAttempts).toBeGreaterThan(0);
    const second = await mint();
    const blocked = await connect(second, second.token, false);
    expect(blocked.frame.t).not.toBe("ready");
    expect(opened).toBe(1);
    blocked.ws.close();
  } finally {
    allowCleanup = true;
    await host.close();
  }
});

it("actual relay startup cleanup failure blocks shutdown and unlinked replacement until exact retirement", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let allowRetirement = false,
    failStartup = true,
    providerStarts = 0,
    mints = 0;
  const admitted = new Set<string>(),
    expiries = new Map<string, string>();
  const remote = await listenLoopbackWebSocket(
    async (request) => {
      const path = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toBe(
        "Bearer private-cloud-account",
      );
      if (path.endsWith("/consent"))
        return Response.json({
          retirementProofVersion: 1,
          consentNonce: randomUUID(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      if (path.endsWith("/revoke")) {
        const id = path.split("/").at(-2)!;
        expect(admitted.has(id)).toBe(true);
        return Response.json(
          allowRetirement
            ? {
                revoked: true,
                retirement: {
                  version: 1,
                  sessionId: id,
                  state: "confirmed",
                  mode: "retired",
                  stt: "gracefully_drained",
                  tts: "transport_closed",
                  accounting: "settled_actual",
                  completedAt: new Date().toISOString(),
                },
              }
            : { revoked: false },
          { status: allowRetirement ? 200 : 503 },
        );
      }
      const id = randomUUID();
      mints++;
      admitted.add(id);
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      expiries.set(id, expiresAt);
      return Response.json({
        sessionId: id,
        token: "remote-one-use",
        expiresAt,
        version: 1,
        retirementProofVersion: 1,
        wsUrl:
          remote.url.origin.replace("http:", "ws:") +
          "/api/v1/voice/speech/ws?sessionId=" +
          id,
      });
    },
    (request) => new URL(request.url).pathname === "/api/v1/voice/speech/ws",
  );
  remote.sockets.on("connection", (ws, request) => {
    const expiresAt = expiries.get(
      new URL(request.url!, remote.url).searchParams.get("sessionId")!,
    );
    providerStarts++;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.t !== "hello") return;
      if (failStartup) {
        ws.send(JSON.stringify({ t: "error", code: "unavailable" }));
        return;
      }
      ws.send(
        JSON.stringify({
          t: "ready",
          version: 1,
          sampleRate: 16000,
          channels: 1,
          expiresAt,
        }),
      );
      ws.send(JSON.stringify({ t: "stt", event: { type: "connected" } }));
    });
  });
  const options: SelfHostedVoiceOptions = {
    ...hostOptions,
    createCloudSpeechPorts: (opts) =>
      createCloudSpeechRelayPorts({
        ...opts,
        recoveryJournal: undefined,
        origin: remote.url.origin,
        allowInsecureLoopback: true,
        logger: { warn() {} },
      }),
  };
  await host.close();
  host = createSelfHostedVoice(state, options);
  try {
    const first = await mint();
    const failed = await connect(first, first.token, false);
    expect(failed.frame.t).not.toBe("ready");
    failed.ws.close();
    expect(providerStarts).toBe(1);
    await expect(host.close()).rejects.toThrow(
      "Cloud retirement was not confirmed",
    );
    host = createSelfHostedVoice(state, options);
    const second = await mint();
    const blocked = await connect(second, second.token, false);
    expect(blocked.frame.t).not.toBe("ready");
    blocked.ws.close();
    expect(providerStarts).toBe(1);
    expect(mints).toBe(1);
    allowRetirement = true;
    await host.close();
    failStartup = false;
    host = createSelfHostedVoice(state, options);
    const third = await mint();
    const ready = await connect(third);
    expect(ready.frame.t).toBe("ready");
    expect(providerStarts).toBe(2);
    ready.ws.close();
  } finally {
    allowRetirement = true;
    await host.close();
    await remote.close();
  }
});

async function stopIntentHost() {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let opened = 0;
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      await options.beforeProviderAdmission?.();
      options.signal?.throwIfAborted();
      options.assertCurrent();
      opened++;
      return {
        sessionId: randomUUID(),
        expiresAt: clock + 60000,
        close: async () => {},
        speechPorts: {
          openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
          tts: {
            createStream() {
              throw Error("No TTS expected");
            },
            close() {},
          },
        },
      };
    },
  });
  const first = await mint();
  const live = await connect(first);
  const response = await request("", {
    agentId,
    conversationId,
    transport: "websocket",
    turnTerminal: true,
    consentNonce: await nonce(),
    predecessorSessionId: first.sessionId,
  });
  expect(response.status).toBe(200);
  const second = await response.json();
  return { first, second, live, opened: () => opened };
}
for (const stage of ["upgrade", "hello"] as const) {
  for (const changed of ["route", "credential", "origin"] as const) {
    it(`prepared successor rejects ${changed} drift before ${stage}`, async () => {
      const f = await stopIntentHost();
      const drift = () => {
        if (changed === "route")
          vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "");
        if (changed === "credential")
          vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "different-account");
        if (changed === "origin")
          vi.stubEnv(
            "ELIZAOS_CLOUD_BASE_URL",
            "https://other.eliza.app/api/v1",
          );
      };
      if (stage === "upgrade") drift();
      const ws = new WebSocket(f.second.wsUrl);
      if (stage === "upgrade") {
        const status = await new Promise<number>((resolve) => {
          ws.on("unexpected-response", (_req, res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
            ws.terminate();
          });
          ws.on("error", () => {});
        });
        expect(status).toBe(401);
      } else {
        await once(ws, "open");
        drift();
        const message = once(ws, "message");
        ws.send(
          JSON.stringify({
            t: "hello",
            turnTerminal: true,
            token: f.second.token,
            protocol: 1,
            uplinkCodec: "pcm16",
            downlinkCodec: "pcm16",
            sampleRate: 16000,
          }),
        );
        expect(JSON.parse(String((await message)[0])).t).toBe("error");
        ws.close();
      }
      expect(f.opened()).toBe(1);
      expect(sessions).toHaveLength(1);
      expect(f.live.ws.readyState).toBe(WebSocket.OPEN);
    });
  }
}

it.each(["revoke", "socket"] as const)(
  "%s cancellation releases only its predecessor link for explicit retry",
  async (cancel) => {
    const f = await stopIntentHost();
    if (cancel === "revoke") {
      expect((await request(`/${f.second.sessionId}/revoke`, {})).status).toBe(
        200,
      );
    } else {
      const ws = new WebSocket(f.second.wsUrl);
      await once(ws, "open");
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
    const prepare = async () =>
      request("", {
        agentId,
        conversationId,
        transport: "websocket",
        turnTerminal: true,
        consentNonce: await nonce(),
        predecessorSessionId: f.first.sessionId,
      });
    const retry = await vi.waitFor(async () => {
      const response = await prepare();
      expect(response.status).toBe(200);
      return response;
    });
    expect((await retry.json()).sessionId).not.toBe(f.second.sessionId);
    expect((await request(`/${f.second.sessionId}/revoke`, {})).status).toBe(
      404,
    );
    expect((await prepare()).status).toBe(403);
    expect(f.opened()).toBe(1);
    expect(f.live.ws.readyState).toBe(WebSocket.OPEN);
  },
);

it("failed consent preparation permits explicit retry without retiring its predecessor", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let fail = true,
    opened = 0;
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      if (options.beforeProviderAdmission && fail) {
        fail = false;
        throw Error("consent unavailable");
      }
      await options.beforeProviderAdmission?.();
      options.signal?.throwIfAborted();
      options.assertCurrent();
      opened++;
      return {
        sessionId: randomUUID(),
        expiresAt: clock + 60000,
        close: async () => {},
        speechPorts: {
          openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
          tts: {
            createStream() {
              throw Error("No TTS expected");
            },
            close() {},
          },
        },
      };
    },
  });
  const first = await mint();
  const live = await connect(first);
  const prepare = async () =>
    request("", {
      agentId,
      conversationId,
      transport: "websocket",
      turnTerminal: true,
      consentNonce: await nonce(),
      predecessorSessionId: first.sessionId,
    });
  expect((await prepare()).status).toBe(503);
  expect((await prepare()).status).toBe(200);
  expect(opened).toBe(1);
  expect(live.ws.readyState).toBe(WebSocket.OPEN);
});

it("public normal Stop cancels its prepared successor", async () => {
  const f = await stopIntentHost();
  const closed = once(f.live.ws, "close");
  f.live.ws.send(
    JSON.stringify({
      t: "bye",
      intent: { version: 1, kind: "user_stop", generation: f.first.sessionId },
    }),
  );
  await closed;
  expect((await request(`/${f.second.sessionId}/revoke`, {})).status).toBe(404);
  expect(f.opened()).toBe(1);
});
it("public budget rotation preserves only the named successor", async () => {
  const f = await stopIntentHost();
  const closed = once(f.live.ws, "close");
  f.live.ws.send(
    JSON.stringify({
      t: "bye",
      intent: {
        version: 1,
        kind: "budget_rotation",
        generation: f.first.sessionId,
        successorSessionId: f.second.sessionId,
      },
    }),
  );
  await closed;
  const next = await connect(f.second);
  expect(next.frame.t).toBe("ready");
  expect(f.opened()).toBe(2);
  next.ws.close();
});
it("stale generation does not execute Stop", async () => {
  const f = await stopIntentHost();
  const response = once(f.live.ws, "message");
  f.live.ws.send(
    JSON.stringify({
      t: "bye",
      intent: { version: 1, kind: "user_stop", generation: randomUUID() },
    }),
  );
  expect(JSON.parse(String((await response)[0])).code).toBe(
    "bye_intent_invalid",
  );
  expect(f.live.ws.readyState).toBe(WebSocket.OPEN);
  expect(f.opened()).toBe(1);
  expect((await request(`/${f.second.sessionId}/revoke`, {})).status).toBe(200);
  f.live.ws.close();
});
it("legacy bare bye makes no prepared cancellation claim", async () => {
  const f = await stopIntentHost();
  const closed = once(f.live.ws, "close");
  f.live.ws.send(JSON.stringify({ t: "bye" }));
  await closed;
  expect((await request(`/${f.second.sessionId}/revoke`, {})).status).toBe(200);
  expect(f.opened()).toBe(1);
});

it("concurrent unlinked admissions reserve one conversation before any factory await", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let entered = 0,
    active = 0,
    maximum = 0,
    release!: () => void,
    notify!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    firstEntered = new Promise<void>((resolve) => {
      notify = resolve;
    });
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async () => {
      const attempt = ++entered;
      if (attempt === 1) {
        notify();
        await held;
      }
      active++;
      maximum = Math.max(maximum, active);
      let closing: Promise<void> | undefined;
      return {
        sessionId: randomUUID(),
        expiresAt: clock + 60000,
        close: () =>
          (closing ??= Promise.resolve().then(() => {
            active--;
          })),
        speechPorts: {
          openStt: () => ({ sendAudioChunk() {}, close() {}, cancel() {} }),
          tts: {
            createStream() {
              throw Error("No TTS expected");
            },
            close() {},
          },
        },
      };
    },
  });
  const first = await mint(),
    second = await mint();
  const sockets: WebSocket[] = [];
  const begin = async (ticket: Awaited<ReturnType<typeof mint>>) => {
    const ws = new WebSocket(ticket.wsUrl);
    sockets.push(ws);
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        t: "hello",
        turnTerminal: true,
        token: ticket.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    return ws;
  };
  const a = await begin(first);
  await firstEntered;
  const b = await begin(second);
  const bReady = once(b, "message");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(entered).toBe(1);
  expect(active).toBe(0);
  release();
  expect(JSON.parse(String((await bReady)[0])).t).toBe("ready");
  expect(entered).toBe(2);
  expect(maximum).toBe(1);
  await host.close();
  for (const ws of sockets) ws.close();
});

it("concurrent queued admission cannot bypass failed acquisition retirement", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let entered = 0,
    allowCleanup = false,
    release!: () => void,
    notify!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    firstEntered = new Promise<void>((resolve) => {
      notify = resolve;
    });
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      entered++;
      options.registerRetirement?.({
        close: async () => {
          if (!allowCleanup) throw Error("unconfirmed acquisition");
        },
        retryRetirement: async () => {
          if (!allowCleanup) throw Error("unconfirmed acquisition");
        },
      });
      notify();
      await held;
      throw Error("acquisition failed");
    },
  });
  const a = await mint(),
    b = await mint();
  const first = connect(a, a.token, false);
  await firstEntered;
  const second = connect(b, b.token, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const failed = await Promise.all([first, second]);
  expect(entered).toBe(1);
  for (const item of failed) {
    expect(item.frame.t).not.toBe("ready");
    item.ws.close();
  }
  allowCleanup = true;
  await host.close();
});

it("retirement failure preserves the primary insufficient-credit code", async () => {
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "private-cloud-account");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  let allowCleanup = false,
    closes = 0;
  await host.close();
  host = createSelfHostedVoice(state, {
    ...hostOptions,
    createCloudSpeechPorts: async (options) => {
      const close = async () => {
        closes++;
        if (!allowCleanup) throw Error("retirement unconfirmed");
      };
      options.registerRetirement?.({ close, retryRetirement: close });
      throw new CloudSpeechRelayClientError(
        "insufficient_credits",
        "credits required",
      );
    },
  });
  try {
    const ticket = await mint();
    const failed = await connect(ticket, ticket.token, false);
    expect(failed.frame.t).toBe("error");
    expect(failed.frame.code).toBe("insufficient_credits");
    expect(closes).toBeGreaterThan(0);
    failed.ws.close();
  } finally {
    allowCleanup = true;
    await host.close();
  }
});

it("legacy mint refusal is nontransient and leaves the same consent usable before any session allocation", async () => {
  const consentNonce = await nonce();
  const before = sessions.length;
  const legacy = await request("", {
    agentId,
    conversationId,
    transport: "websocket",
    consentNonce,
  });
  expect(legacy.status).toBe(409);
  expect(await legacy.json()).toMatchObject({
    code: "turn_terminal_unsupported",
  });
  expect(sessions).toHaveLength(before);
  const supported = await request("", {
    agentId,
    conversationId,
    transport: "websocket",
    consentNonce,
    turnTerminal: true,
  });
  expect(supported.status).toBe(200);
  expect(await supported.json()).toMatchObject({ turnTerminal: true });
});

it.each([false, "true", 1, null])(
  "rejects malformed mint capability %j before consuming consent",
  async (turnTerminal) => {
    const consentNonce = await nonce();
    const before = sessions.length;
    const rejected = await request("", {
      agentId,
      conversationId,
      transport: "websocket",
      consentNonce,
      turnTerminal,
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      code: "turn_terminal_unsupported",
    });
    expect(sessions).toHaveLength(before);
    expect(
      (
        await request("", {
          agentId,
          conversationId,
          transport: "websocket",
          consentNonce,
          turnTerminal: true,
        })
      ).status,
    ).toBe(200);
  },
);

it("missing or malformed hello capability does not claim the ticket or allocate a session", async () => {
  const ticket = await mint();
  const before = sessions.length;
  for (const capability of [undefined, false, "true"]) {
    const ws = new WebSocket(ticket.wsUrl);
    const message = once(ws, "message");
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        t: "hello",
        token: ticket.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
        ...(capability === undefined ? {} : { turnTerminal: capability }),
      }),
    );
    const frame = JSON.parse(String((await message)[0]));
    expect(frame.t).toBe("error");
    expect(["turn_terminal_unsupported", "hello_bad_capability"]).toContain(
      frame.code,
    );
    expect(sessions).toHaveLength(before);
    ws.close();
  }
  const supported = await connect(ticket);
  expect(supported.frame.t).toBe("ready");
});
