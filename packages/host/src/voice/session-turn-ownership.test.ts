import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import type { CartesiaInkRealtimeEvent } from "./cartesia-ink";
import type { ServerControlFrame } from "./protocol";
import {
  VoiceSession,
  type VoiceSessionConfig,
  type VoiceSessionSpeechPorts,
} from "./session";
import { createVoiceSessionRegistry } from "./session-registry";
import { InMemoryVoiceUsageStore } from "./usage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function until(read: () => boolean) {
  for (let i = 0; i < 200 && !read(); i++) await sleep(5);
  expect(read()).toBe(true);
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// Injected Ink/Sonic ports and a canonical stream the test feeds frame by
// frame, so a turn can be held while the recognizer finalizes noise.
function setup(
  overrides: Partial<VoiceSessionConfig> = {},
  reopenable = false,
) {
  const encoder = new TextEncoder();
  const control: ServerControlFrame[] = [];
  const phrases: string[] = [];
  const signals: AbortSignal[] = [];
  let sttOpened = 0;
  let closed = 0;
  let event!: (value: CartesiaInkRealtimeEvent) => void;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let respond!: (response: Response) => void;
  const ports: VoiceSessionSpeechPorts = {
    ...(reopenable ? { sttReopenable: true } : {}),
    openStt(callback) {
      sttOpened++;
      event = callback;
      return { sendAudioChunk() {}, close() {}, cancel() {} };
    },
    tts: {
      createStream(_options, sink) {
        let resolveClosed!: () => void;
        const streamClosed = new Promise<void>((r) => {
          resolveClosed = r;
        });
        let cancelled = false;
        return {
          opened: Promise.resolve(),
          closed: streamClosed,
          sendPhrase(phrase) {
            phrases.push(phrase.text);
            if (cancelled) return;
            sink.onFirstAudio?.({ elapsedMs: 1 });
            sink.onAudioFrame?.({ bytes: new Uint8Array([1, 2, 3, 4]) });
            if (!phrase.continueContext) {
              sink.onComplete?.({ frameCount: 1 });
              resolveClosed();
            }
          },
          cancel() {
            cancelled = true;
            resolveClosed();
          },
        };
      },
      close() {},
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
    elizaEndpoint: "https://fixture.invalid",
    elizaAuthorization: "fixture-only",
    elizaModel: "local-model",
    fetchImpl: ((_input: unknown, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    }) as typeof fetch,
    usageStore: new InMemoryVoiceUsageStore(),
    usageLimits: { organizationDailyMinutes: 10, userDailyMinutes: 10 },
    initialUsageAdmissionMinutes: 1 / 12,
    registry: createVoiceSessionRegistry(),
    downlink: {
      sendControl: (frame) => control.push(frame),
      sendAudio() {},
      clearAudio() {},
      close: () => closed++,
    },
    ...overrides,
  } as VoiceSessionConfig;
  const session = new VoiceSession(config);
  cleanups.push(() => session.bye());
  return {
    session,
    control,
    phrases,
    signals,
    get sttOpened() {
      return sttOpened;
    },
    get closed() {
      return closed;
    },
    emit: (value: CartesiaInkRealtimeEvent) => event(value),
    open() {
      respond(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
    send(frame: Record<string, unknown>) {
      body.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
    end() {
      body.close();
    },
    frames: (t: ServerControlFrame["t"]) =>
      control.filter((frame) => frame.t === t),
  };
}
type Fixture = ReturnType<typeof setup>;

async function startTurn(f: Fixture, transcript = "open notes") {
  f.session.start();
  f.emit({ type: "connected", raw: {} });
  f.emit({ type: "start-of-turn", transcript: "", raw: {} });
  f.emit({ type: "transcript-update", transcript, raw: {} });
  f.emit({ type: "end-of-turn", transcript, raw: {} });
  await until(() => f.signals.length === 1);
  f.open();
}
const notes = {
  actionName: "VIEWS",
  success: true,
  values: { mode: "open", viewId: "notes" },
};
function finish(f: Fixture, text: string) {
  f.send({ type: "done", text, actionResults: [notes] });
  f.end();
}
function expectOneSpokenTurn(f: Fixture, reply: string) {
  expect(f.signals).toHaveLength(1);
  expect(f.signals[0].aborted).toBe(false);
  expect(f.frames("stt_final")).toHaveLength(1);
  expect(f.frames("interrupted")).toHaveLength(0);
  expect(f.frames("reply_complete")).toHaveLength(1);
  expect(f.frames("usage")).toHaveLength(1);
  expect(f.frames("error")).toHaveLength(0);
  expect(f.phrases.join(" ")).toContain(reply);
  expect(
    f
      .frames("navigate_view")
      .map((frame) => (frame.t === "navigate_view" ? frame.viewId : null)),
  ).toEqual(["notes"]);
}

test("a noise or empty final during a held reply does not take over the turn", async () => {
  for (const noise of ["", "..."]) {
    const f = setup({ acousticBargeInEnabled: true });
    await startTurn(f);
    f.emit({ type: "start-of-turn", transcript: "", raw: {} });
    f.emit({ type: "end-of-turn", transcript: noise, raw: {} });
    await tick();
    finish(f, "You are on Notes.");
    await until(() => f.frames("usage").length > 0);
    expectOneSpokenTurn(f, "You are on Notes.");
    f.session.bye();
  }
});

test("an empty final with continuous handoff queues no overlap turn", async () => {
  const f = setup({ allowContinuousHandoff: true });
  f.session.setAudioCapabilities({
    mode: "continuous_handoff",
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    referenceAwarePlayback: true,
  });
  await startTurn(f);
  for (const noise of ["", "..."]) {
    f.emit({ type: "start-of-turn", transcript: "", raw: {} });
    f.emit({ type: "end-of-turn", transcript: noise, raw: {} });
  }
  await tick();
  finish(f, "You are on Notes.");
  await until(() => f.frames("usage").length > 0);
  await tick();
  expectOneSpokenTurn(f, "You are on Notes.");
});

test("a rewritten final before any speech is spoken in place of the streamed text", async () => {
  const f = setup();
  await startTurn(f);
  f.send({ type: "token", fullText: '{"text":"You' });
  finish(f, "You are on Notes.");
  await until(() => f.frames("usage").length > 0);
  expectOneSpokenTurn(f, "You are on Notes.");
  expect(f.phrases.join(" ")).not.toContain("{");
});

test("a rewritten final after speech started still completes the turn", async () => {
  const f = setup();
  const spoken =
    "Here is a fairly long first sentence about your notes for today. It goes on past the hold. And then";
  await startTurn(f);
  f.send({ type: "token", fullText: spoken });
  await until(() => f.phrases.length > 0);
  f.send({ type: "token", fullText: "Completely different text." });
  finish(f, "Completely different text.");
  await until(() => f.frames("usage").length > 0);
  expectOneSpokenTurn(f, "Here is a fairly long first sentence");
  expect(f.phrases.join(" ")).not.toContain("Completely different");
});

test("injected STT that cannot reopen ends the call on a connect timeout", async () => {
  const f = setup({ sttConnectTimeoutMs: 10, sttReconnectDelaysMs: [0] });
  f.session.start();
  await until(() => f.closed > 0);
  expect(f.frames("error")[0]).toEqual({
    t: "error",
    code: "speech_relay_unavailable",
    retryable: false,
  });
  await sleep(40);
  expect(f.sttOpened).toBe(1);
});

test("injected STT that opts in to reopening reconnects after a timeout", async () => {
  const f = setup({ sttConnectTimeoutMs: 10, sttReconnectDelaysMs: [0] }, true);
  f.session.start();
  await until(() => f.sttOpened > 1);
  expect(f.closed).toBe(0);
  expect(f.frames("error")[0]).toMatchObject({ code: "stt_reconnecting" });
});
