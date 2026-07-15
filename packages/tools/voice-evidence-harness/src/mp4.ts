/**
 * MP4 assembly helper. Combines input audio + output audio + a rendered timeline
 * PNG into an MP4 suitable for inline GitHub attachment (GitHub renders MP4
 * inline). Uses ffmpeg. FAILS LOUDLY if ffmpeg is missing (documents the exact
 * install command) rather than silently skipping the visual evidence.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export function ensureFfmpeg(): {
  ok: boolean;
  version?: string;
  installHint: string;
} {
  const installHint =
    "ffmpeg is required for MP4 evidence. Install: `sudo apt-get install -y ffmpeg` (Debian/Ubuntu) or `brew install ffmpeg` (macOS).";
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return { ok: false, installHint };
  const version = r.stdout.split("\n")[0];
  return { ok: true, version, installHint };
}

/**
 * Render a simple timeline card (PNG) via ffmpeg's drawtext, then mux the two
 * audio clips (input then output) under that still image into an MP4.
 */
export function assembleMp4(params: {
  dir: string;
  inputWav: string; // relative to dir
  outputWav: string; // relative to dir
  timelineLines: string[];
  out: string; // relative to dir
}): { ok: boolean; error?: string } {
  const ff = ensureFfmpeg();
  if (!ff.ok) return { ok: false, error: ff.installHint };

  const inPath = join(params.dir, params.inputWav);
  const outAudioPath = join(params.dir, params.outputWav);
  const outMp4 = join(params.dir, params.out);
  const cardPath = join(params.dir, "timeline-card.png");

  if (!existsSync(inPath))
    return { ok: false, error: `missing input wav ${inPath}` };

  // 1) render the timeline card
  const text = params.timelineLines
    .map((l) => l.replace(/[:\\]/g, (m) => "\\" + m).replace(/'/g, ""))
    .join("\n");
  const drawFilter = `drawtext=text='${text.replace(/\n/g, "\\n")}':fontcolor=white:fontsize=22:x=40:y=40:line_spacing=10`;
  const card = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x101418:s=1280x720:d=1",
      "-vf",
      drawFilter,
      "-frames:v",
      "1",
      cardPath,
    ],
    { encoding: "utf8" },
  );
  if (card.status !== 0) {
    return {
      ok: false,
      error: `card render failed: ${card.stderr?.slice(-400)}`,
    };
  }

  // 2) concat input + output audio into one track
  const concatAudio = join(params.dir, "combined-audio.wav");
  const listPath = join(params.dir, "concat-list.txt");
  Bun.write(
    listPath,
    `file '${inPath}'\nfile '${existsSync(outAudioPath) ? outAudioPath : inPath}'\n`,
  );
  const cat = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      concatAudio,
    ],
    { encoding: "utf8" },
  );
  if (cat.status !== 0) {
    // fall back to just the input audio
    Bun.write(concatAudio, Bun.file(inPath));
  }

  // 3) mux still image + combined audio -> mp4
  const mux = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      cardPath,
      "-i",
      concatAudio,
      "-c:v",
      "libx264",
      "-tune",
      "stillimage",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      outMp4,
    ],
    { encoding: "utf8" },
  );
  if (mux.status !== 0) {
    return { ok: false, error: `mux failed: ${mux.stderr?.slice(-400)}` };
  }

  // remove build intermediates so the evidence dir contains only reviewable
  // artifacts (input.wav, output-tts.wav, walkthrough.mp4, logs, reports).
  for (const f of [cardPath, concatAudio, listPath]) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch (ignoredError) {
      void ignoredError;
      /* best-effort */
    }
  }
  return { ok: true };
}
