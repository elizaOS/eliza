/**
 * Error-path test for `StreamManager.writeFrame` (#12746 / #12275-H).
 *
 * When the FFmpeg encode pipe breaks mid-stream (e.g. FFmpeg dies), a
 * `stdin.write` throws. The previous `catch { return false }` silently dropped
 * every subsequent frame, so a dead pipe looked identical to an idle stream —
 * exactly the "failures must not masquerade as idle/success" case the issue
 * calls out. The fix keeps the `false` return contract but surfaces the write
 * failure via a throttled `logger.warn`.
 *
 * The exported singleton's private FFmpeg handle is stubbed with a fake
 * `ChildProcess` whose `stdin.write` throws; no real FFmpeg is spawned.
 */
import { describe, expect, it, vi } from "vitest";

const warn = vi.fn();
// Pass real `@elizaos/core` through (transitively pulled by stream-manager ->
// tts-stream-bridge -> @elizaos/shared) and override only `logger` so the
// broken-pipe warning is observable.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: {
      warn: (...args: unknown[]) => warn(...args),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import { streamManager } from "./stream-manager.js";

/** Install a fake, "running" FFmpeg whose stdin.write throws. */
function armBrokenPipe(mgr: unknown) {
  const m = mgr as Record<string, unknown>;
  m._running = true;
  m._frameWriteErrorCount = 0;
  m.ffmpeg = {
    killed: false,
    exitCode: null,
    stdin: {
      write: () => {
        throw new Error("EPIPE: broken pipe");
      },
    },
  };
}

function disarm(mgr: unknown) {
  const m = mgr as Record<string, unknown>;
  m._running = false;
  m.ffmpeg = null;
  m._frameWriteErrorCount = 0;
}

describe("StreamManager.writeFrame — broken FFmpeg pipe is observable", () => {
  it("returns false AND warns on the first write failure", () => {
    warn.mockClear();
    armBrokenPipe(streamManager);
    try {
      const ok = streamManager.writeFrame(Buffer.from([0xff, 0xd8]));
      expect(ok).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "Failed to write frame to FFmpeg stdin",
      );
      expect(String(warn.mock.calls[0]?.[0])).toContain("EPIPE");
    } finally {
      disarm(streamManager);
    }
  });

  it("throttles repeated failures (does not log one line per dropped frame)", () => {
    warn.mockClear();
    armBrokenPipe(streamManager);
    try {
      for (let i = 0; i < 50; i++) {
        expect(streamManager.writeFrame(Buffer.from([0xff]))).toBe(false);
      }
      // First failure logs; the next 49 within the throttle window do not.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      disarm(streamManager);
    }
  });

  it("returns false without warning when the stream is not running (expected, not a failure)", () => {
    warn.mockClear();
    disarm(streamManager);
    expect(streamManager.writeFrame(Buffer.from([0xff]))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("resets the throttle on stop() so a restarted stream still surfaces its first failure", async () => {
    warn.mockClear();
    armBrokenPipe(streamManager);
    try {
      // First stream: one broken-pipe write (warns, counter now 1).
      expect(streamManager.writeFrame(Buffer.from([0xff]))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      // Provide a fake FFmpeg that stops cleanly so stop() can run its reset.
      const m = streamManager as unknown as Record<string, unknown>;
      m.ffmpeg = {
        killed: false,
        exitCode: 0,
        stdin: { end: () => {} },
        kill: () => {},
        on: (_event: string, cb: () => void) => cb(),
      };
      await streamManager.stop();
      expect((m._frameWriteErrorCount as number) ?? 0).toBe(0);

      // Restarted stream: the very first broken-pipe write must warn again,
      // not be silently mis-counted as a continuation of the old stream.
      warn.mockClear();
      armBrokenPipe(streamManager);
      expect(streamManager.writeFrame(Buffer.from([0xff]))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      disarm(streamManager);
    }
  });
});
