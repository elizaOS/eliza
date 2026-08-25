/** Closed, privacy-safe progress evidence for the credentialed Cloud trajectory. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS = 35 * 60 * 1_000;
export const CLOUD_LIVE_NAVIGATION_TIMEOUT_MS = 2 * 60 * 1_000;
export const CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA =
  "elizaos.cloud.trajectory-progress/v1";

export const CLOUD_LIVE_TRAJECTORY_PHASES = [
  "protected-cloud-boot",
  "personal-identity",
  "live-chat",
  "post-reload-navigation",
  "post-reload-history",
  "fresh-context-boot",
  "fresh-context-identity",
  "fresh-context-history",
  "evidence-write",
  "complete",
] as const;

export type CloudLiveTrajectoryPhase =
  (typeof CLOUD_LIVE_TRAJECTORY_PHASES)[number];

export interface CloudLiveTrajectoryDiagnostic {
  schema: typeof CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA;
  phase: CloudLiveTrajectoryPhase;
  elapsedMs: number;
}

interface WriteCloudLiveTrajectoryDiagnosticOptions {
  diagnosticPath: string;
  phase: CloudLiveTrajectoryPhase;
  elapsedMs: number;
  mkdirFn?: typeof mkdir;
  writeFileFn?: typeof writeFile;
}

export function createCloudLiveTrajectoryDiagnostic(
  phase: CloudLiveTrajectoryPhase,
  elapsedMs: number,
): CloudLiveTrajectoryDiagnostic {
  if (!CLOUD_LIVE_TRAJECTORY_PHASES.includes(phase)) {
    throw new Error("[cloud-live] unsupported trajectory phase");
  }
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error(
      "[cloud-live] trajectory elapsed time must be non-negative",
    );
  }
  return {
    schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
    phase,
    elapsedMs,
  };
}

/**
 * Replace the previous phase receipt before entering the next bounded step.
 * The file deliberately contains no URL, identity, request, transcript, or
 * provider data, so a timeout can retain it without exposing the live account.
 */
export async function writeCloudLiveTrajectoryDiagnostic({
  diagnosticPath,
  phase,
  elapsedMs,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
}: WriteCloudLiveTrajectoryDiagnosticOptions): Promise<void> {
  const diagnostic = createCloudLiveTrajectoryDiagnostic(phase, elapsedMs);
  await mkdirFn(dirname(diagnosticPath), { recursive: true, mode: 0o700 });
  await writeFileFn(
    diagnosticPath,
    `${JSON.stringify(diagnostic, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    },
  );
}
