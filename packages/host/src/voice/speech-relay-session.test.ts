import { expect, test, vi } from "vitest";
import {
  createSpeechRelaySession,
  parseSpeechRelayControl,
  SPEECH_RELAY_BUDGET,
  SPEECH_RELAY_RENEW_LEAD_MS,
  type SpeechRelayIdentity,
  type SpeechRelayPorts,
} from "./speech-relay-session";
import { InMemoryVoiceUsageStore } from "./usage";

const identity: SpeechRelayIdentity = {
  organizationId: "org-a",
  userId: "user-a",
  cloudSessionId: "session-a",
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read: () => boolean) => {
  for (let n = 0; n < 100 && !read(); n++) await sleep(5);
  expect(read()).toBe(true);
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
    confirmTtsTransportStopped: async () => "transport_closed",
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
  expect(
    f.settled,
    `queued-before-dispatch receipt=${JSON.stringify(f.settled)}`,
  ).toEqual([
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

const isExtended = (event: unknown) =>
  (event as { t?: unknown }).t === "extended";
/** Opens a two-window session whose renewal fires on the real clock in ~20 ms. */
function renewing(overrides: Partial<SpeechRelayPorts> = {}) {
  const extensions: number[] = [];
  const f = harness({
    maxWindows: 2,
    expiresAt: 1_000 + SPEECH_RELAY_RENEW_LEAD_MS + 20,
    extend: async (_scope, expiresAt) => {
      extensions.push(expiresAt);
      return expiresAt;
    },
    ...overrides,
  });
  return { ...f, extensions };
}
test("a renewable session takes another quota minute and reservation before its end moves", async () => {
  const f = renewing(),
    session = await f.open();
  await until(() => f.events.some((event) => isExtended(event)));
  expect(f.order.filter((step) => step === "credits")).toHaveLength(2);
  expect(f.extensions).toEqual([1_000 + SPEECH_RELAY_BUDGET.durationMs]);
  expect(f.events).toContainEqual({
    t: "extended",
    expiresAt: new Date(f.extensions[0]).toISOString(),
  });
  // The first end no longer retires the session.
  f.advance(SPEECH_RELAY_RENEW_LEAD_MS + 30);
  await session.control({ t: "tts", id: "turn-1", text: "still live" });
  // Text beyond one window's budget is admitted once two windows are held.
  for (let n = 0; n < 4; n++)
    await session.control({ t: "tts", id: "turn-1", text: "x".repeat(1024) });
  await session.close();
  const shares = f.settled.map(
    (receipt) => (receipt as { ttsCharacters: number }).ttsCharacters,
  );
  expect(shares).toEqual([SPEECH_RELAY_BUDGET.ttsCharacters, 10]);
});
test("a refused extension or quota keeps the original end and never emits a renewal", async () => {
  for (const mode of ["extend", "quota", "credits"]) {
    let reservations = 0;
    const f = renewing(
      mode === "extend"
        ? { extend: async () => 0 }
        : mode === "quota"
          ? {
              usageLimits: {
                organizationDailyMinutes: 1,
                userDailyMinutes: 1,
              },
            }
          : {
              reserveCredits: async () => {
                if (reservations++) throw Error("declined");
                return {
                  beforeProviderDispatch: async () => {},
                  settle: async () => {},
                };
              },
            },
    );
    const session = await f.open();
    await sleep(60);
    expect(f.events.some((event) => isExtended(event))).toBe(false);
    expect(f.extensions).toEqual([]);
    if (mode === "credits") expect(f.order).toContain("quota-release");
    if (mode === "quota")
      expect(f.order.filter((step) => step === "credits")).toHaveLength(1);
    f.advance(SPEECH_RELAY_RENEW_LEAD_MS + 30);
    await expect(
      session.control({ t: "tts", id: "late", text: "after end" }),
    ).rejects.toMatchObject({ code: "expired" });
  }
});
test("more than one window without an extension port is refused before admission", async () => {
  const f = harness({ maxWindows: 2 });
  await expect(f.open()).rejects.toMatchObject({ code: "identity" });
  expect(f.order).toEqual([]);
});
const UNGRANTED = {
  pcmBytes: 0,
  ttsCharacters: 0,
  providerMayHaveStarted: false,
  dispatched: { stt: false, tts: false },
};
test("a refused extension releases its reservation and quota minute once, at zero", async () => {
  const f = renewing({ extend: async () => 0 }),
    session = await f.open();
  await until(() => f.order.includes("quota-release"));
  await tick();
  // The renewal's reservation is settled to zero right away, never at full cost.
  expect(f.settled).toEqual([UNGRANTED]);
  await session.close();
  expect(f.settled).toHaveLength(2);
  expect(f.settled[1]).toMatchObject({ dispatched: { stt: true } });
  expect(f.order.filter((step) => step === "settle")).toHaveLength(2);
  expect(f.order.filter((step) => step === "quota-release")).toHaveLength(1);
});
test("closing while an extension is in flight settles every reservation exactly once", async () => {
  let accept: (end: number) => void = () => {};
  const f = renewing({
      extend: (_scope, expiresAt) =>
        new Promise<number>((resolve) => {
          accept = () => resolve(expiresAt);
        }),
    }),
    session = await f.open();
  await session.control({ t: "tts", id: "active-phrase", text: "hello" });
  await until(() => f.order.filter((step) => step === "credits").length === 2);
  await tick();
  const closing = session.close();
  await tick();
  expect(f.order).toContain("stt-cancel");
  expect(f.order).toContain("tts-cancel");
  accept(0);
  await closing;
  // The renewal was never granted: its reservation carries no usage.
  expect(f.settled).toHaveLength(2);
  expect(f.settled[0]).toMatchObject({ dispatched: { stt: true } });
  expect(f.settled[1]).toEqual(UNGRANTED);
  await tick();
  await sleep(5);
  expect(f.settled).toHaveLength(2);
  expect(f.events.some((event) => isExtended(event))).toBe(false);
  expect(f.order.filter((step) => step === "quota-release")).toHaveLength(1);
});
test("a reservation that lands after close is released, not leaked", async () => {
  let admit: () => void = () => {};
  let calls = 0;
  const f = renewing(),
    reserve = f.ports.reserveCredits;
  f.ports.reserveCredits = async (scope, budget) => {
    if (calls++ === 0) return reserve(scope, budget);
    await new Promise<void>((resolve) => {
      admit = resolve;
    });
    return reserve(scope, budget);
  };
  const session = await f.open();
  await until(() => calls === 2);
  const closing = session.close();
  await tick();
  expect(f.order).toContain("stt-cancel");
  admit();
  await closing;
  expect(f.settled).toHaveLength(2);
  expect(f.settled).toContainEqual(UNGRANTED);
  expect(f.settled).toContainEqual(
    expect.objectContaining({ dispatched: { stt: true, tts: false } }),
  );
  expect(f.extensions).toEqual([]);
  expect(f.order.filter((step) => step === "quota-release")).toHaveLength(1);
});
test("a late renewal cannot revive an expired speech window", async () => {
  const f = renewing({ expiresAt: 1_000 + 20 }),
    session = await f.open();
  // The renewal runs only after the clock already passed the current end.
  f.advance(25);
  await sleep(30);
  expect(f.extensions).toEqual([]);
  await session.close();
});

test("an entered TTS provider factory remains uncertain when it throws", async () => {
  let attempts = 0;
  const f = harness({
    openTts: () => {
      attempts++;
      throw Error("provider upgrade outcome unknown");
    },
    confirmTtsTransportStopped: async () => "unknown",
  });
  const session = await f.open();
  await expect(
    session.control({ t: "tts", id: "ambiguous", text: "hello" }),
  ).rejects.toThrow("provider upgrade outcome unknown");
  await expect(session.close()).rejects.toThrow("cleanup was not confirmed");
  expect(attempts).toBe(1);
  expect(f.settled).toMatchObject([
    {
      ttsCharacters: 5,
      dispatched: { stt: true, tts: true },
      outcomes: { tts: "unknown" },
    },
  ]);
  expect(session.retirement.evidence()?.tts).toBe("unknown");
});

test("earlier cancellation uncertainty survives a later pre-provider revocation", async () => {
  let marks = 0,
    release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const f = harness({
    reserveCredits: async () => ({
      beforeProviderDispatch: async (kind) => {
        if (kind === "tts" && ++marks === 2) await held;
      },
      settle: async (receipt) => {
        f.settled.push(receipt);
      },
    }),
  });
  const session = await f.open();
  await session.control({ t: "tts", id: "prior", text: "already" });
  await session.control({ t: "cancel", id: "prior" });
  const queued = session.control({ t: "tts", id: "queued", text: "later" });
  await tick();
  f.revoke();
  release();
  await expect(queued).rejects.toThrow("closed");
  await session.close();
  expect(f.order.filter((value) => value === "tts-open")).toHaveLength(1);
  expect(f.settled).toMatchObject([
    { ttsCharacters: 7, outcomes: { tts: "unknown" } },
  ]);
});

test("unused renewed STT budgets do not repeat an unknown initial hold", async () => {
  const f = renewing({ confirmProviderStopped: async () => "unknown" }),
    session = await f.open();
  await until(() => f.events.some((event) => isExtended(event)));
  await session.close();
  expect(f.settled).toHaveLength(2);
  expect(f.settled[0]).toMatchObject({
    pcmBytes: 0,
    outcomes: { stt: "unknown" },
    dispatched: { stt: true },
  });
  expect(f.settled[1]).toMatchObject({
    pcmBytes: 0,
    outcomes: { stt: "unknown" },
    dispatched: { stt: false },
  });
  await session.close();
  expect(f.settled).toHaveLength(2);
});

test("unknown STT drain preserves the used audio budget and releases unused renewal", async () => {
  const f = renewing({ confirmProviderStopped: async () => "unknown" }),
    session = await f.open();
  await until(() => f.events.some((event) => isExtended(event)));
  f.advance(1_000);
  session.sendPcm(new Uint8Array(SPEECH_RELAY_BUDGET.chunkBytes));
  await session.close();
  expect(f.settled).toHaveLength(2);
  expect(f.settled[0]).toMatchObject({
    pcmBytes: SPEECH_RELAY_BUDGET.chunkBytes,
    outcomes: { stt: "unknown" },
    dispatched: { stt: true },
  });
  expect(f.settled[1]).toMatchObject({
    pcmBytes: 0,
    outcomes: { stt: "unknown" },
    dispatched: { stt: false },
  });
});

test("a send that throws after dispatch at the next STT budget keeps that budget uncertain", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  let session: Awaited<ReturnType<typeof createSpeechRelaySession>> | undefined;
  let attempted = 0;
  const windowBytes =
    (SPEECH_RELAY_BUDGET.durationMs * SPEECH_RELAY_BUDGET.pcmBytesPerSecond) /
    1000;
  const f = harness({
    expiresAt: 1_000 + SPEECH_RELAY_BUDGET.durationMs,
    maxWindows: 2,
    extend: async (_scope, end) => end,
    confirmProviderStopped: async () => "unknown",
    openStt: () => ({
      sendAudioChunk: (chunk) => {
        attempted += chunk.byteLength;
        if (attempted > windowBytes) throw Error("send dispatched then threw");
      },
      cancel: () => {},
    }),
  });
  try {
    session = await f.open();
    for (let n = 0; n < windowBytes / SPEECH_RELAY_BUDGET.chunkBytes; n++) {
      f.advance(100);
      await vi.advanceTimersByTimeAsync(100);
      session.sendPcm(new Uint8Array(SPEECH_RELAY_BUDGET.chunkBytes));
    }
    expect(f.events.filter(isExtended)).toHaveLength(1);
    f.advance(100);
    await vi.advanceTimersByTimeAsync(100);
    const activeSession = session;
    expect(() =>
      activeSession.sendPcm(new Uint8Array(SPEECH_RELAY_BUDGET.chunkBytes)),
    ).toThrow("send dispatched then threw");
    await session.close();
    expect(attempted).toBe(windowBytes + SPEECH_RELAY_BUDGET.chunkBytes);
    expect(f.settled).toHaveLength(2);
    expect(f.settled[0]).toMatchObject({
      pcmBytes: windowBytes,
      dispatched: { stt: true },
      outcomes: { stt: "unknown" },
    });
    // Confirmed bytes did not advance, but the attempted send may have billed.
    expect(f.settled[1]).toMatchObject({
      pcmBytes: 0,
      dispatched: { stt: true },
      outcomes: { stt: "unknown" },
    });
    expect(() =>
      activeSession.sendPcm(new Uint8Array(SPEECH_RELAY_BUDGET.chunkBytes)),
    ).toThrow();
    await session.close();
    expect(f.settled).toHaveLength(2);
  } finally {
    await session?.close().catch(() => {});
    vi.useRealTimers();
  }
});

test("complete STT drain splits a full, partial and unused budget without changing usage", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  let delivered = 0;
  let session: Awaited<ReturnType<typeof createSpeechRelaySession>> | undefined;
  const windowBytes =
    (SPEECH_RELAY_BUDGET.durationMs * SPEECH_RELAY_BUDGET.pcmBytesPerSecond) /
    1000;
  const f = harness({
    expiresAt: 1_000 + SPEECH_RELAY_BUDGET.durationMs,
    maxWindows: 3,
    extend: async (_scope, end) => end,
    openStt: () => ({
      sendAudioChunk: (chunk) => {
        delivered += chunk.byteLength;
      },
      cancel: () => {},
      drain: async () => ({
        source: "provider-graceful-close" as const,
        audioBytes: delivered,
        sampleRate: 16000 as const,
        channels: 1 as const,
        encoding: "pcm_s16le" as const,
      }),
    }),
  });
  try {
    session = await f.open();
    for (let n = 0; n <= windowBytes / SPEECH_RELAY_BUDGET.chunkBytes; n++) {
      f.advance(100);
      await vi.advanceTimersByTimeAsync(100);
      session.sendPcm(new Uint8Array(SPEECH_RELAY_BUDGET.chunkBytes));
    }
    f.advance(39_900);
    await vi.advanceTimersByTimeAsync(39_900);
    expect(f.events.filter(isExtended)).toHaveLength(2);
    await session.close();
    expect(f.settled).toHaveLength(3);
    expect(f.settled).toMatchObject([
      {
        pcmBytes: windowBytes,
        outcomes: { stt: "complete" },
        dispatched: { stt: true },
      },
      {
        pcmBytes: SPEECH_RELAY_BUDGET.chunkBytes,
        outcomes: { stt: "complete" },
        dispatched: { stt: true },
      },
      {
        pcmBytes: 0,
        outcomes: { stt: "complete" },
        dispatched: { stt: false },
      },
    ]);
    expect(delivered).toBe(windowBytes + SPEECH_RELAY_BUDGET.chunkBytes);
  } finally {
    await session?.close().catch(() => {});
    vi.useRealTimers();
  }
});

for (const windows of [3, 10]) {
  test(`zero PCM with ${windows} granted STT windows retains only the initial unknown risk`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let session:
      | Awaited<ReturnType<typeof createSpeechRelaySession>>
      | undefined;
    const f = harness({
      expiresAt: 1_000 + SPEECH_RELAY_BUDGET.durationMs,
      maxWindows: windows,
      usageLimits: { organizationDailyMinutes: 10, userDailyMinutes: 10 },
      extend: async (_scope, end) => end,
      confirmProviderStopped: async () => "unknown",
    });
    try {
      session = await f.open();
      for (let n = 1; n < windows; n++) {
        f.advance(50_000);
        await vi.advanceTimersByTimeAsync(50_000);
      }
      expect(f.events.filter(isExtended)).toHaveLength(windows - 1);
      await session.close();
      expect(f.settled).toHaveLength(windows);
      expect(f.settled[0]).toMatchObject({
        pcmBytes: 0,
        dispatched: { stt: true },
        outcomes: { stt: "unknown" },
      });
      for (const receipt of f.settled.slice(1))
        expect(receipt).toMatchObject({
          pcmBytes: 0,
          dispatched: { stt: false },
          outcomes: { stt: "unknown" },
        });
      await session.close();
      expect(f.settled).toHaveLength(windows);
    } finally {
      await session?.close().catch(() => {});
      vi.useRealTimers();
    }
  });
}

test("failed legacy unused settlement is retained without repeating its non-idempotent call", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  let attempts = 0;
  const f = renewing({ extend: async () => 0 });
  const reserve = f.ports.reserveCredits;
  let window = 0;
  f.ports.reserveCredits = async (...args) => {
    const reservation = await reserve(...args);
    if (window++ === 0) return reservation;
    return {
      ...reservation,
      settle: async () => {
        attempts++;
        throw Error("Legacy result unknown");
      },
    };
  };
  try {
    const session = await f.open();
    await vi.advanceTimersByTimeAsync(20);
    await expect(session.close()).rejects.toThrow("cleanup was not confirmed");
    await expect(session.retirement.retryRetirement()).rejects.toThrow(
      "cleanup was not confirmed",
    );
    expect(attempts).toBe(1);
    expect(f.order.filter((item) => item === "quota-release")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
