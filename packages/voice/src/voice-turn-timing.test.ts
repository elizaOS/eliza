import { beforeEach, describe, expect, it } from "vitest";
import {
  createVoiceTurnTiming,
  VOICE_TIMING_MARKS,
  type VoiceTimingStorage,
  voiceTimingEndpoint,
  voiceTimingLive,
} from "./voice-turn-timing";

// Record-keeping and ordering rules with an in-memory store and a fake clock. This is not
// microphone, playback or device latency evidence.
const KEY = "host:voice-timing:v1";
let now = 0;
let store: Map<string, string>;
const storage: VoiceTimingStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => {
    store.set(key, value);
  },
  removeItem: (key) => {
    store.delete(key);
  },
};
const make = (
  extra: Partial<Parameters<typeof createVoiceTurnTiming>[0]> = {},
) =>
  createVoiceTurnTiming({
    storageKey: KEY,
    format: "host-voice-timing-v1",
    routes: ["on-device", "local-agent"],
    storage: () => storage,
    clock: () => now,
    ...extra,
  });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  store = new Map();
  now = 10_000;
});

describe("voice turn timing", () => {
  it("records ordered offsets once and nothing but timing", () => {
    const timing = make();
    const id = timing.begin({ route: "on-device", cold: false });
    now += 800;
    expect(timing.mark("transcript-ready")).toBe(true);
    now += 100;
    expect(timing.mark("send")).toBe(true);
    now += 600;
    expect(timing.mark("first-token")).toBe(true);
    now += 900;
    expect(timing.mark("final-reply")).toBe(true);
    now += 600;
    expect(timing.mark("first-audio")).toBe(true);
    const [row] = timing.records();
    expect(row.id).toBe(id);
    expect(row.marks).toEqual({
      "recording-end": 0,
      "transcript-ready": 800,
      send: 900,
      "first-token": 1500,
      "final-reply": 2400,
      "first-audio": 3000,
    });
    expect(Object.keys(row).sort()).toEqual([
      "cold",
      "id",
      "marks",
      "recordedAt",
      "route",
      "version",
    ]);
    // First audio ended the turn.
    expect(timing.active()).toBeUndefined();
    expect(timing.mark("first-token")).toBe(false);
    const exported = JSON.parse(timing.exportJson());
    expect(exported.format).toBe("host-voice-timing-v1");
    expect(exported.marks).toEqual([...VOICE_TIMING_MARKS]);
    expect(exported.records).toHaveLength(1);
  });

  it("refuses premature, repeated and out-of-order marks and unknown routes", () => {
    const timing = make();
    expect(timing.begin({ route: "somewhere", cold: false })).toBeUndefined();
    timing.begin({ route: "on-device", cold: true });
    expect(timing.mark("send")).toBe(false);
    expect(timing.mark("first-token")).toBe(false);
    now += 500;
    expect(timing.mark("transcript-ready")).toBe(true);
    expect(timing.mark("transcript-ready")).toBe(false);
    now -= 200;
    // A clock that went backwards cannot shorten the recognition phase.
    expect(timing.mark("send")).toBe(false);
    now += 400;
    expect(timing.mark("send")).toBe(true);
    expect(timing.mark("send", "another-turn")).toBe(false);
  });

  it("abandons an unfinished turn when the next begins and keeps finished ones", () => {
    const timing = make();
    const first = timing.begin({ route: "on-device", cold: false });
    timing.mark("transcript-ready");
    const second = timing.begin({ route: "local-agent", cold: false });
    timing.mark("transcript-ready");
    timing.mark("send");
    timing.mark("first-token");
    timing.mark("final-reply");
    timing.finish();
    timing.abandon();
    const rows = timing.records();
    expect(rows.map((row) => [row.id, row.outcome])).toEqual([
      [first, "abandoned"],
      [second, undefined],
    ]);
  });

  it("keeps entry and policy only from the host's lists and drops tampered rows", () => {
    const timing = make({ entries: ["conversation", "notes"] });
    timing.begin({
      route: "on-device",
      cold: false,
      entry: "notes",
      policy: "review",
    });
    timing.begin({
      route: "on-device",
      cold: false,
      entry: "dictation",
      policy: "later" as never,
    });
    const rows = timing.records();
    expect(rows[0]).toMatchObject({ entry: "notes", policy: "review" });
    expect(rows[1].entry).toBeUndefined();
    expect(rows[1].policy).toBeUndefined();
    const raw = JSON.parse(store.get(KEY) ?? "[]");
    raw.push(
      { ...raw[0], id: "x", marks: {} },
      {
        ...raw[0],
        id: "0b0c7a52-6d5e-4e0f-9a43-5c1d2e3f4a5b",
        marks: { late: 5 },
      },
      { ...raw[0], id: "1b0c7a52-6d5e-4e0f-9a43-5c1d2e3f4a5b", heard: "maybe" },
    );
    store.set(KEY, JSON.stringify(raw));
    expect(timing.records()).toHaveLength(2);
    // The record limit keeps the newest rows.
    const small = make({ limit: 1 });
    small.begin({ route: "on-device", cold: false });
    expect(small.records()).toHaveLength(1);
  });

  it("validates live, endpoint and heard sections as numbers and enums only", () => {
    expect(
      voiceTimingLive({ mode: "stream", partials: 3, firstPartialMs: 120.4 }),
    ).toEqual({
      mode: "stream",
      partials: 3,
      firstPartialMs: 120,
    });
    expect(voiceTimingLive({ mode: "stream", partials: -1 })).toBeUndefined();
    expect(
      voiceTimingLive({ mode: "stream", partials: 1, firstPartialMs: 4e6 }),
    ).toBeUndefined();
    expect(
      voiceTimingEndpoint({ by: "semantic", semantic: "incomplete" }),
    ).toBeUndefined();
    expect(
      voiceTimingEndpoint({
        by: "gap",
        semantic: "unavailable",
        reason: "ram-pressure",
        latencyMs: 12.6,
      }),
    ).toEqual({
      by: "gap",
      semantic: "unavailable",
      reason: "ram-pressure",
      latencyMs: 13,
    });
    expect(
      voiceTimingEndpoint({
        by: "gap",
        semantic: "timeout",
        reason: "secret text",
      }),
    ).toBeUndefined();

    const timing = make();
    const id = timing.begin({ route: "on-device", cold: false });
    expect(timing.recordLive({ mode: "batch", partials: 0 })).toBe(true);
    expect(timing.recordLive({ mode: "stream", partials: 4 })).toBe(false);
    expect(timing.recordEndpoint({ by: "gap", semantic: "not-asked" })).toBe(
      true,
    );
    timing.mark("transcript-ready");
    timing.mark("send");
    timing.mark("first-token");
    timing.mark("final-reply");
    timing.mark("first-audio");
    // A barge-in follows first audio: heard outcomes attach by id after the turn ended.
    expect(timing.recordHeard(id, "recorded")).toBe(true);
    expect(timing.recordHeard(id, "conflict")).toBe(false);
    expect(timing.recordHeard(id, "the words")).toBe(false);
    expect(timing.records()[0]).toMatchObject({
      live: { mode: "batch", partials: 0 },
      endpoint: { by: "gap", semantic: "not-asked" },
      heard: "recorded",
    });
  });

  it("sends at the review boundary and abandons only its own turn", async () => {
    const timing = make();
    timing.begin({ route: "on-device", cold: false, entry: "conversation" });
    now += 300;
    timing.mark("transcript-ready");
    let release!: (text: string | null) => void;
    const sent = timing.sendEntry({
      policy: "review",
      transcript: " call Dana ",
      review: () => new Promise((resolve) => (release = resolve)),
      send: async (text) => text.length,
    });
    now += 2000;
    release(" call Dana back ");
    expect(await sent).toEqual({ text: "call Dana back", result: 14 });
    expect(timing.records()[0].marks.send).toBe(2300);
    expect(JSON.stringify(timing.records())).not.toMatch(/Dana/);

    // A discard after a newer turn began leaves the newer turn alone.
    const old = timing.begin({ route: "on-device", cold: false });
    timing.mark("transcript-ready");
    let discard!: (text: string | null) => void;
    const pending = timing.sendEntry({
      policy: "review",
      transcript: "x",
      review: () => new Promise((resolve) => (discard = resolve)),
      send: async () => 0,
    });
    const newer = timing.begin({ route: "on-device", cold: false });
    discard(null);
    expect(await pending).toBeNull();
    expect(timing.active()).toBe(newer);
    expect(timing.records().find((row) => row.id === old)?.outcome).toBe(
      "abandoned",
    );

    // A failed send abandons and rethrows; auto-send skips review.
    timing.mark("transcript-ready");
    await expect(
      timing.sendEntry({
        policy: "auto-send",
        transcript: "go",
        review: async () => {
          throw new Error("not called");
        },
        send: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(timing.active()).toBeUndefined();
  });

  it("forwards conversation stages to the native sink and links its turn id", async () => {
    const timing = make();
    const native = "8a0c7a52-6d5e-4e0f-9a43-5c1d2e3f4a5b";
    const calls: Array<[string, string | undefined]> = [];
    timing.setNativeStageSink(async (stage, turn) => {
      calls.push([stage, turn]);
      return native;
    });
    timing.begin({ route: "on-device", cold: false, entry: "dictation" });
    timing.mark("transcript-ready");
    await flush();
    expect(calls).toEqual([]);
    const id = timing.begin({
      route: "on-device",
      cold: false,
      entry: "conversation",
    });
    timing.mark("transcript-ready");
    await flush();
    timing.mark("send");
    await flush();
    timing.mark("first-token");
    timing.mark("final-reply");
    await flush();
    expect(calls).toEqual([
      ["asr-final", undefined],
      ["request", native],
      ["first-token", native],
    ]);
    expect(timing.nativeTurnId()).toBe(native);
    expect(timing.records().find((row) => row.id === id)?.nativeTurn).toBe(
      native,
    );
    // A throwing or malformed sink never affects the turn.
    timing.setNativeStageSink(() => {
      throw new Error("bridge gone");
    });
    timing.begin({ route: "on-device", cold: false, entry: "conversation" });
    expect(timing.mark("transcript-ready")).toBe(true);
    timing.setNativeStageSink(async () => "not-a-uuid");
    expect(timing.mark("send")).toBe(true);
    await flush();
    expect(timing.nativeTurnId()).toBeUndefined();
  });

  it("survives absent or failing storage and clears its own key", () => {
    const broken = createVoiceTurnTiming({
      storageKey: KEY,
      format: "f",
      routes: ["on-device"],
      storage: () => {
        throw new Error("denied");
      },
    });
    expect(broken.begin({ route: "on-device", cold: false })).toBeTypeOf(
      "string",
    );
    expect(broken.records()).toEqual([]);
    expect(broken.mark("transcript-ready")).toBe(false);
    const timing = make();
    timing.begin({ route: "on-device", cold: false });
    store.set("other", "kept");
    timing.clear();
    expect(store.has(KEY)).toBe(false);
    expect(store.get("other")).toBe("kept");
    expect(timing.active()).toBeUndefined();
  });
});
