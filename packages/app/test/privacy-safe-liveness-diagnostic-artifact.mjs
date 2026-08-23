/**
 * Persists the closed-schema liveness diagnostic used by the opt-in Cloud
 * Playwright lane. Artifact persistence is secondary evidence: its failure is
 * reported without retaining an exception or changing the primary verdict.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA =
  "elizaos.cloud.liveness-failure-diagnostics/v1";
export const LIVENESS_DIAGNOSTIC_WRITE_FAILURE_ANNOTATION = Object.freeze({
  type: "privacy-safe-liveness-diagnostic-artifact",
  description: "write-failed",
});

export async function writePrivacySafeLivenessDiagnostic({
  diagnosticPath,
  diagnosticRecord,
  annotations,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
}) {
  try {
    await mkdirFn(dirname(diagnosticPath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFileFn(
      diagnosticPath,
      `${JSON.stringify(
        {
          schema: LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA,
          ...diagnosticRecord,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return true;
  } catch {
    // error-policy:J4 diagnostic persistence is an ancillary evidence channel.
    // Report only a content-free unavailable state and preserve the primary
    // liveness failure as the authoritative Playwright verdict.
    try {
      annotations.push({ ...LIVENESS_DIAGNOSTIC_WRITE_FAILURE_ANNOTATION });
    } catch {
      // error-policy:J4 an unavailable annotation sink is another ancillary
      // reporting degrade and must not replace the primary liveness failure.
    }
    return false;
  }
}
