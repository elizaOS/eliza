import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import {
  type LoopbackWebSocket,
  listenLoopbackHttp,
  listenLoopbackWebSocket,
} from "../../../app/test/fixtures/loopback-server.ts";
import {
  type CloudSpeechRelayClientOptions,
  type CloudSpeechRelayTransportDiagnostic,
  createCloudSpeechRelayPorts,
} from "./cloud-speech-relay-client";
import { createLocalRuntimeConversationFetch } from "./local-runtime-conversation-fetch";
import type { ServerControlFrame } from "./protocol";
import { VoiceSession } from "./session";
import { createVoiceSessionRegistry } from "./session-registry";
import { encodeSpeechRelayAudio } from "./speech-relay-wire";
import { InMemoryVoiceUsageStore } from "./usage";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const until = async (read: () => boolean) => {
  for (let n = 0; n < 100 && !read(); n++) await sleep(5);
  expect(read()).toBe(true);
};
async function fixture() {
  const account = "server-account-secret",
    token = "one-use-speech-token",
    sessionId = crypto.randomUUID(),
    requests: { path: string; authorization: string | null; body: unknown }[] =
      [],
    controls: Record<string, unknown>[] = [],
    pcm: Uint8Array[] = [],
    sockets: LoopbackWebSocket[] = [],
    pendingSpeech: (() => void)[] = [],
    diagnostics: CloudSpeechRelayTransportDiagnostic[] = [];
  let expiry = new Date(Date.now() + 60000).toISOString(),
    mode = "ok",
    current = true,
    connections = 0;
  const server = await listenLoopbackWebSocket(
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/voice/speech/ws")
        return new Response(null, { status: 400 });
      requests.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      if (mode === "redirect")
        return Response.redirect("https://other.invalid/steal", 307);
      if (url.pathname.endsWith("/consent"))
        return Response.json({
          consentNonce: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        });
      if (url.pathname.endsWith("/revoke"))
        return Response.json({ revoked: true });
      const wsUrl = `${server.url.origin.replace("http:", "ws:")}/api/v1/voice/speech/ws?sessionId=${sessionId}`;
      if (mode === "expired") expiry = new Date(Date.now() - 1).toISOString();
      if (mode === "short") expiry = new Date(Date.now() + 150).toISOString();
      return Response.json({
        sessionId,
        token,
        expiresAt: expiry,
        version: 1,
        wsUrl:
          mode === "foreign"
            ? "wss://other.invalid/api/v1/voice/speech/ws?sessionId=" +
              sessionId
            : wsUrl,
        ...(mode === "extra" ? { apiKey: "must-reject" } : {}),
      });
    },
    (request) => {
      const url = new URL(request.url);
      return (
        url.pathname === "/api/v1/voice/speech/ws" &&
        url.search === `?sessionId=${sessionId}`
      );
    },
  );
  server.sockets.on("connection", (ws) => {
    connections++;
    sockets.push(ws);

    ws.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const value = isBinary ? new Uint8Array(bytes) : bytes.toString();
      if (typeof value !== "string") {
        pcm.push(new Uint8Array(value));
        return;
      }
      const frame = JSON.parse(value);
      controls.push(frame);
      if (frame.t === "hello") {
        expect(frame.token).toBe(token);
        if (mode === "hold-ready") return;
        if (mode === "reject-ready" || mode === "reject-credit") {
          ws.send(
            JSON.stringify({
              t: "error",
              code: "unavailable",
              ...(mode === "reject-credit"
                ? { reason: "insufficient_credits" }
                : {}),
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            t: "ready",
            version: 1,
            sampleRate: 16000,
            channels: 1,
            expiresAt: expiry,
          }),
        );
        ws.send(JSON.stringify({ t: "stt", event: { type: "connected" } }));
        return;
      }
      if (frame.t === "prepare") {
        if (mode !== "hold-prepare")
          ws.send(JSON.stringify({ t: "tts_prepared", id: frame.id }));
        return;
      }
      if (frame.t === "tts") {
        const deliver = () => {
          ws.send(
            encodeSpeechRelayAudio(frame.id, new Uint8Array([1, 2, 3, 4])),
          );
          if (frame.flush)
            ws.send(
              JSON.stringify({
                t: "flush_complete",
                id: frame.id,
                flushId: 1,
              }),
            );
        };
        if (mode === "hold-speech") pendingSpeech.push(deliver);
        else deliver();
      }
      if (frame.t === "finish") {
        const deliver = () =>
          ws.send(JSON.stringify({ t: "complete", id: frame.id }));
        if (mode === "hold-speech") pendingSpeech.push(deliver);
        else deliver();
      }
      if (frame.t === "stop") ws.close(1000, "stopped");
    });
  });
  cleanups.push(() => server.close());
  const options: CloudSpeechRelayClientOptions = {
    enabled: true,
    logger: {
      warn(value: unknown) {
        diagnostics.push(value as CloudSpeechRelayTransportDiagnostic);
      },
    },
    origin: server.url.origin,
    allowInsecureLoopback: true,
    credential: async () => account,
    assertCurrent() {
      if (!current) throw Error("owner changed");
    },
  };
  return {
    options,
    diagnostics,
    requests,
    controls,
    pcm,
    sockets,
    server,
    get connections() {
      return connections;
    },
    changeOwner() {
      current = false;
    },
    mode(value: string) {
      mode = value;
    },
    releaseSpeech() {
      mode = "ok";
      for (const deliver of pendingSpeech.splice(0)) deliver();
    },
    send(value: unknown) {
      for (const ws of sockets) ws.send(JSON.stringify(value));
    },
  };
}
test("server-only client uses account auth only for fixed HTTP routes, then canonical STT and one streamed Sonic context", async () => {
  const f = await fixture(),
    client = await createCloudSpeechRelayPorts(f.options),
    events: unknown[] = [],
    audio: Uint8Array[] = [],
    flush: number[] = [],
    complete: number[] = [];
  const stt = client.speechPorts.openStt((event) => events.push(event));
  await until(() => events.length === 1);
  for (const event of [
    { type: "start-of-turn", transcript: "" },
    { type: "transcript-update", transcript: "open notes" },
    { type: "eager-end-of-turn", transcript: "open notes" },
    { type: "turn-resumed", transcript: "open notes please" },
    { type: "end-of-turn", transcript: "open notes please" },
  ])
    f.send({ t: "stt", event });
  await until(() => events.length === 6);
  expect(events.map((e) => (e as { type: string }).type)).toEqual([
    "connected",
    "start-of-turn",
    "transcript-update",
    "eager-end-of-turn",
    "turn-resumed",
    "end-of-turn",
  ]);
  stt.sendAudioChunk(new Uint8Array(3200));
  const stream = client.speechPorts.tts.createStream(
    { traceId: "local-trace", maxBufferDelayMs: 250 },
    {
      onAudioFrame: (event) => audio.push(event.bytes),
      onFlushComplete: (event) =>
        event.flushId === undefined ? undefined : flush.push(event.flushId),
      onComplete: (event) => complete.push(event.frameCount),
    },
  );
  stream.sendPhrase({ text: "You are ", continueContext: true, flush: true });
  stream.sendPhrase({ text: "on Notes.", continueContext: false });
  await stream.closed;
  expect(f.connections).toBe(1);
  expect(audio).toHaveLength(2);
  expect(flush).toEqual([1]);
  expect(complete).toEqual([2]);
  const phrases = f.controls.filter((c) => c.t === "tts");
  expect(phrases).toHaveLength(2);
  expect(phrases[0].id).toBe(phrases[1].id);
  expect(f.controls.filter((c) => c.t === "finish")).toHaveLength(1);
  await until(() => f.pcm.length === 1);
  expect(f.requests.map((r) => r.path)).toEqual([
    "/api/v1/voice/speech/consent",
    "/api/v1/voice/speech/session",
  ]);
  expect(
    f.requests.every((r) => r.authorization === "Bearer server-account-secret"),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("secret");
  expect(JSON.stringify(f.controls)).not.toContain("server-account-secret");
  expect(Object.keys(f.requests[1].body as Record<string, unknown>)).toEqual([
    "consentNonce",
  ]);
  expect(f.requests[0].body).toEqual({});
  await client.close();
  expect(f.requests.at(-1)?.path).toBe(
    `/api/v1/voice/speech/session/${client.sessionId}/revoke`,
  );
});
test("cancel never replays a context and ignores its delayed audio, while owner changes block further dispatch", async () => {
  const f = await fixture(),
    client = await createCloudSpeechRelayPorts(f.options);
  let frames = 0;
  const stream = client.speechPorts.tts.createStream(
    { traceId: "trace", maxBufferDelayMs: 250 },
    { onAudioFrame: () => frames++ },
  );
  stream.sendPhrase({ text: "Hello", continueContext: true });
  await until(() => f.controls.some((c) => c.t === "tts"));
  stream.cancel();
  await stream.closed;
  const sent = f.controls.find((c) => c.t === "tts");
  if (!sent) throw Error("Expected TTS dispatch");
  const id = sent.id as string;
  f.sockets[0].send(encodeSpeechRelayAudio(id, new Uint8Array([8, 8])));
  await sleep(10);
  const count = f.controls.filter((c) => c.t === "tts").length;
  expect(() =>
    stream.sendPhrase({ text: "Replay", continueContext: false }),
  ).toThrow();
  expect(f.controls.filter((c) => c.t === "tts")).toHaveLength(count);
  f.changeOwner();
  expect(() =>
    client.speechPorts.tts.createStream(
      { traceId: "next", maxBufferDelayMs: 250 },
      {},
    ),
  ).toThrow("owner changed");
  await client.close();
  expect(f.requests.filter((r) => r.path.endsWith("/revoke"))).toHaveLength(1);
  expect(frames).toBeLessThanOrEqual(1);
});
test("disabled mode and unsafe origin fail before credential or network access; foreign/expired/expanded mint never connects", async () => {
  let credentials = 0;
  const options = {
    origin: "https://api-staging.eliza.app",
    credential: async () => {
      credentials++;
      return "secret";
    },
    assertCurrent() {},
  };
  await expect(createCloudSpeechRelayPorts(options)).rejects.toMatchObject({
    code: "disabled",
  });
  for (const origin of [
    "http://other.invalid",
    "https://api.eliza.app/path",
    "https://user:password@api.eliza.app",
    "https://api.eliza.app/?redirect=bad",
  ])
    await expect(
      createCloudSpeechRelayPorts({ ...options, enabled: true, origin }),
    ).rejects.toThrow();
  expect(credentials).toBe(0);
  for (const mode of ["foreign", "expired", "extra"]) {
    const f = await fixture();
    f.mode(mode);
    await expect(createCloudSpeechRelayPorts(f.options)).rejects.toThrow();
    expect(f.connections).toBe(0);
    expect(
      f.requests.every((r) => r.path.startsWith("/api/v1/voice/speech/")),
    ).toBe(true);
  }
});
test("HTTP redirects are refused without leaking credentials or retrying admission", async () => {
  const f = await fixture();
  f.mode("redirect");
  await expect(createCloudSpeechRelayPorts(f.options)).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  expect(f.connections).toBe(0);
});

test("abort during the one-shot hello closes its socket and revokes the minted session without retry", async () => {
  const f = await fixture(),
    abort = new AbortController();
  f.mode("hold-ready");
  const pending = createCloudSpeechRelayPorts({
    ...f.options,
    signal: abort.signal,
  });
  await until(() => f.controls.some((c) => c.t === "hello"));
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(f.connections).toBe(1);
  expect(f.requests.filter((r) => r.path.endsWith("/session"))).toHaveLength(1);
  expect(f.requests.filter((r) => r.path.endsWith("/revoke"))).toHaveLength(1);
});
test("expiry and malformed provider frames retire active contexts and never reopen or emit later audio", async () => {
  for (const mode of ["short", "malformed"]) {
    const f = await fixture();
    if (mode === "short") f.mode(mode);
    const client = await createCloudSpeechRelayPorts(f.options),
      events: unknown[] = [];
    client.speechPorts.openStt((event) => events.push(event));
    const stream = client.speechPorts.tts.createStream(
      { traceId: "local", maxBufferDelayMs: 250 },
      {},
    );
    stream.sendPhrase({ text: "Hello", continueContext: true });
    if (mode === "malformed")
      f.send({
        t: "stt",
        event: {
          type: "transcript-update",
          transcript: "untrusted",
          raw: { secret: "never-accept" },
        },
      });
    await expect(stream.closed).rejects.toThrow();
    expect(() =>
      stream.sendPhrase({ text: "Retry", continueContext: false }),
    ).toThrow();
    expect(f.connections).toBe(1);
    expect(
      events.some((event) => (event as { type: string }).type === "error"),
    ).toBe(true);
    await client.close();
  }
});

test("canonical LOCAL VoiceSession consumes relay speech ports without any Cloud agent or model request", async () => {
  const f = await fixture();
  f.mode("hold-speech");
  const client = await createCloudSpeechRelayPorts(f.options),
    control: ServerControlFrame[] = [],
    audio: Uint8Array[] = [],
    localRequests: string[] = [],
    lifecycle: string[] = [];
  const runtime = await listenLoopbackHttp((request) => {
    localRequests.push(new URL(request.url).pathname);
    expect(request.headers.get("authorization")).toBeNull();
    return new Response(
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
        "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  cleanups.push(() => runtime.close());
  const session = new VoiceSession({
    sessionId: crypto.randomUUID(),
    jti: crypto.randomUUID(),
    organizationId: "local-org",
    userId: "local-user",
    agentId: "local-agent",
    conversationId: "local-conversation",
    tokenExpSeconds: Math.floor(client.expiresAt / 1000),
    speechProvider: "injected",
    speechPorts: client.speechPorts,
    elizaEndpoint: "https://not-a-cloud-agent.invalid",
    elizaAuthorization: "must-not-reach-local",
    elizaModel: "local-model",
    fetchImpl: createLocalRuntimeConversationFetch(runtime.url.origin, {
      agentId: "local-agent",
      conversationId: "local-conversation",
    }),
    usageStore: new InMemoryVoiceUsageStore(),
    usageLimits: { organizationDailyMinutes: 10, userDailyMinutes: 10 },
    initialUsageAdmissionMinutes: 1 / 12,
    registry: createVoiceSessionRegistry(),
    downlink: {
      sendControl: (frame) => {
        control.push(frame);
        lifecycle.push(frame.t);
      },
      sendAudio: (bytes) => {
        audio.push(bytes);
        lifecycle.push("audio");
      },
      close() {},
    },
  });
  cleanups.push(() => session.bye());
  session.start();
  f.send({ t: "stt", event: { type: "start-of-turn", transcript: "" } });
  f.send({
    t: "stt",
    event: { type: "transcript-update", transcript: "open notes" },
  });
  f.send({
    t: "stt",
    event: { type: "end-of-turn", transcript: "open notes" },
  });
  await until(() => control.some((frame) => frame.t === "reply_complete"));
  expect(control.some((frame) => frame.t === "stt_partial")).toBe(true);
  expect(control.some((frame) => frame.t === "stt_final")).toBe(true);
  expect(
    control
      .filter((frame) => frame.t === "navigate_view")
      .map((frame) => frame.viewId),
  ).toEqual(["notes"]);
  // A durable local reply/navigation receipt is not a speech-completion receipt.
  // Keep the actual relay frames gated so the Linux event-loop order is explicit.
  await until(() => f.controls.some((frame) => frame.t === "finish"));
  expect(
    f.controls.filter((frame) => frame.t === "tts").map((frame) => frame.text),
  ).toEqual(["You are on Notes."]);
  expect(f.controls.filter((frame) => frame.t === "finish")).toHaveLength(1);
  expect(audio).toHaveLength(0);
  expect(control.some((frame) => frame.t === "speaking_end")).toBe(false);
  f.releaseSpeech();
  await until(() => control.some((frame) => frame.t === "speaking_end"));
  expect(audio.map((bytes) => Array.from(bytes))).toEqual([[1, 2, 3, 4]]);
  const reply = control.find((frame) => frame.t === "reply_complete");
  const started = control.filter((frame) => frame.t === "speaking_start");
  const ended = control.filter((frame) => frame.t === "speaking_end");
  expect(started).toHaveLength(1);
  expect(ended).toHaveLength(1);
  if (!reply?.traceId) throw Error("Expected committed reply trace");
  expect(started[0].traceId).toBe(reply.traceId);
  expect(ended[0].traceId).toBe(reply.traceId);
  expect(lifecycle.indexOf("reply_complete")).toBeLessThan(
    lifecycle.indexOf("audio"),
  );
  expect(lifecycle.indexOf("speaking_start")).toBeLessThan(
    lifecycle.indexOf("audio"),
  );
  expect(lifecycle.indexOf("audio")).toBeLessThan(
    lifecycle.indexOf("speaking_end"),
  );
  expect(localRequests).toEqual([
    "/api/conversations/local-conversation/messages/stream",
  ]);
  expect(
    f.requests.every((request) =>
      request.path.startsWith("/api/v1/voice/speech/"),
    ),
  ).toBe(true);
  session.bye();
  await client.close();
});

test("an owner mismatch on uplink retires active paid speech before forwarding another frame", async () => {
  const f = await fixture(),
    client = await createCloudSpeechRelayPorts(f.options);
  const stt = client.speechPorts.openStt(() => {}),
    stream = client.speechPorts.tts.createStream(
      { traceId: "local", maxBufferDelayMs: 250 },
      {},
    );
  stream.sendPhrase({ text: "Hello", continueContext: true });
  await until(() => f.controls.some((c) => c.t === "tts"));
  f.changeOwner();
  expect(() => stt.sendAudioChunk(new Uint8Array(3200))).toThrow(
    "owner changed",
  );
  await expect(stream.closed).rejects.toThrow();
  expect(f.pcm).toHaveLength(0);
  await client.close();
});

test("retirement survives owner removal during its response and remains bound, bounded and once-only", async () => {
  const f = await fixture();
  let retirements = 0;
  const client = await createCloudSpeechRelayPorts({
    ...f.options,
    fetch: Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (new URL(String(input)).pathname.endsWith("/revoke")) {
          retirements++;
          expect(String(input)).toBe(
            `${f.server.url.origin}/api/v1/voice/speech/session/${client.sessionId}/revoke`,
          );
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer server-account-secret",
          );
          expect(init?.method).toBe("POST");
          expect(init?.redirect).toBe("error");
          expect(init?.signal?.aborted).toBe(false);
          f.changeOwner();
        }
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const stt = client.speechPorts.openStt(() => {});
  await Promise.all([client.close(), client.close()]);
  expect(retirements).toBe(1);
  expect(() => stt.sendAudioChunk(new Uint8Array(3200))).toThrow();
  expect(f.pcm).toHaveLength(0);
  expect(f.connections).toBe(1);
  expect(f.requests.filter((r) => r.path.endsWith("/revoke"))).toHaveLength(1);
});

test("failed retirement remains unconfirmed and never retries the captured credential or session", async () => {
  const f = await fixture();
  let retirements = 0;
  const client = await createCloudSpeechRelayPorts({
    ...f.options,
    fetch: Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (new URL(String(input)).pathname.endsWith("/revoke")) {
          retirements++;
          return Response.json({ revoked: false }, { status: 503 });
        }
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  f.changeOwner();
  const first = client.close();
  expect(client.close()).toBe(first);
  await expect(first).rejects.toThrow("retirement was not confirmed");
  expect(retirements).toBe(1);
  expect(f.connections).toBe(1);
  expect(f.pcm).toHaveLength(0);
});

test("startup timings and fake remote close preserve public code and PCM counters without private canaries", async () => {
  const f = await fixture(),
    slot: { socket?: WebSocket } = {};
  const client = await createCloudSpeechRelayPorts({
    ...f.options,
    websocket(url) {
      const socket = new WebSocket(url);
      slot.socket = socket;
      return socket;
    },
  });
  const stt = client.speechPorts.openStt(() => {});
  stt.sendAudioChunk(new Uint8Array(3200));
  const stream = client.speechPorts.tts.createStream(
    { traceId: "private-trace-canary", maxBufferDelayMs: 250 },
    {},
  );
  stream.sendPhrase({ text: "private-text-canary", continueContext: false });
  await stream.closed;
  await until(() => f.diagnostics.some((x) => x.stage === "stt_connected"));
  const startup = f.diagnostics.filter((x) => x.cause === "startup");
  expect(startup.map((x) => x.stage)).toEqual([
    "consent_post",
    "mint_post",
    "websocket_connect",
    "relay_ready",
    "stt_connected",
  ]);
  expect(
    startup.every((x) => typeof x.durationMs === "number" && x.durationMs >= 0),
  ).toBe(true);
  expect(startup.filter((x) => x.httpStatus === 200)).toHaveLength(2);
  expect(new Set(startup.map((x) => x.diagnosticId)).size).toBe(1);
  const socket = slot.socket;
  if (!socket) throw Error("Missing controlled socket");
  socket.dispatchEvent(
    new CloseEvent("close", {
      code: 1006,
      wasClean: false,
      reason:
        "PRIVATE_REASON_CANARY https://secret.invalid/?token=PRIVATE_TOKEN_CANARY",
    }),
  );
  const close = f.diagnostics.find((x) => x.cause === "socket_close");
  expect(close).toMatchObject({
    phase: "live",
    closeCode: 1006,
    wasClean: false,
    pcmSampleRateHz: 16000,
    sentPcmBytes: 3200,
    sentPcmFrames: 1,
    receivedPcmBytes: 4,
    receivedPcmFrames: 1,
  });
  expect(close?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(close?.liveElapsedMs).toBeGreaterThanOrEqual(0);
  const logs = JSON.stringify(f.diagnostics);
  for (const secret of [
    "PRIVATE_REASON_CANARY",
    "PRIVATE_TOKEN_CANARY",
    "secret.invalid",
    "private-trace-canary",
    "private-text-canary",
    "server-account-secret",
    "one-use-speech-token",
    client.sessionId,
    f.server.url.origin,
  ])
    expect(logs).not.toContain(secret);
  await client.close();
  expect(f.connections).toBe(1);
});

test("only recognized scalar wire codes enter diagnostics; malformed private frames stay private", async () => {
  for (const code of [
    "unauthorized",
    "protocol",
    "unavailable",
    "closed",
    "PRIVATE_WIRE_CANARY",
    ["closed"],
  ] as const) {
    const f = await fixture(),
      client = await createCloudSpeechRelayPorts(f.options);
    client.speechPorts.openStt(() => {});
    f.send({ t: "error", code });
    await until(() =>
      f.diagnostics.some((x) => x.cause === "message_rejected"),
    );
    const recognized =
      typeof code === "string" && code !== "PRIVATE_WIRE_CANARY";
    expect(f.diagnostics.some((x) => x.cause === "wire_error")).toBe(
      recognized,
    );
    if (recognized)
      expect(
        f.diagnostics.find((x) => x.cause === "wire_error")?.wireCode,
      ).toBe(code);
    expect(JSON.stringify(f.diagnostics)).not.toContain("PRIVATE_WIRE_CANARY");
    expect(
      f.diagnostics.filter((x) => x.cause !== "startup").length,
    ).toBeLessThanOrEqual(4);
    await client.close();
    expect(f.connections).toBe(1);
  }
});

test("throwing diagnostic sink neither blocks startup nor changes teardown or retries", async () => {
  const f = await fixture();
  let calls = 0;
  const client = await createCloudSpeechRelayPorts({
    ...f.options,
    logger: {
      warn() {
        calls++;
        throw Error("PRIVATE_LOGGER_CANARY");
      },
    },
  });
  const stt = client.speechPorts.openStt(() => {});
  stt.sendAudioChunk(new Uint8Array(3200));
  await until(() => f.pcm.length === 1);
  await Promise.all([client.close(), client.close()]);
  expect(calls).toBeGreaterThanOrEqual(4);
  expect(calls).toBeLessThanOrEqual(9);
  expect(f.requests.filter((x) => x.path.endsWith("/revoke"))).toHaveLength(1);
  expect(f.connections).toBe(1);
});

test("bootstrap refusal records only its static HTTP stage and public status before any socket", async () => {
  const f = await fixture();
  let sockets = 0;
  await expect(
    createCloudSpeechRelayPorts({
      ...f.options,
      fetch: Object.assign(
        async () =>
          Response.json({ error: "PRIVATE_HTTP_BODY_CANARY" }, { status: 503 }),
        { preconnect: fetch.preconnect },
      ),
      websocket() {
        sockets++;
        throw Error("No socket on refused consent");
      },
    }),
  ).rejects.toMatchObject({ code: "transport" });
  expect(f.diagnostics).toHaveLength(1);
  expect(f.diagnostics[0]).toMatchObject({
    cause: "startup",
    phase: "bootstrap",
    stage: "consent_post",
    httpStatus: 503,
    outcome: "failed",
    sentPcmBytes: 0,
    receivedPcmBytes: 0,
    liveElapsedMs: null,
  });
  expect(JSON.stringify(f.diagnostics)).not.toContain(
    "PRIVATE_HTTP_BODY_CANARY",
  );
  expect(sockets).toBe(0);
  expect(f.requests).toHaveLength(0);
});

test("HTTP bootstrap diagnostics preserve only fixed Server-Timing durations and separate body drain", async () => {
  const f = await fixture();
  const ports = await createCloudSpeechRelayPorts({
    ...f.options,
    fetch: Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const response = await fetch(...args);
        if (!String(args[0]).endsWith("/consent")) return response;
        const text = await response.text();
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(text));
                controller.close();
              }, 25);
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "server-timing":
                'entry_dispatch;dur=30;desc="PRIVATE_HEADER_CANARY",cloud_worker;dur=20,foreign;dur=999',
            },
          },
        );
      },
      { preconnect() {} },
    ),
  });
  const consent = f.diagnostics.find((x) => x.stage === "consent_post");
  expect(consent?.serverTimingMs).toEqual({
    entry_dispatch: 30,
    cloud_worker: 20,
  });
  expect(consent?.responseHeadersMs).toBeGreaterThanOrEqual(0);
  expect(consent?.responseBodyMs).toBeGreaterThanOrEqual(20);
  expect(JSON.stringify(f.diagnostics)).not.toContain("PRIVATE_HEADER_CANARY");
  expect(JSON.stringify(f.diagnostics)).not.toContain("foreign");
  await ports.close();
});

test("Cloud proxy opened waits for actual preparation ACK; late ACK after cancel cannot resurrect it", async () => {
  const f = await fixture();
  f.mode("hold-prepare");
  const client = await createCloudSpeechRelayPorts(f.options);
  let opened = false;
  const stream = client.speechPorts.tts.createStream(
    { contextId: "ignored" },
    {},
  );
  void stream.opened
    .then(() => {
      opened = true;
    })
    .catch(() => {});
  await until(() => f.controls.some((c) => c.t === "prepare"));
  expect(opened).toBe(false);
  expect(f.controls.some((c) => c.t === "tts")).toBe(false);
  const prepare = f.controls.find((c) => c.t === "prepare");
  if (!prepare) throw Error("Missing prepare frame");
  f.send({ t: "tts_prepared", id: prepare.id });
  await until(() => opened);
  stream.cancel();
  await client.close();
});
test("Stop, owner replacement and expiry before prepare ACK reject readiness without another admission", async () => {
  for (const mode of ["cancel", "owner", "stop"]) {
    const f = await fixture();
    f.mode("hold-prepare");
    const client = await createCloudSpeechRelayPorts(f.options);
    const stream = client.speechPorts.tts.createStream({}, {});
    let opened = false;
    void stream.opened
      .then(() => {
        opened = true;
      })
      .catch(() => {});
    await until(() => f.controls.some((c) => c.t === "prepare"));
    const p = f.controls.find((c) => c.t === "prepare");
    if (!p) throw Error("Missing prepare frame");
    if (mode === "cancel") stream.cancel();
    else if (mode === "owner") {
      f.changeOwner();
      expect(() =>
        stream.sendPhrase({ text: "late", continueContext: false }),
      ).toThrow();
    } else await client.close();
    await expect(stream.opened).rejects.toBeInstanceOf(Error);
    if (mode === "cancel") f.send({ t: "tts_prepared", id: p.id });
    await sleep(5);
    expect(opened).toBe(false);
    expect(f.requests.filter((r) => r.path.endsWith("/session"))).toHaveLength(
      1,
    );
    await client.close().catch(() => {});
  }
});
test("lease expiry while provider preparation is pending rejects opened and cannot remint", async () => {
  const f = await fixture();
  f.mode("short");
  const client = await createCloudSpeechRelayPorts(f.options);
  f.mode("hold-prepare");
  const stream = client.speechPorts.tts.createStream({}, {});
  let opened = false;
  void stream.opened
    .then(() => {
      opened = true;
    })
    .catch(() => {});
  await until(() => f.controls.some((c) => c.t === "prepare"));
  await expect(stream.opened).rejects.toBeInstanceOf(Error);
  expect(opened).toBe(false);
  expect(f.connections).toBe(1);
  expect(f.requests.filter((r) => r.path.endsWith("/session"))).toHaveLength(1);
  await client.close().catch(() => {});
});

test("bootstrap diagnostics retain only validated Cloud HTTP trace IDs for each consent and mint", async () => {
  const f = await fixture();
  const ports = await createCloudSpeechRelayPorts({
    ...f.options,
    fetch: Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const response = await fetch(...args);
        const headers = new Headers(response.headers);
        const route = new URL(String(args[0])).pathname;
        if (route.endsWith("/consent"))
          headers.set("X-Eliza-Trace-Id", "a".repeat(32));
        else if (route.endsWith("/session"))
          headers.set("X-Eliza-Trace-Id", "b".repeat(32));
        headers.set("X-Vendor-Secret", "PRIVATE_HEADER_CANARY");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      },
      { preconnect() {} },
    ),
  });
  expect(
    f.diagnostics
      .filter((row) => ["consent_post", "mint_post"].includes(row.stage ?? ""))
      .map((row) => ({ stage: row.stage, trace: row.httpTraceId })),
  ).toEqual([
    { stage: "consent_post", trace: "a".repeat(32) },
    { stage: "mint_post", trace: "b".repeat(32) },
  ]);
  expect(JSON.stringify(f.diagnostics)).not.toContain("PRIVATE_HEADER_CANARY");
  expect(JSON.stringify(f.diagnostics)).not.toContain("server-account-secret");
  expect(JSON.stringify(f.diagnostics)).not.toContain("one-use-speech-token");
  await ports.close();
});

test("missing, invalid and throwing HTTP trace headers stay absent without altering refusal", async () => {
  for (const value of [
    undefined,
    "",
    "A".repeat(32),
    "a".repeat(31),
    "a".repeat(33),
    `${"a".repeat(32)},${"b".repeat(32)}`,
    "PRIVATE_TRACE_HEADER_CANARY",
    "throw-getter",
  ]) {
    const f = await fixture();
    let calls = 0;
    await expect(
      createCloudSpeechRelayPorts({
        ...f.options,
        fetch: Object.assign(
          async () => {
            calls++;
            const response = Response.json(
              { error: "PRIVATE_BODY_CANARY" },
              {
                status: 503,
                headers:
                  value === undefined ? {} : { "X-Eliza-Trace-Id": value },
              },
            );
            if (value === "throw-getter") {
              const get = response.headers.get.bind(response.headers);
              Object.defineProperty(response.headers, "get", {
                value: (name: string) => {
                  if (name.toLowerCase() === "x-eliza-trace-id")
                    throw Error("PRIVATE_GETTER_CANARY");
                  return get(name);
                },
              });
            }
            return response;
          },
          { preconnect() {} },
        ),
      }),
    ).rejects.toMatchObject({ code: "transport" });
    expect(calls).toBe(1);
    expect(f.diagnostics).toHaveLength(1);
    expect(Object.hasOwn(f.diagnostics[0], "httpTraceId")).toBe(false);
    expect(f.diagnostics[0]).toMatchObject({
      stage: "consent_post",
      httpStatus: 503,
      outcome: "failed",
    });
    expect(JSON.stringify(f.diagnostics)).not.toMatch(
      /PRIVATE_(?:BODY|GETTER|TRACE_HEADER)_CANARY/,
    );
    expect(f.connections).toBe(0);
  }
});

test("HTTP trace capture precedes body cancellation and cannot mask original failures even when logging throws", async () => {
  for (const failure of ["cancel", "fetch"]) {
    const f = await fixture();
    const original = Error("PRIVATE_ORIGINAL_FAILURE");
    let calls = 0;
    await expect(
      createCloudSpeechRelayPorts({
        ...f.options,
        logger: {
          warn(row) {
            f.diagnostics.push(
              row as unknown as CloudSpeechRelayTransportDiagnostic,
            );
            throw Error("PRIVATE_LOGGER_FAILURE");
          },
        },
        fetch: Object.assign(
          async () => {
            calls++;
            if (failure === "fetch") throw original;
            return new Response(
              new ReadableStream({
                cancel() {
                  throw original;
                },
              }),
              { status: 503, headers: { "X-Eliza-Trace-Id": "c".repeat(32) } },
            );
          },
          { preconnect() {} },
        ),
      }),
    ).rejects.toBe(original);
    expect(calls).toBe(1);
    expect(f.diagnostics).toHaveLength(1);
    expect(f.diagnostics[0]?.httpTraceId).toBe(
      failure === "cancel" ? "c".repeat(32) : undefined,
    );
    expect(f.diagnostics[0]?.outcome).toBe("failed");
    expect(JSON.stringify(f.diagnostics)).not.toContain("PRIVATE_");
    expect(f.connections).toBe(0);
  }
});

test("pre-ready admission errors retain only the validated public wire code and send no PCM", async () => {
  const f = await fixture();
  f.mode("reject-ready");
  await expect(createCloudSpeechRelayPorts(f.options)).rejects.toThrow();
  expect(
    f.diagnostics.some(
      (event) =>
        event.cause === "wire_error" && event.wireCode === "unavailable",
    ),
  ).toBe(true);
  expect(f.diagnostics.some((event) => event.stage === "relay_ready")).toBe(
    false,
  );
  expect(f.pcm).toHaveLength(0);
});

test("negotiated insufficient credits stop before PCM with a public billing reason", async () => {
  const f = await fixture();
  f.mode("reject-credit");
  await expect(createCloudSpeechRelayPorts(f.options)).rejects.toMatchObject({
    code: "insufficient_credits",
    message:
      "Voice needs more Eliza Cloud credits. Add credits, then try again.",
  });
  expect(f.controls.find((frame) => frame.t === "hello")).toMatchObject({
    errorReasons: true,
  });
  expect(f.pcm).toHaveLength(0);
  expect(f.connections).toBe(1);
});
