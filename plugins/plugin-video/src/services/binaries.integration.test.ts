/**
 * Integration test: runs the BinaryResolver against real binaries on the host.
 *
 * Skipped by default. Enable with `ELIZA_VIDEO_INTEGRATION_TEST=1` to:
 *   - resolve yt-dlp via env / managed cache / PATH (real I/O)
 *   - resolve ffmpeg via env / PATH / ffmpeg-static (real I/O)
 *   - invoke yt-dlp on a known stable YouTube URL
 *   - assert metadata (title) comes back from real extraction
 *
 * Network and binary-availability dependent; run locally before shipping.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BinaryResolver } from "./binaries.js";

const enabled = process.env.ELIZA_VIDEO_INTEGRATION_TEST === "1";
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration("BinaryResolver integration", () => {
  it("resolves a yt-dlp binary path on the host", async () => {
    const r = new BinaryResolver();
    const ytDlpPath = await r.getYtDlpPath();
    expect(ytDlpPath.length).toBeGreaterThan(0);
    const stat = await fsp.stat(ytDlpPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it("resolves an ffmpeg binary path on the host", async () => {
    const r = new BinaryResolver();
    const ffmpegPath = await r.getFfmpegPath();
    expect(ffmpegPath).toBeTruthy();
    const stat = await fsp.stat(ffmpegPath as string);
    expect(stat.isFile()).toBe(true);
  });

  it("fetches metadata for a known stable YouTube video via real yt-dlp", async () => {
    const r = new BinaryResolver();
    const result = (await r.runYtDlp(
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      { dumpJson: true, skipDownload: true, noCheckCertificates: true },
    )) as { title?: string; uploader?: string };
    expect(typeof result).toBe("object");
    expect(typeof result.title).toBe("string");
    expect((result.title ?? "").length).toBeGreaterThan(0);
  }, 60_000);

  it("downloads + verifies a fresh yt-dlp via forceUpdateYtDlp into a tmp cache", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "binres-int-"));
    try {
      const r = new BinaryResolver({
        binariesDir: tmp,
        envOverridePath: null,
      });
      const { version, path: binPath } = await r.forceUpdateYtDlp();
      expect(version.length).toBeGreaterThan(0);
      expect(binPath.startsWith(tmp)).toBe(true);
      const stat = await fsp.stat(binPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
      const meta = JSON.parse(
        await fsp.readFile(path.join(tmp, "yt-dlp.meta.json"), "utf8"),
      );
      expect(meta.version).toBe(version);
      expect(meta.sha256.length).toBe(64);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
