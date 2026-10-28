import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import ts from "typescript";
import { afterEach, expect, test } from "vitest";
import { listenLoopbackHttp } from "../../../app/test/fixtures/loopback-server.ts";
import type { CartesiaInkRealtimeEvent } from "./cartesia-ink";
import { VOICE_STREAM_PROTOCOL } from "./eliza-sse-bridge";
import { createLocalRuntimeConversationFetch } from "./local-runtime-conversation-fetch";
import type { ServerControlFrame } from "./protocol";
import {
  type RealtimeTtsStreamCallbacks,
  VoiceSession,
  type VoiceSessionConfig,
  type VoiceSessionSpeechPorts,
} from "./session";
import { createVoiceSessionRegistry } from "./session-registry";
import { InMemoryVoiceUsageStore } from "./usage";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function until(read: () => boolean) {
  for (let i = 0; i < 100 && !read(); i++) await sleep(5);
  expect(read()).toBe(true);
}
async function setup(prepared = false, bounded = false, selfAdmission = false) {
  let policyClosed = 0;
  const usageStore = new InMemoryVoiceUsageStore();
  const control: ServerControlFrame[] = [],
    audio: Uint8Array[] = [],
    requests: { url: string; headers: Headers; body: unknown }[] = [],
    phrases: string[] = [],
    order: string[] = [];
  let event!: (value: CartesiaInkRealtimeEvent) => void,
    callbacks!: RealtimeTtsStreamCallbacks,
    cancelled = false,
    resolveClosed!: () => void,
    hold = false,
    transportClosed = 0,
    sttCancelled = 0;
  const server = await listenLoopbackHttp(async (request) => {
    requests.push({
      url: request.url,
      headers: request.headers,
      body: await request.json(),
    });
    return new Response(
      "event: done\ndata: " +
        JSON.stringify({
          type: "done",
          userMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          text: "You are on Notes.",
          actionResults: [
            {
              actionName: "VIEWS",
              success: true,
              values: {
                mode: "open",
                viewId: "notes",
                ...(prepared
                  ? {
                      navigationPrepared: true,
                      completedActionHandoffId:
                        "11111111-1111-4111-8111-111111111111",
                      navigationBinding: {
                        requestId: "11111111-1111-4111-8111-111111111111",
                        clientId: "22222222-2222-4222-8222-222222222222",
                        installationId: "33333333-3333-4333-8333-333333333333",
                        viewId: "notes",
                        viewType: "gui",
                      },
                    }
                  : {}),
              },
            },
          ],
        }) +
        "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  cleanups.push(() => server.close());
  const ports: VoiceSessionSpeechPorts = {
    openStt: (callback) => {
      event = callback;
      return {
        sendAudioChunk() {
          order.push("uplink");
        },
        close() {},
        cancel() {
          sttCancelled++;
        },
      };
    },
    tts: {
      createStream(_options, sink) {
        callbacks = sink;
        cancelled = false;
        const closed = new Promise<void>((r) => {
          resolveClosed = r;
        });
        return {
          opened: Promise.resolve(),
          closed,
          sendPhrase(phrase) {
            phrases.push(phrase.text);
            if (!cancelled && !hold) {
              sink.onFirstAudio?.({ elapsedMs: 1 });
              sink.onAudioFrame?.({ bytes: new Uint8Array([1, 2, 3, 4]) });
              if (!phrase.continueContext) {
                sink.onComplete?.({ frameCount: 1 });
                resolveClosed();
              }
            }
          },
          cancel() {
            cancelled = true;
            order.push("cancel");
            resolveClosed();
          },
        };
      },
      close() {
        transportClosed++;
      },
    },
  };
  const config: VoiceSessionConfig = {
    sessionId: crypto.randomUUID(),
    jti: crypto.randomUUID(),
    organizationId: "local-org",
    userId: "local-user",
    agentId: "local-agent",
    conversationId: "local-conversation",
    tokenExpSeconds: Math.floor(Date.now() / 1000) + 120,
    speechProvider: "injected",
    speechPorts: ports,
    elizaEndpoint: "https://not-a-cloud-agent.invalid",
    elizaAuthorization: "must-not-reach-runtime",
    elizaModel: "local-model",
    fetchImpl: createLocalRuntimeConversationFetch(server.url.origin, {
      agentId: "local-agent",
      conversationId: "local-conversation",
    }),
    usageStore,
    usageLimits: { organizationDailyMinutes: 10, userDailyMinutes: 10 },
    ...(selfAdmission ? {} : { initialUsageAdmissionMinutes: 1 / 12 }),
    registry: createVoiceSessionRegistry(),
    downlink: {
      sendControl: (frame) => control.push(frame),
      sendAudio: (bytes) => audio.push(bytes),
      clearAudio: () => order.push("flush"),
      close: () => order.push("close"),
    },
  };
  if (bounded)
    config.modelAttemptPolicy = {
      policyId: "fixture-policy",
      sessionId: config.sessionId,
      userId: config.userId,
      agentId: config.agentId,
      conversationId: config.conversationId,
      close() {
        policyClosed++;
      },
    };
  const session = new VoiceSession(config);
  cleanups.push(() => session.bye());
  return {
    session,
    usageStore,
    get policyClosed() {
      return policyClosed;
    },
    config,
    ports,
    control,
    audio,
    requests,
    phrases,
    order,
    get transportClosed() {
      return transportClosed;
    },
    get sttCancelled() {
      return sttCancelled;
    },
    get cancelled() {
      return cancelled;
    },
    get callbacks() {
      return callbacks;
    },
    hold() {
      hold = true;
    },
    emit(value: CartesiaInkRealtimeEvent) {
      event(value);
    },
  };
}
test("injected Ink/Sonic ports retain partial/final/audio/navigation through the existing LOCAL conversation route", async () => {
  const f = await setup();
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.session.pushUplinkAudio(new Uint8Array(3200));
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "transcript-update", transcript: "open notes", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "open notes", raw: {} });
  await until(() => f.control.some((frame) => frame.t === "reply_complete"));
  expect(
    f.control.some(
      (frame) => frame.t === "stt_partial" && frame.text === "open notes",
    ),
  ).toBe(true);
  expect(
    f.control.some(
      (frame) => frame.t === "stt_final" && frame.text === "open notes",
    ),
  ).toBe(true);
  expect(f.audio.length).toBeGreaterThan(0);
  expect(f.phrases.join(" ")).toContain("You are on Notes.");
  expect(
    f.control
      .filter((frame) => frame.t === "navigate_view")
      .map((frame) => frame.viewId),
  ).toEqual(["notes"]);
  expect(f.requests).toHaveLength(1);
  expect(new URL(f.requests[0].url).pathname).toBe(
    "/api/conversations/local-conversation/messages/stream",
  );
  expect(new URL(f.requests[0].url).hostname).toBe("127.0.0.1");
  expect(f.requests[0].headers.get("authorization")).toBeNull();
  expect(
    (f.requests[0].body as { metadata: Record<string, unknown> }).metadata
      .viewDelivery,
  ).toBeUndefined();
  expect(JSON.stringify(f.control)).not.toContain("must-not-reach-runtime");
  f.session.bye();
  expect(f.transportClosed).toBe(1);
  expect(f.sttCancelled).toBe(1);
});
test("actual playback drain reopens uplink immediately, while stale completion cannot release it", async () => {
  const f = await setup();
  f.config.halfDuplexPlaybackSettleMs = 60_000;
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "open notes", raw: {} });
  await until(() => f.control.some((frame) => frame.t === "usage"));
  const ended = f.control.findLast((frame) => frame.t === "speaking_end");
  if (!ended || ended.t !== "speaking_end")
    throw Error("Missing completed playback");
  const uplinks = () => f.order.filter((value) => value === "uplink").length;
  const before = uplinks();
  f.session.playbackComplete("stale-turn");
  f.session.pushUplinkAudio(new Uint8Array(3200));
  await tick();
  expect(uplinks()).toBe(before);
  f.session.playbackComplete(ended.traceId);
  f.session.pushUplinkAudio(new Uint8Array(3200));
  await tick();
  expect(uplinks()).toBeGreaterThan(before);
});
test("injected speech still uses canonical interruption and ignores late audio after cancellation", async () => {
  const f = await setup();
  f.hold();
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "open notes", raw: {} });
  await until(() => f.phrases.length > 0);
  const before = f.audio.length;
  f.session.bargeIn();
  await tick();
  expect(f.cancelled).toBe(true);
  expect(f.control.some((frame) => frame.t === "interrupted")).toBe(true);
  f.callbacks.onAudioFrame?.({ bytes: new Uint8Array([7, 8]) });
  expect(f.audio.length).toBe(before);
  f.session.bye();
  expect(f.transportClosed).toBe(1);
});
test("injected mode rejects mixed or incomplete providers before any provider opens; default mode remains direct", async () => {
  const f = await setup();
  let opened = 0;
  for (const patch of [
    { speechProvider: undefined },
    { speechProvider: "direct" },
    { speechProvider: "cloud" },
    { cartesiaApiKey: "fake" },
    { fishAudioEnabled: false },
    {
      speechPorts: {
        openStt() {
          opened++;
        },
        tts: {},
      },
    },
  ])
    expect(
      () => new VoiceSession({ ...f.config, ...patch } as VoiceSessionConfig),
    ).toThrow();
  expect(opened).toBe(0);
  const { speechProvider: _, speechPorts: __, ...base } = f.config;
  const direct = new VoiceSession({
    ...base,
    cartesiaApiKey: "synthetic-direct-key",
    cartesiaInkWebSocketFactory: () => {
      opened++;
      throw Error("should not open before start");
    },
    cartesiaVoiceId: "11111111-1111-4111-8111-111111111111",
    cartesiaWebSocketFactory: () => {
      opened++;
      throw Error("should not open before start");
    },
  });
  expect(opened).toBe(0);
  direct.bye();
});

test("explicit completed-action UI context survives actual VoiceSession/SSE/local conversation request", async () => {
  const { parseVoiceUiContext } = await import("../voice");
  const f = await setup();
  const uiContext = parseVoiceUiContext({
    uiClientId: "11111111-1111-4111-8111-111111111111",
    uiBrowserSurface: "native",
    uiViewPath: "/chat",
    viewDelivery: "completed-action",
    agentActionMode: "direct-request-v1",
  });
  expect(uiContext).not.toBeNull();
  if (!uiContext) throw Error("Expected valid UI context");
  f.session.setUiContext(uiContext);
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "fixture navigation", raw: {} });
  await until(() => f.control.some((frame) => frame.t === "reply_complete"));
  const body = f.requests[0].body as { metadata: Record<string, unknown> };
  expect(body.metadata.viewDelivery).toBe("completed-action");
  expect(body.metadata.agentActionMode).toBe("direct-request-v1");
  expect(f.control.find((frame) => frame.t === "reply_complete")).toMatchObject(
    { userMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  );
  expect(body.metadata.uiBrowserSurface).toBe("native");
  const parsedMessage = await parseActualChatPayload(body);
  expect(parsedMessage.metadata.viewDelivery).toBe("completed-action");
  expect(parsedMessage.metadata.agentActionMode).toBe("direct-request-v1");
  expect(parsedMessage.metadata.uiView).toBe("chat");
  expect(body.metadata.clientTransport).toBe("realtime_voice");
  expect(body.metadata.uiClientId).toBeUndefined();
  expect(f.requests[0].headers.get("X-ElizaOS-Client-Id")).toBe(
    uiContext?.uiClientId ?? null,
  );
  expect(f.requests[0].headers.get("authorization")).toBeNull();
  f.session.bye();
});

test("absent delivery retains hosted semantics; unknown delivery is rejected at both actual voice boundaries", async () => {
  const { parseVoiceUiContext } = await import("../voice");
  expect(
    parseVoiceUiContext({ agentActionMode: "direct-request-v1" }),
  ).toBeNull();
  expect(
    parseVoiceUiContext({
      agentActionMode: "anything",
      viewDelivery: "completed-action",
      uiClientId: "11111111-1111-4111-8111-111111111111",
    }),
  ).toBeNull();
  expect(parseVoiceUiContext({ uiBrowserSurface: "native" })).toEqual({
    uiBrowserSurface: "native",
  });
  for (const viewDelivery of [
    "hosted",
    "completed_action",
    true,
    null,
    {},
    "completed-action ",
  ]) {
    expect(parseVoiceUiContext({ viewDelivery })).toBeNull();
    let dispatches = 0;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:12345",
      { agentId: "agent", conversationId: "conversation" },
      (async () => {
        dispatches++;
        throw Error("must not dispatch");
      }) as unknown as typeof fetch,
    );
    await expect(
      bridge(
        "https://fixture.invalid/api/v1/eliza/agents/agent/api/conversations/conversation/messages/stream",
        {
          method: "POST",
          body: JSON.stringify({
            text: "fixture",
            metadata: { clientTransport: "realtime_voice", viewDelivery },
            streamProtocol: VOICE_STREAM_PROTOCOL,
          }),
        },
      ),
    ).rejects.toThrow();
    expect(dispatches).toBe(0);
  }
});

// The existing host route body reader remains the message-parser owner. Exercise
// its actual function and actual registry enrichment; unrelated image/language
// ports are deterministic here so this test does not create a runtime or model.
async function parseActualChatPayload(body: unknown) {
  const text = readFileSync(
    new URL("../../../agent/src/api/chat-routes.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "chat-routes.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const node = ast.statements.find(
    (n) =>
      ts.isFunctionDeclaration(n) && n.name?.text === "readChatRequestPayload",
  );
  if (!node) throw Error("Missing canonical chat payload parser");
  const metadataSource = readFileSync(
    new URL("../../../agent/src/api/chat-view-metadata.ts", import.meta.url),
    "utf8",
  );
  const metadataJs = ts.transpileModule(
    metadataSource.replace(/^import type .*;$/gm, "").replace(/^export /gm, ""),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  const enrich = new Function(
    metadataJs + ";return enrichChatUiViewMetadata;",
  )();
  const js = ts.transpileModule(node.getText(ast).replace(/^export /, ""), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const ports = {
    CHAT_MAX_BODY_BYTES: 1_000_000,
    normalizeIncomingChatPrompt: (text: string) => text.trim(),
    parseRequestChannelType: (type: string) => type,
    ChannelType: { DM: "DM" },
    validateChatImages: () => null,
    readUiLanguageHeader: () => undefined,
    normalizeCharacterLanguage: (v: string) => v,
    enrichChatUiViewMetadata: enrich,
    listViews: () => [
      { id: "chat", path: "/chat", available: true },
      { id: "notes", path: "/notes", available: false },
    ],
    normalizeClientMessageId: (v: unknown) => v,
  };
  const read = new Function(
    ...Object.keys(ports),
    js + ";return readChatRequestPayload;",
  )(...Object.values(ports));
  return read(
    {},
    {},
    {
      runtime: {},
      readJsonBody: async () => body,
      error() {
        throw Error("Unexpected invalid chat payload");
      },
    },
  );
}

test("actual VoiceSession retains prepared binding on its terminal navigation frame", async () => {
  const f = await setup(true);
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "open notes", raw: {} });
  await until(() => f.control.some((frame) => frame.t === "navigate_view"));
  const frame = f.control.find((frame) => frame.t === "navigate_view");
  expect(frame).toMatchObject({
    t: "navigate_view",
    viewId: "notes",
    navigationPrepared: true,
    completedActionHandoffId: "11111111-1111-4111-8111-111111111111",
    navigationBinding: {
      requestId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      installationId: "33333333-3333-4333-8333-333333333333",
      viewId: "notes",
      viewType: "gui",
    },
  });
});

test("actual VoiceSession carries its immutable host trial scope and closes it on Stop", async () => {
  const f = await setup(false, true);
  const original = f.config.sessionId;
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "open notes", raw: {} });
  await until(() => f.control.some((frame) => frame.t === "reply_complete"));
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].headers.get("X-Eliza-Voice-Model-Policy")).toBe(
    "fixture-policy",
  );
  expect(f.requests[0].headers.get("X-Eliza-Voice-Session-Id")).toBe(original);
  expect(JSON.stringify(f.requests[0].body)).not.toContain("fixture-policy");
  expect(f.policyClosed).toBe(0);
  f.session.bye();
  f.session.bye();
  expect(f.policyClosed).toBe(1);
  expect(f.sttCancelled).toBe(1);
  expect(f.transportClosed).toBe(1);
  for (const patch of [
    { sessionId: "foreign" },
    { userId: "foreign" },
    { agentId: "foreign" },
    { conversationId: "foreign" },
  ])
    expect(() => new VoiceSession({ ...f.config, ...patch })).toThrow(
      "verified session",
    );
});

test("barge-in keeps the actual VoiceSession trial scope for the next caller turn", async () => {
  const f = await setup(false, true);
  f.hold();
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "first", raw: {} });
  await until(() => f.phrases.length > 0);
  f.session.bargeIn();
  await tick();
  expect(f.policyClosed).toBe(0);
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "end-of-turn", transcript: "second", raw: {} });
  await until(() => f.requests.length === 2);
  expect(f.policyClosed).toBe(0);
  expect(
    f.requests.map((r) => r.headers.get("X-Eliza-Voice-Session-Id")),
  ).toEqual([f.config.sessionId, f.config.sessionId]);
  f.session.bye();
  expect(f.policyClosed).toBe(1);
});
test("a self-admitted session does not bill the first metering window twice", async () => {
  const f = await setup(false, false, true);
  const identity = { organizationId: "local-org", userId: "local-user" };
  const limits = f.config.usageLimits;
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  // The first chunk triggers the session's own admission charge (one window).
  f.session.pushUplinkAudio(new Uint8Array(3200));
  await until(() => f.order.includes("uplink"));
  // Exactly one metering window of caller audio, already covered by admission.
  for (let i = 0; i < 50; i += 1)
    f.session.pushUplinkAudio(new Uint8Array(3200));
  await sleep(50);
  const probed = await f.usageStore.checkAndRecord(identity, 1e-9, limits);
  if (!probed.allowed) throw Error("usage probe was denied");
  // One admission window (5 s = 1/12 min), not two.
  expect(probed.userUsedMinutes).toBeCloseTo(5 / 60, 6);
  expect(probed.organizationUsedMinutes).toBeCloseTo(5 / 60, 6);
});
