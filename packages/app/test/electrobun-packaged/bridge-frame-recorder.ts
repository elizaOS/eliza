/**
 * Bridge frame-pump video recorder for the packaged Electrobun desktop e2e lane.
 *
 * WHY a frame pump (and not Playwright `recordVideo` / CDP screencast):
 *   - The packaged desktop harness drives the app over a token-auth HTTP bridge
 *     (`packaged-app-helpers.ts`), NOT over CDP. Electrobun renders in a native
 *     WKWebView (macOS) / WebKitGTK (Linux) webview that exposes no CDP endpoint,
 *     so `Page.startScreencast` is unavailable.
 *   - Playwright `recordVideo` only records pages it launched; it cannot attach to
 *     a `connectOverCDP` session (microsoft/playwright#29065) and there is no CDP
 *     session here to attach to regardless.
 *   - macOS `screencapture -v` / ffmpeg avfoundation need the TCC screen-recording
 *     permission, which is unavailable/unattended on CI.
 * The one seam the bridge already exposes is `/main-window/screenshot` (base64
 * PNG). This recorder polls that seam at a fixed target rate, timestamps each
 * captured frame, and stitches the frames into a real-time MP4 with ffmpeg —
 * reusing the PNG->MP4 stitch approach already proven in `walkthrough-e2e.mjs`,
 * but preserving the true (non-uniform) capture intervals via the ffmpeg concat
 * demuxer's per-frame `duration` directives so playback runs at wall-clock speed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const LOG_PREFIX = "[BridgeFrameRecorder]";

function logInfo(message: string, context?: Record<string, unknown>): void {
  console.log(
    context
      ? `${LOG_PREFIX} ${message} ${JSON.stringify(context)}`
      : `${LOG_PREFIX} ${message}`,
  );
}

function logWarn(message: string, context?: Record<string, unknown>): void {
  console.warn(
    context
      ? `${LOG_PREFIX} ${message} ${JSON.stringify(context)}`
      : `${LOG_PREFIX} ${message}`,
  );
}

export interface BridgeFrameRecorderOptions {
  /**
   * Captures one frame as a PNG buffer. Typically wraps the packaged harness
   * `screenshot()` (strip the data-URL prefix + base64-decode). May reject on a
   * transient bridge hiccup; the recorder tolerates a bounded run of rejections
   * and fails loudly past the threshold.
   */
  captureFrame: () => Promise<Buffer>;
  /** Directory for the intermediate PNG frames + concat list (created if absent). */
  frameDir: string;
  /** Output MP4 path. */
  mp4Path: string;
  /**
   * Target capture rate (clamped to 3-12 fps). The single-threaded bridge shares
   * the webview with the driving `eval` calls, so a lower rate leaves headroom
   * for the walkthrough's DOM probes; the timestamp-based stitch resamples
   * whatever real rate is achieved back to a smooth real-time clip.
   */
  fps?: number;
  /**
   * Minimum gap between the END of one capture and the START of the next. Forces
   * a breather on the shared webview thread so concurrent bridge `eval` calls are
   * not starved by back-to-back screenshots.
   */
  minFrameGapMs?: number;
  /** Constant output frame rate the variable-interval frames are resampled to. */
  outputFps?: number;
  /**
   * Caps the on-screen duration of any single frame. Without a cap, a `pause()`
   * gap (during which the caller runs eval-heavy work with capture suspended)
   * would hold the last frame for the whole gap — a multi-second freeze. Capping
   * keeps the clip moving: paused time is elided, not frozen. Default 0.6s.
   */
  maxFrameDurationSeconds?: number;
  /**
   * Physical-pixel rectangle to crop each frame to before stitching. The bridge
   * screenshot on macOS captures the whole display; cropping to the app window's
   * bounds (× devicePixelRatio) keeps the clip focused on the app. Omit to keep
   * the full frame.
   */
  cropRect?: { x: number; y: number; width: number; height: number };
  /** Consecutive capture failures tolerated before the recording fails loudly. */
  maxConsecutiveFailures?: number;
  /** ffmpeg binary (defaults to `ffmpeg` resolved from PATH). */
  ffmpegPath?: string;
  /** Label used in structured logs to distinguish concurrent recorders. */
  label?: string;
}

export interface BridgeFrameRecordingResult {
  mp4Path: string;
  frameDir: string;
  frameCount: number;
  /** Wall-clock span the recording covers (sum of per-frame intervals). */
  durationSeconds: number;
  /** Frames actually captured per second over the recording window. */
  capturedFps: number;
}

export interface BridgeFrameRecording {
  /**
   * Suspends capture without ending the recording. Use around eval-heavy work on
   * a single-threaded bridge so screenshots do not starve the driving RPCs.
   */
  pause(): void;
  /** Resumes capture after {@link pause}. */
  resume(): void;
  /** Stops the pump, stitches the MP4, and resolves with the recording stats. */
  stop(): Promise<BridgeFrameRecordingResult>;
}

interface CapturedFrame {
  file: string;
  /** Capture start, in seconds relative to the first captured frame. */
  offsetSeconds: number;
}

function resolveFfmpeg(explicit: string | undefined): string {
  if (explicit) return explicit;
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "ffmpeg");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${LOG_PREFIX} ffmpeg was not found on PATH. Install ffmpeg (macOS: \`brew install ffmpeg\`; ` +
      `Debian/CI: \`apt-get install -y ffmpeg\`) or pass ffmpegPath.`,
  );
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(stderr.length - 20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${LOG_PREFIX} ffmpeg exited with code ${code}. Args: ${args.join(" ")}\n${stderr.trim()}`,
        ),
      );
    });
  });
}

/**
 * Starts polling `captureFrame` at the target rate. The returned handle's
 * `stop()` halts the pump and stitches the MP4. The pump keeps running across
 * whatever the caller does between start and stop (drive the app, wait for
 * state), so the video covers the full interaction — not a fixed clip.
 */
export function startBridgeFrameRecording(
  options: BridgeFrameRecorderOptions,
): BridgeFrameRecording {
  const fps = Math.min(12, Math.max(3, options.fps ?? 10));
  const outputFps = options.outputFps ?? 30;
  const intervalMs = 1000 / fps;
  const minFrameGapMs = Math.max(0, options.minFrameGapMs ?? 0);
  const maxFrameDurationSeconds = Math.max(
    0.05,
    options.maxFrameDurationSeconds ?? 0.6,
  );
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 12;
  const ffmpegPath = resolveFfmpeg(options.ffmpegPath);
  const label = options.label ?? "desktop-bridge";

  const frames: CapturedFrame[] = [];
  let frameIndex = 0;
  let consecutiveFailures = 0;
  let totalFailures = 0;
  let fatalError: Error | null = null;
  let stopped = false;
  let paused = false;
  let recordingStartedAt: number | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const ensureDirs = fs.mkdir(options.frameDir, { recursive: true });

  async function captureOnce(): Promise<void> {
    let buffer: Buffer;
    try {
      buffer = await options.captureFrame();
    } catch (error) {
      if (stopped) return;
      consecutiveFailures += 1;
      totalFailures += 1;
      if (consecutiveFailures > maxConsecutiveFailures) {
        fatalError = new Error(
          `${LOG_PREFIX} ${consecutiveFailures} consecutive frame captures failed ` +
            `(threshold ${maxConsecutiveFailures}); the bridge screenshot seam is not ` +
            `responding. Last error: ${error instanceof Error ? error.message : String(error)}`,
        );
        stopped = true;
      } else {
        logWarn("frame capture failed; will retry", {
          label,
          consecutiveFailures,
          maxConsecutiveFailures,
        });
      }
      return;
    }

    if (stopped) return;
    consecutiveFailures = 0;
    const now = Date.now();
    recordingStartedAt ??= now;
    await ensureDirs;
    const file = `frame-${String(frameIndex).padStart(6, "0")}.png`;
    await fs.writeFile(path.join(options.frameDir, file), buffer);
    frames.push({ file, offsetSeconds: (now - recordingStartedAt) / 1000 });
    frameIndex += 1;
  }

  function scheduleNext(): void {
    if (stopped) return;
    // While paused, hold off capture entirely (leave the bridge free for evals)
    // and re-check on the interval.
    if (paused) {
      timer = setTimeout(scheduleNext, intervalMs);
      return;
    }
    timer = setTimeout(() => {
      const tickStartedAt = Date.now();
      inFlight = captureOnce().then(() => {
        if (stopped) return;
        const elapsed = Date.now() - tickStartedAt;
        // Self-scheduling (not setInterval): a slow bridge screenshot cannot
        // stack up overlapping captures; the next frame fires as soon as the
        // remaining interval elapses (immediately if capture overran it), but
        // never before `minFrameGapMs` so the shared webview thread always gets
        // a window for the walkthrough's concurrent `eval` calls.
        const wait = Math.max(minFrameGapMs, intervalMs - elapsed);
        if (!stopped) {
          timer = setTimeout(scheduleNext, wait);
        }
      });
    }, 0);
  }

  logInfo("recording started", {
    label,
    fps,
    outputFps,
    frameDir: options.frameDir,
  });
  scheduleNext();

  async function stop(): Promise<BridgeFrameRecordingResult> {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await inFlight.catch(() => undefined);

    if (fatalError) {
      throw fatalError;
    }
    if (frames.length === 0) {
      throw new Error(
        `${LOG_PREFIX} no frames were captured for "${label}"; the bridge screenshot ` +
          `seam never returned a usable frame.`,
      );
    }

    // Per-frame display durations from the real capture offsets, clamped to
    // `maxFrameDurationSeconds` so a paused gap (eval-heavy work with capture
    // suspended) is elided rather than frozen on the last frame. The concat
    // demuxer ignores the LAST entry's duration, so the final frame is repeated
    // with a synthetic tail equal to the median interval.
    const intervals: number[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      const raw = frames[i].offsetSeconds - frames[i - 1].offsetSeconds;
      intervals.push(Math.min(maxFrameDurationSeconds, Math.max(0.001, raw)));
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const medianInterval =
      sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1 / fps;
    const tailSeconds = Math.max(0.05, medianInterval);

    const listPath = path.join(options.frameDir, "frames.concat");
    const listLines = ["ffconcat version 1.0"];
    for (let i = 0; i < frames.length; i += 1) {
      listLines.push(`file '${frames[i].file}'`);
      const duration = i < frames.length - 1 ? intervals[i] : tailSeconds;
      listLines.push(`duration ${duration.toFixed(4)}`);
    }
    // Repeat the last frame so its `duration` is honoured (concat demuxer quirk).
    listLines.push(`file '${frames[frames.length - 1].file}'`);
    await fs.writeFile(listPath, `${listLines.join("\n")}\n`, "utf8");

    const durationSeconds =
      frames.length > 1
        ? intervals.reduce((sum, value) => sum + value, 0) + tailSeconds
        : tailSeconds;

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-vf",
      // Optional crop to the app window, then even dims (yuv420p requires them)
      // + resample the variable-interval frames to a constant output rate so the
      // clip plays at real wall-clock speed.
      [
        options.cropRect
          ? `crop=${Math.round(options.cropRect.width)}:${Math.round(options.cropRect.height)}:${Math.round(options.cropRect.x)}:${Math.round(options.cropRect.y)}`
          : null,
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        `fps=${outputFps}`,
        "format=yuv420p",
      ]
        .filter(Boolean)
        .join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-movflags",
      "+faststart",
      options.mp4Path,
    ]);

    if (!existsSync(options.mp4Path)) {
      throw new Error(
        `${LOG_PREFIX} ffmpeg reported success but produced no MP4 at ${options.mp4Path}`,
      );
    }

    const capturedFps =
      durationSeconds > 0 ? frames.length / durationSeconds : frames.length;
    const result: BridgeFrameRecordingResult = {
      mp4Path: options.mp4Path,
      frameDir: options.frameDir,
      frameCount: frames.length,
      durationSeconds,
      capturedFps,
    };
    logInfo("recording stitched", {
      label,
      frameCount: result.frameCount,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      capturedFps: Number(capturedFps.toFixed(2)),
      totalFailures,
      mp4Path: options.mp4Path,
    });
    return result;
  }

  function pause(): void {
    paused = true;
  }
  function resume(): void {
    paused = false;
  }

  return { pause, resume, stop };
}
