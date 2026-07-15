/**
 * Unit coverage for the playback frame pump and mono downmix. Pure functions over
 * audio buffers, no live playback.
 */
import { describe, expect, it, vi } from "vitest";
import {
  attachPlaybackTapWithGrace,
  downmixAudioBufferToMono,
  ensurePlaybackContextRunning,
  type PlaybackAudioFrameEvent,
  PlaybackFramePump,
  type PlaybackFrameTap,
  PlaybackTapLifecycle,
  resumeAudioContextForPlayback,
} from "./playback-frame-pump";

function fakeAudioContext(
  initialState: AudioContextState,
): AudioContext & { setState: (state: AudioContextState) => void } {
  let state = initialState;
  return {
    get state() {
      return state;
    },
    setState(next: AudioContextState) {
      state = next;
    },
    resume: vi.fn(async () => {
      state = "running";
    }),
  } as unknown as AudioContext & {
    setState: (state: AudioContextState) => void;
  };
}

interface SentBody {
  frames?: PlaybackAudioFrameEvent[];
  reset?: boolean;
}

function makeFetcher(sent: SentBody[], ok = true) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as SentBody);
    return { ok } as Response;
  });
}

function pcm(samples: number, value = 0.25): Float32Array {
  return new Float32Array(samples).fill(value);
}

describe("attachPlaybackTapWithGrace", () => {
  it("releases playback after the grace period and late-attaches a slow tap", async () => {
    vi.useFakeTimers();
    try {
      let resolveTap!: (tap: PlaybackFrameTap) => void;
      const tap = {
        lateAttachSafe: true,
        start: vi.fn(),
        stop: vi.fn(),
      } as unknown as PlaybackFrameTap;
      const tapPromise = new Promise<PlaybackFrameTap>((resolve) => {
        resolveTap = resolve;
      });
      const onLateTap = vi.fn();

      const pending = attachPlaybackTapWithGrace(tapPromise, onLateTap, 150);
      await vi.advanceTimersByTimeAsync(149);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();

      resolveTap(tap);
      await Promise.resolve();
      expect(onLateTap).toHaveBeenCalledWith(tap);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not late-attach a scheduled fallback from the start of the clip", async () => {
    vi.useFakeTimers();
    try {
      let resolveTap!: (tap: PlaybackFrameTap) => void;
      const tapPromise = new Promise<PlaybackFrameTap>((resolve) => {
        resolveTap = resolve;
      });
      const onLateTap = vi.fn();

      const pending = attachPlaybackTapWithGrace(tapPromise, onLateTap, 150);
      await vi.advanceTimersByTimeAsync(150);
      await expect(pending).resolves.toBeNull();
      resolveTap({ start: vi.fn(), stop: vi.fn() });
      await Promise.resolve();

      expect(onLateTap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PlaybackFramePump", () => {
  it("encodes 16 kHz mono PCM into 20 ms playback frames and reset-only stop", async () => {
    const sent: SentBody[] = [];
    const pump = new PlaybackFramePump({
      fetcher: makeFetcher(sent),
      nowMs: () => 1_000,
    });
    const session = pump.createSessionForTest();

    session.start();
    session.appendPcm(pcm(640, 0.5), 16_000);
    await session.stop({ reset: true });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.frames).toHaveLength(2);
    expect(sent[0]?.frames?.[0]).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      samples: 320,
      timestamp: 1_000,
      frameIndex: 0,
    });
    expect(sent[0]?.frames?.[1]?.timestamp).toBe(1_020);
    expect(sent[0]?.frames?.[0]?.pcm16).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(sent[1]).toEqual({ reset: true });
  });

  it("resamples 48 kHz worklet chunks to 16 kHz frames", async () => {
    const sent: SentBody[] = [];
    const pump = new PlaybackFramePump({
      fetcher: makeFetcher(sent),
      nowMs: () => 2_000,
    });
    const session = pump.createSessionForTest();

    session.start();
    session.appendPcm(pcm(960, 0.2), 48_000);
    await session.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.frames).toHaveLength(1);
    expect(sent[0]?.frames?.[0]?.samples).toBe(320);
    expect(sent[0]?.frames?.[0]?.timestamp).toBe(2_000);
  });

  it("downmixes decoded AudioBuffers before scheduled fallback pumping", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0.5, 1]);
    const buffer = {
      length: 3,
      numberOfChannels: 2,
      getChannelData: (index: number) => (index === 0 ? left : right),
    } as AudioBuffer;

    expect(Array.from(downmixAudioBufferToMono(buffer))).toEqual([
      0.5, 0.25, 0,
    ]);
  });

  it("swallows playback route failures so TTS playback is not coupled to AEC", async () => {
    const sent: SentBody[] = [];
    const pump = new PlaybackFramePump({
      fetcher: makeFetcher(sent, false),
      nowMs: () => 3_000,
    });
    const session = pump.createSessionForTest();

    session.start();
    session.appendPcm(pcm(320), 16_000);
    await expect(session.stop({ reset: true })).resolves.toBeUndefined();
    expect(sent[0]?.frames).toHaveLength(1);
  });
});

describe("resumeAudioContextForPlayback", () => {
  it("returns true immediately for a running context", async () => {
    const ctx = fakeAudioContext("running");
    await expect(resumeAudioContextForPlayback(ctx)).resolves.toBe(true);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("resumes a suspended context and reports success", async () => {
    const ctx = fakeAudioContext("suspended");
    await expect(resumeAudioContextForPlayback(ctx)).resolves.toBe(true);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it("resumes an interrupted context and reports success", async () => {
    const ctx = fakeAudioContext("interrupted");
    await expect(resumeAudioContextForPlayback(ctx)).resolves.toBe(true);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it("reports a closed context as unavailable without calling resume", async () => {
    const ctx = fakeAudioContext("closed");
    await expect(resumeAudioContextForPlayback(ctx)).resolves.toBe(false);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("times out and reports failure if resume() never settles", async () => {
    vi.useFakeTimers();
    try {
      const ctx = fakeAudioContext("suspended");
      ctx.resume = vi.fn(() => new Promise<void>(() => {}));
      const pending = resumeAudioContextForPlayback(ctx, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ensurePlaybackContextRunning", () => {
  it("resolves without resuming a context that is already running", async () => {
    const ctx = fakeAudioContext("running");
    const onBlocked = vi.fn();
    await expect(
      ensurePlaybackContextRunning(ctx, "eliza-cloud", onBlocked),
    ).resolves.toBeUndefined();
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("resumes a suspended context and resolves once running", async () => {
    const ctx = fakeAudioContext("suspended");
    const onBlocked = vi.fn();
    await expect(
      ensurePlaybackContextRunning(ctx, "elevenlabs", onBlocked),
    ).resolves.toBeUndefined();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("resumes an interrupted context and resolves once running", async () => {
    const ctx = fakeAudioContext("interrupted");
    const onBlocked = vi.fn();
    await expect(
      ensurePlaybackContextRunning(ctx, "elevenlabs", onBlocked),
    ).resolves.toBeUndefined();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("fails closed for a closed context without attempting resume", async () => {
    const ctx = fakeAudioContext("closed");
    const onBlocked = vi.fn();
    await expect(
      ensurePlaybackContextRunning(ctx, "eliza-cloud", onBlocked),
    ).rejects.toThrow(/blocked/i);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it("fails closed with NotAllowedError and reports onBlocked when resume cannot unblock playback", async () => {
    const ctx = fakeAudioContext("suspended");
    ctx.resume = vi.fn(async () => {
      /* deliberately does not transition state — still blocked by autoplay policy */
    });
    const onBlocked = vi.fn();
    await expect(
      ensurePlaybackContextRunning(ctx, "local-inference", onBlocked),
    ).rejects.toThrow(/blocked/i);
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });
});

describe("PlaybackTapLifecycle", () => {
  function tap(lateAttachSafe = true): PlaybackFrameTap {
    return {
      lateAttachSafe,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    };
  }

  it("starts the resolved tap and arms the active-tap ref", async () => {
    const activeTapRef: { current: PlaybackFrameTap | null } = {
      current: null,
    };
    const lifecycle = new PlaybackTapLifecycle(activeTapRef);
    const resolvedTap = tap();
    await lifecycle.attach(Promise.resolve(resolvedTap));

    lifecycle.start(1_000);
    expect(resolvedTap.start).toHaveBeenCalledWith(1_000);
    expect(activeTapRef.current).toBe(resolvedTap);
    expect(lifecycle.current).toBe(resolvedTap);
  });

  it("finish() stops the tap and clears the ref only if it still owns it", async () => {
    const activeTapRef: { current: PlaybackFrameTap | null } = {
      current: null,
    };
    const lifecycle = new PlaybackTapLifecycle(activeTapRef);
    const resolvedTap = tap();
    await lifecycle.attach(Promise.resolve(resolvedTap));
    lifecycle.start(0);

    lifecycle.finish();
    expect(resolvedTap.stop).toHaveBeenCalledWith({ reset: true });
    expect(activeTapRef.current).toBeNull();
  });

  it("finish() does not clear a ref that another lifecycle already reassigned", async () => {
    const activeTapRef: { current: PlaybackFrameTap | null } = {
      current: null,
    };
    const lifecycle = new PlaybackTapLifecycle(activeTapRef);
    const resolvedTap = tap();
    await lifecycle.attach(Promise.resolve(resolvedTap));
    lifecycle.start(0);

    const otherTap = tap();
    activeTapRef.current = otherTap;
    lifecycle.finish();
    expect(activeTapRef.current).toBe(otherTap);
  });

  it("stops (rather than starts) a late tap that arrives after finish()", async () => {
    vi.useFakeTimers();
    try {
      const activeTapRef: { current: PlaybackFrameTap | null } = {
        current: null,
      };
      const lifecycle = new PlaybackTapLifecycle(activeTapRef);
      let resolveTap!: (t: PlaybackFrameTap) => void;
      const tapPromise = new Promise<PlaybackFrameTap>((resolve) => {
        resolveTap = resolve;
      });

      const pending = lifecycle.attach(tapPromise);
      await vi.advanceTimersByTimeAsync(150);
      await expect(pending).resolves.toBeNull();

      lifecycle.start(0);
      lifecycle.finish();

      const lateTap = tap();
      resolveTap(lateTap);
      await Promise.resolve();
      await Promise.resolve();

      expect(lateTap.stop).toHaveBeenCalledWith({ reset: true });
      expect(lateTap.start).not.toHaveBeenCalled();
      expect(activeTapRef.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a late tap that arrives before playback finishes, once playback has started", async () => {
    vi.useFakeTimers();
    try {
      const activeTapRef: { current: PlaybackFrameTap | null } = {
        current: null,
      };
      const lifecycle = new PlaybackTapLifecycle(activeTapRef);
      let resolveTap!: (t: PlaybackFrameTap) => void;
      const tapPromise = new Promise<PlaybackFrameTap>((resolve) => {
        resolveTap = resolve;
      });

      const pending = lifecycle.attach(tapPromise);
      await vi.advanceTimersByTimeAsync(150);
      await expect(pending).resolves.toBeNull();

      lifecycle.start(0);

      const lateTap = tap();
      resolveTap(lateTap);
      await Promise.resolve();
      await Promise.resolve();

      expect(lateTap.start).toHaveBeenCalled();
      expect(activeTapRef.current).toBe(lateTap);
      expect(lifecycle.current).toBe(lateTap);
    } finally {
      vi.useRealTimers();
    }
  });
});
