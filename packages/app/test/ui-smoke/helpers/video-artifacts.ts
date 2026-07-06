/**
 * Browser video artifact helpers for Playwright UI-smoke specs.
 *
 * Chromium records page video as WebM. PR evidence expects MP4 where the runner
 * has ffmpeg, so this helper transcodes the Playwright artifact without making
 * ordinary smoke tests depend on ffmpeg being installed.
 */
import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import type { TestInfo, Video } from "@playwright/test";

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
}): Promise<{ path: string; contentType: string }> {
  const sourcePath = await args.video.path();
  const mp4Path = args.testInfo.outputPath(`${args.basename}.mp4`);
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
    return { path: mp4Path, contentType: "video/mp4" };
  } catch {
    // error-policy:J4 capture evidence remains usable when a local runner lacks ffmpeg.
    const webmPath = args.testInfo.outputPath(`${args.basename}.webm`);
    await copyFile(sourcePath, webmPath);
    return { path: webmPath, contentType: "video/webm" };
  }
}
