import { afterEach, beforeEach, describe, expect, it } from "vitest";

type RuntimeListenerEvent = {
  type: "aborted";
  roomId: string;
  reason: string;
};

interface CoordinatorRuntime {
  turnControllers: {
    abortTurn(roomId: string, reason: string): boolean;
    onEvent(listener: (event: RuntimeListenerEvent) => void): () => void;
  };
}

type TurnToken = {
  signal: AbortSignal;
  aborted: boolean;
  reason?: string;
  runId: string;
  slot: number;
};

type VoiceCancellationCoordinatorInstance = {
  armTurn(input: { roomId: string; runId: string; slot: number }): TurnToken;
  bargeIn(roomId: string): boolean;
  current(roomId: string): TurnToken | null;
  dispose(): void;
};

type OptimisticGenerationPolicyInstance = {
  setPowerSource(source: "battery" | "ac"): void;
  shouldStartOptimisticLm(eotProbability: number): boolean;
};

type LocalInferenceServicesModule = {
  OptimisticGenerationPolicy: new () => OptimisticGenerationPolicyInstance;
  VoiceCancellationCoordinator: new (options: {
    runtime: CoordinatorRuntime;
    slotAbort(slot: number, reason: string): void;
    ttsStop(): void;
  }) => VoiceCancellationCoordinatorInstance;
};

const { OptimisticGenerationPolicy, VoiceCancellationCoordinator } =
  (await import(
    "@elizaos/plugin-local-inference/services"
  )) as LocalInferenceServicesModule;

interface FakeRuntime extends CoordinatorRuntime {
  abortCalls: Array<{
    roomId: string;
    reason: string;
    atMs: number;
  }>;
  emitEvent(event: RuntimeListenerEvent): void;
}

function fakeRuntime(clock: () => number): FakeRuntime {
  const listeners = new Set<(e: RuntimeListenerEvent) => void>();
  const abortCalls: FakeRuntime["abortCalls"] = [];
  return {
    turnControllers: {
      abortTurn(roomId, reason) {
        abortCalls.push({ roomId, reason, atMs: clock() });
        return true;
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    abortCalls,
    emitEvent(event) {
      for (const l of listeners) l(event);
    },
  };
}

/**
 * Fake LM. Caller drives streaming by calling `pushChunk()` or `endStream()`.
 * The LM responds to `signal.aborted` between chunks — the test asserts this.
 */
class FakeLm {
  private aborted = false;
  private startedAtMs: number | null = null;
  chunks: string[] = [];

  constructor(private readonly clock: () => number) {}

  /** "Fire" the LM. Returns the wall-clock ms the call began. */
  start(signal: AbortSignal): number {
    this.startedAtMs = this.clock();
    signal.addEventListener(
      "abort",
      () => {
        this.aborted = true;
      },
      { once: true },
    );
    return this.startedAtMs;
  }

  pushChunk(text: string): void {
    if (this.aborted) return;
    this.chunks.push(text);
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  get startedAt(): number | null {
    return this.startedAtMs;
  }
}

/**
 * Fake TTS sink. `write()` pretends to play audio; `drain()` is the SIGKILL
 * path the audio sink exposes — we record the wall-clock time it fires.
 */
class FakeTtsSink {
  playing = false;
  stoppedAtMs: number | null = null;
  startedAtMs: number | null = null;
  chunksWritten = 0;

  constructor(private readonly clock: () => number) {}

  startPlayback(): void {
    this.playing = true;
    this.startedAtMs = this.clock();
    this.stoppedAtMs = null;
  }

  write(_chunk: Uint8Array): void {
    if (!this.playing) return;
    this.chunksWritten += 1;
  }

  drain(): void {
    if (!this.playing) return;
    this.playing = false;
    this.stoppedAtMs = this.clock();
  }
}

/** Fake VAD. Tests drive `.emit({ type: 'speech-start' | 'speech-end' })`. */
class FakeVad {
  private readonly listeners = new Set<(event: { type: string }) => void>();
  onEvent(listener: (event: { type: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: { type: string }): void {
    for (const l of this.listeners) l(event);
  }
}

/**
 * Fake turn detector. Test asserts that the optimistic policy fires the LM
 * within 200 ms of the EOT timestamp this detector emits.
 */
class FakeTurnDetector {
  private p = 0;
  emit(prob: number): number {
    this.p = prob;
    return this.p;
  }
  get latestProb(): number {
    return this.p;
  }
}

// ---------------------------------------------------------------------------
// Test rig — wires the fakes through the real coordinator.
// ---------------------------------------------------------------------------

interface Rig {
  clock: () => number;
  advanceMs(ms: number): void;
  runtime: FakeRuntime;
  coordinator: VoiceCancellationCoordinator;
  policy: OptimisticGenerationPolicy;
  lm: FakeLm;
  tts: FakeTtsSink;
  vad: FakeVad;
  turnDetector: FakeTurnDetector;
  // Captured by slotAbort callback the coordinator fires.
  slotAbortCalls: Array<{ slot: number; reason: string; atMs: number }>;
}

function newRig(): Rig {
  let now = 0;
  const clock = () => now;

  const runtime = fakeRuntime(clock);
  const lm = new FakeLm(clock);
  const tts = new FakeTtsSink(clock);
  const vad = new FakeVad();
  const turnDetector = new FakeTurnDetector();
  const slotAbortCalls: Rig["slotAbortCalls"] = [];

  const coordinator = new VoiceCancellationCoordinator({
    runtime,
    slotAbort(slot, reason) {
      slotAbortCalls.push({ slot, reason, atMs: now });
      // Real slotAbort would close the slot's in-flight fetch; here we
      // don't need to because the AbortSignal on the LM call already
      // fires when the token aborts.
    },
    ttsStop() {
      tts.drain();
    },
  });

  const policy = new OptimisticGenerationPolicy();

  return {
    clock,
    advanceMs(ms: number) {
      now += ms;
    },
    runtime,
    coordinator,
    policy,
    lm,
    tts,
    vad,
    turnDetector,
    slotAbortCalls,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive the optimistic-LM-start logic: when the turn detector EOT probability
 * crosses threshold and the policy says yes, arm a token and "start" the LM.
 * This is the contract `VoiceStateMachine.handlePartialTranscript` calls;
 * the test exercises the same gate by hand so we can assert timing without
 * a full state machine boot.
 *
 * Returns true if the optimistic LM was started this tick.
 */
function maybeStartOptimisticLm(
  rig: Rig,
  roomId: string,
  runId: string,
  eotProb: number,
  slot: number,
): boolean {
  if (!rig.policy.shouldStartOptimisticLm(eotProb)) return false;
  const token = rig.coordinator.armTurn({ roomId, runId, slot });
  rig.lm.start(token.signal);
  return true;
}

// ---------------------------------------------------------------------------
// Scenario 1 — optimistic generation: LM start within 200 ms of EOT.
// ---------------------------------------------------------------------------

describe("W3-9 — optimistic LM start within 200 ms of EOT", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = newRig();
  });
  afterEach(() => {
    rig.coordinator.dispose();
  });

  it("fires the LM within 200 ms when policy is enabled and EOT clears threshold", () => {
    // User has been speaking; VAD reports speech-start.
    rig.vad.emit({ type: "speech-start" });

    // Time passes — ASR partials arrive (modeled as turn-detector probability
    // updates). At t=100 ms the turn detector hits the EOT threshold.
    rig.advanceMs(100);
    const eotProb = rig.turnDetector.emit(0.75);
    const eotFiredAtMs = rig.clock();

    // Optimistic gate fires.
    const started = maybeStartOptimisticLm(rig, "room-A", "turn-1", eotProb, 0);
    expect(started).toBe(true);

    const elapsed =
      (rig.lm.startedAt ?? Number.POSITIVE_INFINITY) - eotFiredAtMs;
    expect(elapsed).toBeLessThanOrEqual(200);
    expect(elapsed).toBeGreaterThanOrEqual(0);

    // Token is live; the coordinator knows about it.
    const token = rig.coordinator.current("room-A");
    expect(token).not.toBeNull();
    expect(token?.aborted).toBe(false);
    expect(token?.runId).toBe("turn-1");
    expect(token?.slot).toBe(0);
  });

  it("does NOT fire the LM when the policy is disabled (battery)", () => {
    rig.policy.setPowerSource("battery");
    const started = maybeStartOptimisticLm(rig, "room-A", "turn-1", 0.95, 0);
    expect(started).toBe(false);
    expect(rig.lm.startedAt).toBeNull();
    expect(rig.coordinator.current("room-A")).toBeNull();
  });

  it("does NOT fire the LM when EOT is below threshold", () => {
    const started = maybeStartOptimisticLm(rig, "room-A", "turn-1", 0.3, 0);
    expect(started).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — barge-in mid-response: TTS stops within 100 ms, LM aborts,
//              new turn re-plans.
// ---------------------------------------------------------------------------

describe("W3-9 — barge-in mid-response cancels TTS + LM within 100 ms", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = newRig();
  });
  afterEach(() => {
    rig.coordinator.dispose();
  });

  it("trips TTS drain + LM abort + runtime.abortTurn within one tick of speech-detected", () => {
    // Set up a live turn: arm the token, the LM "starts", TTS starts playing.
    rig.advanceMs(50);
    const token = rig.coordinator.armTurn({
      roomId: "room-A",
      runId: "turn-1",
      slot: 2,
    });
    rig.lm.start(token.signal);
    rig.tts.startPlayback();
    rig.tts.write(new Uint8Array(1024));
    expect(rig.tts.playing).toBe(true);
    expect(rig.lm.isAborted).toBe(false);

    // User barges in.
    rig.advanceMs(200);
    const speechDetectedAtMs = rig.clock();
    rig.coordinator.bargeIn("room-A");

    // Within the same tick (no clock advance) — every fan-out fires:
    //   1. token.signal aborts → LM aborted
    //   2. ttsStop callback → TTS sink drained
    //   3. slotAbort callback → slot abort recorded
    //   4. runtime.abortTurn called with reason=barge-in
    expect(rig.lm.isAborted).toBe(true);
    expect(rig.tts.playing).toBe(false);
    const ttsStopElapsed =
      (rig.tts.stoppedAtMs ?? Number.POSITIVE_INFINITY) - speechDetectedAtMs;
    expect(ttsStopElapsed).toBeLessThanOrEqual(100);
    expect(ttsStopElapsed).toBeGreaterThanOrEqual(0);

    expect(rig.slotAbortCalls).toEqual([
      { slot: 2, reason: "barge-in", atMs: speechDetectedAtMs },
    ]);

    expect(rig.runtime.abortCalls).toEqual([
      { roomId: "room-A", reason: "barge-in", atMs: speechDetectedAtMs },
    ]);

    // Token state.
    expect(token.aborted).toBe(true);
    expect(token.reason).toBe("barge-in");
  });

  it("re-plans: arming a fresh token after barge-in starts a new turn", () => {
    // First turn lands and gets barged.
    const first = rig.coordinator.armTurn({
      roomId: "room-A",
      runId: "turn-1",
      slot: 2,
    });
    rig.lm.start(first.signal);
    rig.tts.startPlayback();
    rig.coordinator.bargeIn("room-A");
    expect(first.aborted).toBe(true);

    // User says something new; ASR comes in; optimistic-LM start arms a new
    // token. The coordinator replaces the prior token cleanly.
    rig.advanceMs(150);
    const second = rig.coordinator.armTurn({
      roomId: "room-A",
      runId: "turn-2",
      slot: 2,
    });
    expect(second.aborted).toBe(false);
    expect(second.runId).toBe("turn-2");
    expect(rig.coordinator.current("room-A")).toBe(second);
    // First token stays aborted with its original reason — the
    // re-arm does NOT retroactively change it.
    expect(first.reason).toBe("barge-in");
  });

  it("LM signal is observed mid-stream — token abort halts further chunks", () => {
    const token = rig.coordinator.armTurn({
      roomId: "room-A",
      runId: "turn-1",
      slot: 0,
    });
    rig.lm.start(token.signal);
    rig.lm.pushChunk("Hello");
    rig.lm.pushChunk("world");
    expect(rig.lm.chunks).toEqual(["Hello", "world"]);

    rig.coordinator.bargeIn("room-A");

    // After abort, the LM stops accepting new chunks (mimicking the
    // signal.aborted check at each kernel boundary in the real LM).
    rig.lm.pushChunk("blocked");
    expect(rig.lm.chunks).toEqual(["Hello", "world"]);
    expect(rig.lm.isAborted).toBe(true);
  });

  it("runtime-initiated abort propagates to TTS + LM (reverse direction)", () => {
    const token = rig.coordinator.armTurn({
      roomId: "room-A",
      runId: "turn-1",
      slot: 1,
    });
    rig.lm.start(token.signal);
    rig.tts.startPlayback();

    // Runtime aborts the turn for an unrelated reason (e.g. APP_PAUSE).
    rig.runtime.emitEvent({
      type: "aborted",
      roomId: "room-A",
      reason: "app-pause",
    });

    // Token aborts with reason=external; voice fan-out still fires.
    expect(token.aborted).toBe(true);
    expect(token.reason).toBe("external");
    expect(rig.lm.isAborted).toBe(true);
    expect(rig.tts.playing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — sanity: idempotent and re-entrant.
// ---------------------------------------------------------------------------

describe("W3-9 — invariants", () => {
  it("subsequent bargeIn calls on the same turn are no-ops", () => {
    const rig = newRig();
    rig.coordinator.armTurn({ roomId: "room-A", runId: "turn-1", slot: 0 });
    expect(rig.coordinator.bargeIn("room-A")).toBe(true);
    expect(rig.coordinator.bargeIn("room-A")).toBe(false);
    expect(rig.runtime.abortCalls.length).toBe(1);
    expect(rig.slotAbortCalls.length).toBe(1);
    rig.coordinator.dispose();
  });

  it("disposing tears down all turns without leaking listeners", () => {
    const rig = newRig();
    const a = rig.coordinator.armTurn({
      roomId: "room-A",
      runId: "turn-A",
      slot: 0,
    });
    const b = rig.coordinator.armTurn({
      roomId: "room-B",
      runId: "turn-B",
      slot: 1,
    });
    rig.coordinator.dispose();
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
    // After dispose, the runtime emitting an event for an already-armed
    // room is harmless (no listener active).
    rig.runtime.emitEvent({
      type: "aborted",
      roomId: "room-A",
      reason: "any",
    });
  });
});
