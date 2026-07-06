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
  await execFileAsync("ffmpeg", args);
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
  it("uses installed bundled binaries when PATH does not provide system tools", async () => {
    const prevPath = process.env.PATH;
    const prevFfmpeg = process.env.ELIZA_FFMPEG_BIN;
    const prevFfprobe = process.env.ELIZA_FFPROBE_BIN;
    delete process.env.ELIZA_FFMPEG_BIN;
    delete process.env.ELIZA_FFPROBE_BIN;
    process.env.PATH = "";
    try {
      const ffprobe = await resolveFfprobeBinary();
      expect(ffprobe.available).toBe(true);
      if (ffprobe.available) expect(ffprobe.source).toBe("bundled");

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
  });

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
