/**
 * Browser video artifact helpers for Playwright UI-smoke specs.
 *
 * Chromium records page video as WebM. PR evidence expects MP4 where the runner
 * has ffmpeg, so this helper transcodes the Playwright artifact without making
 * ordinary smoke tests depend on ffmpeg being installed. A transcode is labeled
 * video/mp4 only after ffprobe proves one H.264 yuv420p stream with a positive
 * duration (#29774); an unprovable transcode keeps the honest WebM recording,
 * and a provably invalid MP4 fails the test.
 */
import { spawn } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import type { TestInfo, Video } from "@playwright/test";
import {
  type BrowserVideoEvidenceProbe,
  resolveFfprobe,
  validateBrowserVideoMp4,
} from "../../../scripts/lib/browser-video-evidence.ts";

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
    });
  });
}

export async function saveBrowserVideoArtifact(args: {
  video: Video;
  testInfo: TestInfo;
  basename: string;
  expectedWidth?: number;
  expectedHeight?: number;
}): Promise<{
  path: string;
  contentType: string;
  probe?: BrowserVideoEvidenceProbe;
}> {
  const sourcePath = await args.video.path();
  const mp4Path = args.testInfo.outputPath(`${args.basename}.mp4`);
  const saveWebm = async () => {
    const webmPath = args.testInfo.outputPath(`${args.basename}.webm`);
    await copyFile(sourcePath, webmPath);
    return { path: webmPath, contentType: "video/webm" };
  };
  try {
    await runFfmpeg([
      "-y",
      "-i",
      sourcePath,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ]);
  } catch {
    // error-policy:J4 capture evidence remains usable when a local runner lacks ffmpeg.
    return saveWebm();
  }
  const ffprobe = resolveFfprobe();
  if (!ffprobe) {
    // An MP4 that cannot be probed is not labeled as MP4 evidence; keep the
    // original recording under its real media type instead.
    await rm(mp4Path, { force: true });
    return saveWebm();
  }
  // Throws BrowserVideoEvidenceError for a malformed or mislabeled transcode.
  const probe = validateBrowserVideoMp4(mp4Path, {
    ffprobe,
    expectedWidth: args.expectedWidth,
    expectedHeight: args.expectedHeight,
  });
  return { path: mp4Path, contentType: "video/mp4", probe };
}
