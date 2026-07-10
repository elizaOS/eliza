/**
 * Failure boundary for the unattended real-app view soak.
 *
 * Required evidence and onboarding checks reject so the process cannot publish
 * a healthy scorecard after losing its screenshot, recording, or browser state.
 * The caller owns best-effort cleanup after a rejection.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

export function convertSoakRecordingToMp4(
  source,
  target,
  { spawn = spawnSync } = {},
) {
  const result = spawn(
    "ffmpeg",
    [
      "-y",
      "-i",
      source,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      target,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to finalize the view-soak MP4: ${result.stderr || result.stdout}`,
    );
  }
}

export async function waitForOnboardingClearance(page, timeout = 45_000) {
  const backdrop = page.getByTestId("chat-first-run-backdrop");
  await backdrop.waitFor({ state: "detached", timeout });
  if (await backdrop.isVisible({ timeout: 500 })) {
    throw new Error(
      "first-run onboarding still blocks the rendered app surface",
    );
  }
}

export async function finalizeSoakEvidence({
  page,
  context,
  video,
  videoRequired = true,
  outDir,
  convertRecording = convertSoakRecordingToMp4,
  onContextClosed = () => {},
}) {
  await page.screenshot({ path: join(outDir, "soak-final.png") });
  await context.close();
  onContextClosed();
  if (!video) {
    if (videoRequired) {
      throw new Error("view-soak recording is required but was not initialized");
    }
    return null;
  }

  const source = await video.path();
  const artifact = "audit-views-soak.mp4";
  const target = join(outDir, artifact);
  rmSync(target, { force: true });
  convertRecording(source, target);
  rmSync(source, { force: true });
  return artifact;
}
