import { expect, test } from "vitest";
import {
  createSpeechRelaySession,
  parseSpeechRelayControl,
  SPEECH_RELAY_BUDGET,
  type SpeechRelayIdentity,
  type SpeechRelayPorts,
} from "./speech-relay-session";
import { InMemoryVoiceUsageStore } from "./usage";

const identity: SpeechRelayIdentity = {
  organizationId: "org-a",
  userId: "user-a",
  cloudSessionId: "session-a",
};
const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
function harness(overrides: Partial<SpeechRelayPorts> = {}) {
  const order: string[] = [],
    events: unknown[] = [],
    settled: unknown[] = [],
    closures: Promise<void>[] = [];
  let now = 1_000,
    current = true,
    revoke = () => {},
    sttEvent: Parameters<SpeechRelayPorts["openStt"]>[0],
    ttsCallbacks: Parameters<SpeechRelayPorts["openTts"]>[1];
  const usage = new InMemoryVoiceUsageStore(() => now),
    release = usage.release.bind(usage);
  usage.release = async (...args) => {
    order.push("quota-release");
    return release(...args);
  };
  const ports: SpeechRelayPorts = {
    enabled: true,
    now: () => now,
    usageStore: usage,
    usageLimits: { organizationDailyMinutes: 5, userDailyMinutes: 5 },
    assertCurrent: (scope) => {
      expect(scope).toEqual(identity);
      if (!current) throw Error("owner changed");
    },
    consumeConsent: async (scope) => {
      expect(scope).toEqual(identity);
      order.push("consent");
      return true;
    },
    reserveCredits: async (scope, budget) => {
      expect(scope).toEqual(identity);
      expect(budget).toBe(SPEECH_RELAY_BUDGET);
      order.push("credits");
      return {
        beforeProviderDispatch: async () => {},
        settle: async (receipt) => {
          order.push("settle");
          settled.push(receipt);
        },
      };
    },
    subscribeRevoked: (_scope, callback) => {
      revoke = callback;
      return () => order.push("unsubscribe");
    },
    openStt: (callback) => {
      order.push("stt-open");
      sttEvent = callback;
      return {
        sendAudioChunk: () => order.push("stt-audio"),
        cancel: () => order.push("stt-cancel"),
      };
    },
    openTts: (_id, callbacks) => {
      order.push("tts-open");
      ttsCallbacks = callbacks;
      return {
        sendPhrase: () => order.push("tts-phrase"),
        finish: () => order.push("tts-finish"),
        cancel: () => order.push("tts-cancel"),
      };
    },
    emit: (event) => events.push(event),
    onClosed: (promise) => {
      closures.push(promise);
      void promise.catch(() => {});
    },
    ...overrides,
  };
  return {
    ports,
    order,
    events,
    settled,
    closures,
    open: () => createSpeechRelaySession(identity, "consent", ports),
    revoke: () => revoke(),
    replace: () => (current = false),
    advance: (ms: number) => (now += ms),
    stt: (event: Parameters<Parameters<SpeechRelayPorts["openStt"]>[0]>[0]) =>
      sttEvent(event),
    audio: (bytes: Uint8Array) => ttsCallbacks.audio(bytes),
    complete: () => ttsCallbacks.complete(),
  };
}
test("disabled by default; no auth, consent, quota, credit or provider side effect", async () => {
  const f = harness({ enabled: undefined });
  await expect(f.open()).rejects.toMatchObject({ code: "disabled" });
  expect(f.order).toEqual([]);
});
test("account-bound consent and credits finish before either provider opens; no agent row exists", async () => {
  const f = harness(),
    session = await f.open();
  expect(f.order).toEqual(["consent", "credits", "stt-open"]);
  await session.control({ t: "tts", id: "phrase-1", text: "hello" });
  expect(f.order.slice(-2)).toEqual(["tts-open", "tts-phrase"]);
  await session.control({ t: "finish", id: "phrase-1" });
  expect(f.order.at(-1)).toBe("tts-finish");
  await session.close();
  expect(f.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 5,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: true },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "unknown" },
    },
  ]);
});
test("consent rejection, quota exhaustion and credit rejection never dispatch a provider", async () => {
  for (const mode of ["consent", "quota", "credits"]) {
    const f = harness(
      mode === "consent"
        ? { consumeConsent: async () => false }
        : mode === "quota"
          ? {
              usageLimits: {
                organizationDailyMinutes: 0.5,
                userDailyMinutes: 0.5,
              },
            }
          : {
              reserveCredits: async () => {
                throw Error("insufficient credits");
              },
            },
    );
    await expect(f.open()).rejects.toBeDefined();
    expect(f.order).not.toContain("stt-open");
    expect(f.order).not.toContain("tts-open");
    if (mode === "credits") expect(f.order).toContain("quota-release");
  }
});
test("replacement during asynchronous credit reservation settles without provider dispatch", async () => {
  let release!: (
    value: Awaited<ReturnType<SpeechRelayPorts["reserveCredits"]>>,
  ) => void;
  const f = harness({
      reserveCredits: () => new Promise((resolve) => (release = resolve)),
    }),
    pending = f.open();
  await tick();
  f.replace();
  release({
    beforeProviderDispatch: async () => {},
    settle: async (value: unknown) => f.settled.push(value),
  });
  await expect(pending).rejects.toThrow("owner changed");
  expect(f.order).not.toContain("stt-open");
  expect(f.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 0,
      providerMayHaveStarted: false,
      dispatched: { stt: false, tts: false },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "complete" },
    },
  ]);
  expect(f.order).toContain("quota-release");
});
test("strict controls reject account, provider URL, model, record parameters and extra keys", () => {
  for (const frame of [
    { t: "tts", id: "x", text: "hello", userId: "other" },
    { t: "tts", id: "x", text: "hello", url: "https://evil.test" },
    { t: "agent", id: "x", text: "hello" },
    { t: "stop", agentId: "x" },
    { t: "tts", id: "x", text: "x".repeat(1025) },
    { t: "cancel", id: "../escape" },
  ])
    expect(() => parseSpeechRelayControl(frame)).toThrow();
});
test("invalid PCM shape, oversized frame and excessive observed byte rate retire before forwarding", async () => {
  for (const bytes of [
    new Uint8Array(3),
    new Uint8Array(3202),
    "not bytes" as unknown as Uint8Array,
  ]) {
    const f = harness(),
      s = await f.open();
    expect(() => s.sendPcm(bytes)).toThrow();
    await s.close();
    expect(f.order).not.toContain("stt-audio");
  }
  const f = harness(),
    s = await f.open();
  for (let i = 0; i < 10; i++) s.sendPcm(new Uint8Array(3200));
  expect(() => s.sendPcm(new Uint8Array(3200))).toThrow();
  await s.close();
  expect(f.settled).toEqual([
    {
      pcmBytes: 32000,
      ttsCharacters: 0,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: false },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "complete" },
    },
  ]);
});
test("raw provider metadata is not emitted; streaming audio is immediate and cancelled contexts drop late frames", async () => {
  const f = harness(),
    s = await f.open();
  f.stt({
    type: "transcript-update",
    transcript: "hello",
    raw: { key: "must not escape" },
  });
  await s.control({ t: "tts", id: "p", text: "hello" });
  f.audio(new Uint8Array([1, 2]));
  expect(f.events).toEqual([
    { t: "stt", event: { type: "transcript-update", transcript: "hello" } },
    { t: "audio", id: "p", bytes: new Uint8Array([1, 2]) },
  ]);
  await s.control({ t: "cancel", id: "p" });
  f.audio(new Uint8Array([3, 4]));
  expect(f.events).toHaveLength(2);
  await s.close();
});
test("revocation cancels STT and TTS, settles once and drops all late frames; no replay", async () => {
  const f = harness(),
    s = await f.open();
  await s.control({ t: "tts", id: "p", text: "hello" });
  f.revoke();
  f.revoke();
  await s.close();
  f.audio(new Uint8Array([1, 2]));
  f.stt({ type: "end-of-turn", transcript: "late" });
  expect(f.events).toEqual([]);
  expect(f.order.filter((v) => v === "stt-cancel")).toHaveLength(1);
  expect(f.order.filter((v) => v === "tts-cancel")).toHaveLength(1);
  expect(f.settled).toHaveLength(1);
  expect(() => s.sendPcm(new Uint8Array(3200))).toThrow();
});
test("expiry and owner replacement reject audio before dispatch and retain ambiguous provider admission", async () => {
  for (const mode of ["expired", "changed"]) {
    const f = harness(),
      s = await f.open();
    if (mode === "expired") f.advance(60000);
    else f.replace();
    expect(() => s.sendPcm(new Uint8Array(3200))).toThrow();
    await s.close();
    expect(f.order).not.toContain("stt-audio");
    expect(f.order).not.toContain("quota-release");
  }
});
test("provider factory ambiguity settles as possibly dispatched; cleanup failures are observable", async () => {
  const f = harness({
    openStt: () => {
      throw Error("upgrade outcome unknown");
    },
  });
  await expect(f.open()).rejects.toThrow("upgrade outcome unknown");
  expect(f.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 0,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: false },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "complete" },
    },
  ]);
  expect(f.order).not.toContain("quota-release");
  const g = harness({
      openStt: () => ({
        sendAudioChunk: () => {},
        cancel: () => {
          throw Error("cannot confirm cancellation");
        },
      }),
    }),
    s = await g.open();
  await expect(s.close()).rejects.toThrow("cleanup was not confirmed");
  expect(g.settled).toHaveLength(1);
});

test("the existing atomic quota store allows only one concurrent session within a one-minute limit", async () => {
  const shared = new InMemoryVoiceUsageStore(),
    limits = { organizationDailyMinutes: 1, userDailyMinutes: 1 };
  const a = harness({ usageStore: shared, usageLimits: limits }),
    b = harness({ usageStore: shared, usageLimits: limits });
  const outcomes = await Promise.allSettled([a.open(), b.open()]);
  expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect(
    [...a.order, ...b.order].filter((row) => row === "stt-open"),
  ).toHaveLength(1);
  expect(
    [...a.order, ...b.order].filter((row) => row === "credits"),
  ).toHaveLength(1);
  for (const outcome of outcomes)
    if (outcome.status === "fulfilled") await outcome.value.close();
});
test("server-observed text and audio-output ceilings stop work without dispatching a bonus phrase", async () => {
  const f = harness(),
    s = await f.open();
  for (let n = 0; n < 4; n++)
    await s.control({ t: "tts", id: `phrase-${n}`, text: "x".repeat(1024) });
  await expect(
    s.control({ t: "tts", id: "bonus", text: "x" }),
  ).rejects.toBeDefined();
  await s.close();
  expect(f.order.filter((row) => row === "tts-open")).toHaveLength(4);
  expect(f.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 4096,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: true },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "unknown" },
    },
  ]);
  const g = harness(),
    t = await g.open();
  await t.control({ t: "tts", id: "p", text: "hello" });
  g.audio(new Uint8Array(65538));
  await t.close();
  expect(g.events).toEqual([]);
  expect(g.order).toContain("tts-cancel");
});
test("missing or extra account identity fields fail before consent or admission", async () => {
  const f = harness();
  await expect(
    createSpeechRelaySession(
      {
        organizationId: "org-a",
        userId: "user-a",
        other: "extra",
      } as unknown as SpeechRelayIdentity,
      "consent",
      f.ports,
    ),
  ).rejects.toMatchObject({ code: "identity" });
  expect(f.order).toEqual([]);
});

test("a durable dispatch marker blocks the provider factory and revocation drops a queued TTS phrase", async () => {
  let releaseStt!: () => void, releaseTts!: () => void;
  const f = harness({
    reserveCredits: async () => ({
      beforeProviderDispatch: (kind) =>
        new Promise<void>((resolve) => {
          if (kind === "stt") releaseStt = resolve;
          else releaseTts = resolve;
        }),
      settle: async (receipt) => {
        f.settled.push(receipt);
      },
    }),
  });
  const opening = f.open();
  await tick();
  expect(f.order).not.toContain("stt-open");
  releaseStt();
  const s = await opening;
  const speech = s.control({ t: "tts", id: "p", text: "hello" });
  await tick();
  expect(f.order).not.toContain("tts-open");
  f.revoke();
  releaseTts();
  await expect(speech).rejects.toThrow("closed");
  await s.close();
  expect(f.order).not.toContain("tts-open");
  expect(f.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 0,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: false },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "complete" },
    },
  ]);
});
test("actual counter settlement needs a trusted shutdown acknowledgement, and failed confirmation stays unknown", async () => {
  const f = harness({ confirmProviderStopped: async () => "complete" }),
    s = await f.open();
  s.sendPcm(new Uint8Array(3200));
  await s.close();
  expect(f.settled).toEqual([
    {
      pcmBytes: 3200,
      ttsCharacters: 0,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: false },
      outcome: "complete",
      outcomes: { stt: "complete", tts: "complete" },
    },
  ]);
  const g = harness({
      confirmProviderStopped: async () => {
        throw Error("no drain ack");
      },
    }),
    t = await g.open();
  await expect(t.close()).rejects.toThrow("cleanup was not confirmed");
  expect(g.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 0,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: false },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "complete" },
    },
  ]);
});

test("canonical Ink semantic events pass with safe fields and one Sonic context accepts phrases, flush and explicit finish", async () => {
  const f = harness(),
    s = await f.open();
  for (const type of [
    "connected",
    "start-of-turn",
    "transcript-update",
    "eager-end-of-turn",
    "turn-resumed",
    "end-of-turn",
  ] as const)
    f.stt(
      type === "connected"
        ? { type, raw: { secret: "strip" } }
        : {
            type,
            transcript: "hello",
            requestId: "turn",
            raw: { secret: "strip" },
          },
    );
  expect(
    f.events.map((row) => (row as { event: { type: string } }).event.type),
  ).toEqual([
    "connected",
    "start-of-turn",
    "transcript-update",
    "eager-end-of-turn",
    "turn-resumed",
    "end-of-turn",
  ]);
  expect(JSON.stringify(f.events)).not.toContain("secret");
  await s.control({
    t: "tts",
    id: "same-turn",
    text: "First sentence.",
    flush: true,
  });
  await s.control({ t: "tts", id: "same-turn", text: "Second sentence." });
  expect(f.order.filter((row) => row === "tts-open")).toHaveLength(1);
  expect(f.order.filter((row) => row === "tts-phrase")).toHaveLength(2);
  expect(f.order).not.toContain("tts-finish");
  await s.control({ t: "finish", id: "same-turn" });
  expect(f.order.filter((row) => row === "tts-finish")).toHaveLength(1);
  f.complete();
  await expect(
    s.control({ t: "tts", id: "same-turn", text: "Cannot reuse" }),
  ).rejects.toBeDefined();
  await s.close();
});

test("each phrase reaches Sonic with only the paid dispatch marker before it", async () => {
  const markers: string[] = [];
  const f = harness({
      reserveCredits: async () => ({
        beforeProviderDispatch: async (kind) => {
          markers.push(kind);
        },
        settle: async () => {},
      }),
    }),
    session = await f.open();
  await session.control({ t: "tts", id: "one", text: "hello " });
  await session.control({ t: "tts", id: "one", text: "world" });
  await session.control({ t: "finish", id: "one" });
  f.complete();
  await session.control({ t: "tts", id: "two", text: " again" });
  expect(markers).toEqual(["stt", "tts", "tts", "tts"]);
  expect(f.order.filter((value) => value === "tts-phrase")).toHaveLength(3);
  await session.close();
});

test("a cancelled context never dispatches its later phrases", async () => {
  const f = harness(),
    session = await f.open();
  await session.control({ t: "tts", id: "turn", text: "first" });
  await session.control({ t: "cancel", id: "turn" });
  // A late phrase for a cancelled context is dropped, not dispatched.
  await session.control({ t: "tts", id: "turn", text: "late" });
  expect(f.order.filter((value) => value === "tts-phrase")).toHaveLength(1);
  await session.close();
});

// cloud-speech-relay-client createStream sends { t: "prepare", id } before any
// text, then tts phrases, then finish or cancel for the same id.
test("a prepare opens one Sonic context before text; its phrases, audio and finish reuse it", async () => {
  const markers: string[] = [];
  const f = harness({
      reserveCredits: async () => ({
        beforeProviderDispatch: async (kind) => {
          markers.push(kind);
        },
        settle: async (receipt) => {
          f.settled.push(receipt);
        },
      }),
    }),
    s = await f.open(),
    id = crypto.randomUUID();
  await s.control({ t: "prepare", id });
  expect(f.order.at(-1)).toBe("tts-open");
  expect(f.order).not.toContain("tts-phrase");
  expect(markers).toEqual(["stt", "tts"]);
  await s.control({ t: "tts", id, text: "Hello there.", flush: true });
  await s.control({ t: "tts", id, text: " Second." });
  f.audio(new Uint8Array([1, 2]));
  await s.control({ t: "finish", id });
  f.complete();
  expect(f.order.filter((row) => row === "tts-open")).toHaveLength(1);
  expect(f.order.filter((row) => row === "tts-phrase")).toHaveLength(2);
  expect(f.order.filter((row) => row === "tts-finish")).toHaveLength(1);
  expect(f.events).toEqual([
    { t: "audio", id, bytes: new Uint8Array([1, 2]) },
    { t: "complete", id },
  ]);
  expect(f.closures).toEqual([]);
  await s.close();
  expect(f.settled).toEqual([
    {
      pcmBytes: 0,
      ttsCharacters: 20,
      providerMayHaveStarted: true,
      dispatched: { stt: true, tts: true },
      outcome: "unknown",
      outcomes: { stt: "unknown", tts: "complete" },
    },
  ]);
});
test("a prepare then finish with no text completes cleanly and spends no text budget", async () => {
  const f = harness(),
    s = await f.open(),
    id = crypto.randomUUID();
  await s.control({ t: "prepare", id });
  await s.control({ t: "finish", id });
  f.complete();
  expect(f.order.slice(-2)).toEqual(["tts-open", "tts-finish"]);
  expect(f.order).not.toContain("tts-phrase");
  expect(f.events).toEqual([{ t: "complete", id }]);
  // The whole text budget is still available after the silent context.
  for (let n = 0; n < 4; n++)
    await s.control({ t: "tts", id: `phrase-${n}`, text: "x".repeat(1024) });
  expect(f.closures).toEqual([]);
  await s.close();
  expect(f.settled).toMatchObject([{ ttsCharacters: 4096 }]);
});
test("cancel or stop after a prepare cancels the idle context and drops its late frames", async () => {
  for (const mode of ["cancel", "stop"] as const) {
    const f = harness(),
      s = await f.open(),
      id = crypto.randomUUID();
    await s.control({ t: "prepare", id });
    await s.control(mode === "cancel" ? { t: "cancel", id } : { t: "stop" });
    if (mode === "cancel") {
      // A late phrase or finish for the cancelled context is dropped.
      expect(await s.control({ t: "tts", id, text: "late" })).toBe(false);
      expect(await s.control({ t: "finish", id })).toBe(false);
      expect(f.closures).toEqual([]);
    }
    await s.close();
    f.audio(new Uint8Array([1, 2]));
    f.complete();
    expect(f.events).toEqual([]);
    expect(f.order.filter((row) => row === "tts-cancel")).toHaveLength(1);
    expect(f.order).not.toContain("tts-phrase");
    expect(f.settled).toMatchObject([{ ttsCharacters: 0 }]);
  }
});
test("a prepare follows the existing context id rules and limits", async () => {
  const f = harness(),
    s = await f.open();
  // A repeated prepare, or text after it, reuses the live context.
  await s.control({ t: "prepare", id: "live" });
  await s.control({ t: "prepare", id: "live" });
  await s.control({ t: "tts", id: "live", text: "hello" });
  expect(f.order.filter((row) => row === "tts-open")).toHaveLength(1);
  await s.control({ t: "finish", id: "live" });
  // A finished context cannot be prepared again.
  await expect(s.control({ t: "prepare", id: "live" })).rejects.toBeDefined();
  await s.close();
  const g = harness(),
    t = await g.open();
  await t.control({ t: "tts", id: "done", text: "hello" });
  g.complete();
  // A completed context cannot be prepared again.
  await expect(t.control({ t: "prepare", id: "done" })).rejects.toBeDefined();
  await t.close();
  const h = harness(),
    u = await h.open();
  for (let n = 0; n < 64; n++) await u.control({ t: "prepare", id: `p-${n}` });
  await expect(u.control({ t: "prepare", id: "p-64" })).rejects.toBeDefined();
  await u.close();
  expect(h.order.filter((row) => row === "tts-open")).toHaveLength(64);
});
test("a durable dispatch marker blocks the prepared provider factory and revocation drops it", async () => {
  let releaseTts!: () => void;
  const f = harness({
    reserveCredits: async () => ({
      beforeProviderDispatch: (kind) =>
        kind === "stt"
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              releaseTts = resolve;
            }),
      settle: async (receipt) => {
        f.settled.push(receipt);
      },
    }),
  });
  const s = await f.open();
  const preparing = s.control({ t: "prepare", id: "p" });
  await tick();
  expect(f.order).not.toContain("tts-open");
  f.revoke();
  releaseTts();
  await expect(preparing).rejects.toThrow("closed");
  await s.close();
  expect(f.order).not.toContain("tts-open");
  expect(f.settled).toMatchObject([{ dispatched: { stt: true, tts: false } }]);
});
