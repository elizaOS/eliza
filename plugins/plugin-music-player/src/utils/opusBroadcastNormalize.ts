import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { logger } from "@elizaos/core";
import {
  augmentEnvWithFfmpegTools,
  resolveFfmpegBinaryPath,
} from "./ffmpegEnv";
import { formatMusicDebugCommand, musicDebug } from "./musicDebug";

/** Attached to ffmpeg stdout when normalize is active. */
export const OPUS_NORMALIZE_FFMPEG = Symbol("elizaOpusNormalizeFfmpeg");
/** Upstream readable fed into ffmpeg stdin. */
export const OPUS_NORMALIZE_INPUT = Symbol("elizaOpusNormalizeInput");

/** Ogg page sync: "OggS" */
function isOggOpusPrefix(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x4f &&
    buf[1] === 0x67 &&
    buf[2] === 0x67 &&
    buf[3] === 0x53
  );
}

/** WebM/Matroska EBML header */
function isWebmPrefix(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  );
}

function isBroadcastNormalizeEnabled(): boolean {
  const v = process.env.ELIZA_MUSIC_BROADCAST_NORMALIZE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") {
    return false;
  }
  return true;
}

/**
 * Spawn ffmpeg to:
 * 1. `-re`  — read input at native frame rate (real-time throttle)
 * 2. `-c:a copy -f opus` — remux to Ogg Opus without re-encoding
 *
 * This keeps the broadcast alive for the full track duration instead of
 * dumping file data in a burst. `-re` is how Icecast/Shoutcast relays work.
 */
function spawnFfmpegRealtimeRelay(
  bufferedPrefix: Buffer,
  source: Readable,
  output: PassThrough,
  inputFormat: string | null,
): void {
  const ffmpegPath = resolveFfmpegBinaryPath();
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-re"];
  if (inputFormat) {
    args.push("-f", inputFormat);
  }
  args.push("-i", "pipe:0", "-vn", "-c:a", "copy", "-f", "ogg", "pipe:1");

  let ff: ChildProcessWithoutNullStreams;
  try {
    ff = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: augmentEnvWithFfmpegTools(),
    }) as ChildProcessWithoutNullStreams;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    musicDebug("broadcast ffmpeg spawn threw", {
      command: formatMusicDebugCommand(ffmpegPath, args),
      error: msg,
    });
    logger.warn(
      `[music] ffmpeg broadcast relay spawn failed (${msg}); falling back to raw pipe`,
    );
    if (bufferedPrefix.length > 0) {
      output.write(bufferedPrefix);
    }
    source.pipe(output);
    (output as Readable & { [OPUS_NORMALIZE_INPUT]?: Readable })[
      OPUS_NORMALIZE_INPUT
    ] = source;
    return;
  }

  musicDebug("broadcast ffmpeg -re relay spawn", {
    command: formatMusicDebugCommand(ffmpegPath, args),
    inputFormat: inputFormat ?? "auto-probe",
  });

  let stderrAcc = "";
  ff.stderr?.on("data", (ch: Buffer) => {
    stderrAcc += ch.toString();
  });

  ff.on("error", (err) => {
    logger.error(`[music] ffmpeg relay error: ${err.message}`);
    musicDebug("broadcast ffmpeg relay error", {
      message: err.message,
      command: formatMusicDebugCommand(ffmpegPath, args),
      stderr: stderrAcc,
    });
    if (!source.destroyed) {
      source.destroy();
    }
    if (!output.destroyed) {
      output.destroy(err);
    }
  });

  ff.on("exit", (code, signal) => {
    if (signal === "SIGKILL") {
      return;
    }
    const stderr = stderrAcc.trimEnd();
    if (code !== 0 && code !== null) {
      const tail = stderr.slice(-400);
      logger.warn(
        `[music] ffmpeg relay exited code=${code}: ${tail || "(no stderr)"}`,
      );
    }
    if ((code !== 0 && code !== null) || stderr.length > 0) {
      musicDebug("broadcast ffmpeg relay exit", {
        code,
        signal: signal ?? undefined,
        command: formatMusicDebugCommand(ffmpegPath, args),
        stderr: stderrAcc,
      });
    }
  });

  (
    output as Readable & {
      [OPUS_NORMALIZE_FFMPEG]?: ChildProcessWithoutNullStreams;
      [OPUS_NORMALIZE_INPUT]?: Readable;
    }
  )[OPUS_NORMALIZE_FFMPEG] = ff;
  (output as Readable & { [OPUS_NORMALIZE_INPUT]?: Readable })[
    OPUS_NORMALIZE_INPUT
  ] = source;

  if (bufferedPrefix.length > 0) {
    ff.stdin.write(bufferedPrefix);
  }
  source.pipe(ff.stdin);
  ff.stdin.on("error", () => {
    /* EPIPE when upstream ends is normal */
  });

  ff.stdout.pipe(output);
  ff.stdout.on("end", () => {
    if (!output.writableEnded) {
      output.end();
    }
  });
  ff.stdout.on("error", (err: Error) => {
    if (!output.destroyed) {
      output.destroy(err);
    }
  });
}

/**
 * Normalize + throttle audio for the broadcast pipeline.
 *
 * Every source — Ogg Opus (yt-dlp cache/temp) **and** WebM/Opus (play-dl) — is
 * piped through `ffmpeg -re -c:a copy -f opus pipe:1`. The `-re` flag makes ffmpeg
 * read the input at native frame rate, so the broadcast emits data at real-time
 * playback speed instead of dumping the whole file in a burst.
 *
 * Without `-re`, file-backed streams (e.g. a 52-second cached Opus) complete in
 * milliseconds of wall time, leaving HTTP subscribers with a data burst they can't
 * decode as a live stream and causing `[StreamCore] Track stream ended` immediately.
 *
 * Disable with `ELIZA_MUSIC_BROADCAST_NORMALIZE=0` if you need raw passthrough
 * (only useful for Discord-only setups where the voiceManager controls pacing).
 */
export function normalizeOpusBroadcastStream(source: Readable): Readable {
  if (!isBroadcastNormalizeEnabled()) {
    return source;
  }

  const output = new PassThrough({ highWaterMark: 128 * 1024 });
  const chunks: Buffer[] = [];
  let decided = false;

  const cleanupListeners = (): void => {
    source.removeListener("data", onData);
    source.removeListener("end", onEnd);
    source.removeListener("error", onErr);
  };

  const onData = (chunk: Buffer): void => {
    if (decided) {
      return;
    }
    chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (buf.length < 4) {
      return;
    }

    decided = true;
    cleanupListeners();

    const inputFormat = isOggOpusPrefix(buf)
      ? "ogg"
      : isWebmPrefix(buf)
        ? "webm"
        : null;

    musicDebug("broadcast normalize relay", {
      inputFormat: inputFormat ?? "auto-probe",
      prefixBytes: buf.length,
    });

    spawnFfmpegRealtimeRelay(buf, source, output, inputFormat);
  };

  const onEnd = (): void => {
    if (decided) {
      return;
    }
    decided = true;
    cleanupListeners();
    const buf = Buffer.concat(chunks);
    musicDebug("broadcast normalize EOF before 4-byte magic", {
      buffered: buf.length,
    });
    if (buf.length > 0) {
      output.write(buf);
    }
    if (!output.writableEnded) {
      output.end();
    }
    (output as Readable & { [OPUS_NORMALIZE_INPUT]?: Readable })[
      OPUS_NORMALIZE_INPUT
    ] = source;
  };

  const onErr = (err: Error): void => {
    if (decided) {
      return;
    }
    decided = true;
    cleanupListeners();
    output.destroy(err);
  };

  source.on("data", onData);
  source.on("end", onEnd);
  source.on("error", onErr);

  queueMicrotask(() => {
    if (source.readableEnded && !decided) {
      onEnd();
    }
  });

  return output;
}
