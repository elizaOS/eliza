// Video normalization against tiny videos generated in-test with ffmpeg. The
// whole ffmpeg-backed suite is skipped with an explicit reason when ffmpeg is
// absent (never a fabricated pass); when present it asserts probe correctness,
// pass-through for an already-canonical mp4, remux for a non-faststart mp4, and
// transcode for a webm. The skipped-missing-tool path is asserted separately by
// overriding the binary names to a nonexistent command.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveFfmpegBinary,
  resolveFfprobeBinary,
} from "../ffmpeg-binaries.ts";
import {
  normalizeVideo,
  probeVideo,
  videoToolsAvailable,
} from "./normalize.ts";

const execFileAsync = promisify(execFile);
const dir = mkdtempSync(join(os.tmpdir(), "evidence-normalize-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tools = await videoToolsAvailable();
// Generate clips with the SAME binaries the code under test resolves: the gate
// above accepts env/PATH/bundled tools, so hardcoded "ffmpeg"/"ffprobe" would
// fail (instead of honestly skipping) on machines with only the bundled ones.
const ffmpeg = await resolveFfmpegBinary();
const ffmpegBin = ffmpeg.available ? ffmpeg.bin : "ffmpeg";
const ffprobe = await resolveFfprobeBinary();
const ffprobeBin = ffprobe.available ? ffprobe.bin : "ffprobe";

/** Solid-colour clip in the requested container/codec/faststart layout. */
async function makeClip(
  out: string,
  {
    color = "red",
    codec = "libx264",
    faststart = true,
  }: { color?: string; codec?: string; faststart?: boolean } = {},
): Promise<void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x64:d=1`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    codec,
  ];
  if (out.endsWith(".mp4") && faststart) args.push("-movflags", "+faststart");
  args.push(out);
  await execFileAsync(ffmpegBin, args);
}

/** h264 mp4 with one video + two aac audio streams, without faststart. */
async function makeTwoAudioMp4(out: string): Promise<void> {
  await execFileAsync(ffmpegBin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=1",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:a",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    out,
  ]);
}

/** Count of streams per codec_type as ffprobe reports them. */
async function countStreams(file: string): Promise<Record<string, number>> {
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: { codec_type?: string }[];
  };
  const counts: Record<string, number> = {};
  for (const stream of parsed.streams ?? []) {
    const type = stream.codec_type ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

describe.skipIf(!tools.available)("normalizeVideo (ffmpeg present)", () => {
  it("probes an mp4 as h264 with faststart", async () => {
    const clip = join(dir, "probe.mp4");
    await makeClip(clip);
    const probe = await probeVideo(clip);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.formatName).toMatch(/mp4/);
    expect(probe.faststart).toBe(true);
  });

  it("detects a non-faststart mp4 (moov after mdat)", async () => {
    const clip = join(dir, "nofast.mp4");
    await makeClip(clip, { faststart: false });
    const probe = await probeVideo(clip);
    expect(probe.faststart).toBe(false);
  });

  it("copies through an already-canonical h264+faststart mp4", async () => {
    const clip = join(dir, "canonical.mp4");
    await makeClip(clip);
    const out = join(dir, "canonical-out.mp4");
    const result = await normalizeVideo(clip, out);
    expect(result.status).toBe("copied");
    expect(existsSync(out)).toBe(true);
    // Copy-through is byte-identical to the source.
    const [a, b] = await Promise.all([probeVideo(clip), probeVideo(out)]);
    expect(b.videoCodec).toBe(a.videoCodec);
    expect(b.faststart).toBe(true);
  });

  it("remuxes a non-faststart h264 mp4 to faststart without re-encoding", async () => {
    const clip = join(dir, "remux-in.mp4");
    await makeClip(clip, { faststart: false });
    const out = join(dir, "remux-out.mp4");
    const result = await normalizeVideo(clip, out);
    expect(result.status).toBe("remuxed");
    const probe = await probeVideo(out);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.faststart).toBe(true);
  });

  it("remux keeps every non-subtitle stream (both audio tracks survive)", async () => {
    const clip = join(dir, "two-audio.mp4");
    await makeTwoAudioMp4(clip);
    expect((await countStreams(clip)).audio).toBe(2);
    const out = join(dir, "two-audio-out.mp4");
    const result = await normalizeVideo(clip, out);
    expect(result.status).toBe("remuxed");
    // Without `-map 0` ffmpeg keeps one stream per type and the second audio
    // track would be silently dropped from the evidence.
    const counts = await countStreams(out);
    expect(counts.video).toBe(1);
    expect(counts.audio).toBe(2);
  });

  it("transcodes a webm to canonical h264+faststart mp4", async () => {
    const clip = join(dir, "in.webm");
    await makeClip(clip, { color: "blue", codec: "libvpx-vp9" });
    const out = join(dir, "transcoded.mp4");
    const result = await normalizeVideo(clip, out);
    expect(result.status).toBe("transcoded");
    const probe = await probeVideo(out);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.faststart).toBe(true);
  });
});

describe("normalizeVideo degradation", () => {
  it("uses bundled binaries when installed and otherwise reports honest unavailability", async () => {
    const prevPath = process.env.PATH;
    const prevFfmpeg = process.env.ELIZA_FFMPEG_BIN;
    const prevFfprobe = process.env.ELIZA_FFPROBE_BIN;
    delete process.env.ELIZA_FFMPEG_BIN;
    delete process.env.ELIZA_FFPROBE_BIN;
    process.env.PATH = "";
    try {
      const ffprobe = await resolveFfprobeBinary();
      if (ffprobe.available) {
        expect(ffprobe.source).toBe("bundled");
      } else {
        expect(ffprobe.reason).toMatch(
          /ffprobe (not found on PATH and bundled ffprobe-static package is unavailable|system binary missing and bundled binary failed)/,
        );
      }

      const ffmpeg = await resolveFfmpegBinary();
      if (ffmpeg.available) {
        expect(ffmpeg.source).toBe("bundled");
      } else {
        expect(ffmpeg.reason).toMatch(
          /bundled ffmpeg-static package is unavailable/,
        );
      }
    } finally {
      restoreEnv("PATH", prevPath);
      restoreEnv("ELIZA_FFMPEG_BIN", prevFfmpeg);
      restoreEnv("ELIZA_FFPROBE_BIN", prevFfprobe);
    }
  }, 150_000);

  it("skips honestly when ffprobe/ffmpeg are absent", async () => {
    const prevFfmpeg = process.env.ELIZA_FFMPEG_BIN;
    const prevFfprobe = process.env.ELIZA_FFPROBE_BIN;
    process.env.ELIZA_FFMPEG_BIN = "definitely-not-a-real-binary-xyz";
    process.env.ELIZA_FFPROBE_BIN = "definitely-not-a-real-binary-xyz";
    try {
      const result = await normalizeVideo(
        join(dir, "irrelevant.webm"),
        join(dir, "out.mp4"),
      );
      expect(result.status).toBe("skipped-missing-tool");
      if (result.status === "skipped-missing-tool") {
        expect(result.reason).toMatch(/not installed/);
      }
    } finally {
      restoreEnv("ELIZA_FFMPEG_BIN", prevFfmpeg);
      restoreEnv("ELIZA_FFPROBE_BIN", prevFfprobe);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
