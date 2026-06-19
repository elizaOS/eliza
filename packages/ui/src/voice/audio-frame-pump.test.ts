/**
 * AudioFramePump unit tests (mocked TalkMode plugin + fetch).
 *
 * Asserts the WebView → agent pump contract:
 *   - subscribes to `audioFrame`, starts native capture, batches frames, and
 *     POSTs them to /api/voice/audio-frames (batched, not per-frame);
 *   - forces a flush at the size cap;
 *   - sends a final flush:true batch and stops native capture on stop();
 *   - no-ops cleanly on a plugin without startAudioFrames (web/desktop).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TalkModeAudioFrameEvent,
  TalkModePluginLike,
} from "../bridge/native-plugins";
import { AudioFramePump } from "./audio-frame-pump";

interface SentBatch {
  frames: TalkModeAudioFrameEvent[];
  flush: boolean;
}

function frame(i: number): TalkModeAudioFrameEvent {
  return {
    pcm16: "AA==",
    sampleRate: 16_000,
    channels: 1,
    samples: 320,
    rms: 0.01,
    timestamp: i * 20,
    frameIndex: i,
  };
}

/** A fake TalkMode plugin that captures the audioFrame listener so a test can
 *  drive frames into it, and records start/stop calls. */
function makeFakePlugin(opts: { supportsAudioFrames?: boolean } = {}) {
  let listener: ((e: TalkModeAudioFrameEvent) => void) | null = null;
  const calls = { start: 0, stop: 0, removed: 0, suspendedStt: false };
  const plugin = {
    addListener: vi.fn(
      async (_name: string, fn: (e: TalkModeAudioFrameEvent) => void) => {
        listener = fn;
        return {
          remove: async () => {
            calls.removed += 1;
            listener = null;
          },
        };
      },
    ),
    ...(opts.supportsAudioFrames === false
      ? {}
      : {
          startAudioFrames: vi.fn(async () => {
            calls.start += 1;
            return { started: true, suspendedStt: true };
          }),
          stopAudioFrames: vi.fn(async () => {
            calls.stop += 1;
          }),
        }),
  } as unknown as TalkModePluginLike;
  return {
    plugin,
    calls,
    emit: (e: TalkModeAudioFrameEvent) => listener?.(e),
    hasListener: () => listener != null,
  };
}

let sent: SentBatch[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as SentBatch;
      sent.push(body);
      const framesReceived = sent.reduce((n, b) => n + b.frames.length, 0);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, framesReceived, turnsObserved: 0 }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AudioFramePump", () => {
  it("no-ops cleanly when the plugin has no startAudioFrames (web/desktop)", async () => {
    const { plugin } = makeFakePlugin({ supportsAudioFrames: false });
    const pump = new AudioFramePump(plugin);
    const result = await pump.start();
    expect(result.started).toBe(false);
    expect(result.error).toMatch(/not supported/);
    expect(pump.isRunning).toBe(false);
  });

  it("subscribes, starts capture, and reports STT suspension", async () => {
    const { plugin, calls, hasListener } = makeFakePlugin();
    const pump = new AudioFramePump(plugin);
    const result = await pump.start();
    expect(result.started).toBe(true);
    expect(result.suspendedStt).toBe(true);
    expect(calls.start).toBe(1);
    expect(hasListener()).toBe(true);
    await pump.stop();
  });

  it("batches frames (one POST for many frames) and flushes the tail on stop", async () => {
    const { plugin, emit, calls } = makeFakePlugin();
    const pump = new AudioFramePump(plugin);
    await pump.start();
    // 10 frames — below the size cap, so nothing posts until the timer or stop.
    for (let i = 0; i < 10; i++) emit(frame(i));
    expect(sent.length).toBe(0);
    await pump.stop();
    // One batch on stop carrying all 10 frames, with flush:true.
    const allFrames = sent.flatMap((b) => b.frames);
    expect(allFrames.length).toBe(10);
    expect(sent.at(-1)?.flush).toBe(true);
    expect(calls.stop).toBe(1);
    expect(calls.removed).toBe(1);
  });

  it("forces a flush when the buffer hits the size cap", async () => {
    const { plugin, emit } = makeFakePlugin();
    const pump = new AudioFramePump(plugin);
    await pump.start();
    // 49 frames trips MAX_BATCH_FRAMES → an immediate (non-final) POST.
    for (let i = 0; i < 49; i++) emit(frame(i));
    // Let the queued flush microtask settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0].frames.length).toBe(49);
    expect(sent[0].flush).toBe(false);
    await pump.stop();
    expect(pump.framesAcked).toBe(49);
  });

  it("ignores frames after stop", async () => {
    const { plugin, emit } = makeFakePlugin();
    const pump = new AudioFramePump(plugin);
    await pump.start();
    await pump.stop();
    emit(frame(100));
    expect(sent.flatMap((b) => b.frames).length).toBe(0);
  });
});
