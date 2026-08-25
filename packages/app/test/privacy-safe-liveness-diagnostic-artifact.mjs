/**
 * Persists the closed-schema liveness diagnostic used by the opt-in Cloud
 * Playwright lane. Artifact persistence is secondary evidence: its failure is
 * reported without retaining an exception or changing the primary verdict.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA =
  "elizaos.cloud.liveness-failure-diagnostics/v1";
export const LIVENESS_DIAGNOSTIC_ARTIFACT_FIELDS = Object.freeze([
  "originalErrorName",
  "chatSendAttemptDelta",
  "logicalChatSendDelta",
  "unidentifiedChatSendDelta",
  "namedWarmingResponseDelta",
  "successfulChatResponseDelta",
  "clientErrorChatResponseDelta",
  "serverErrorChatResponseDelta",
  "otherChatResponseDelta",
  "retryObservationAvailable",
  "retryChipEverObserved",
  "domSnapshotAvailable",
  "draftCleared",
  "newUserRowCount",
  "newAssistantRowCount",
  "failureRowPresent",
  "retryRowPresent",
  "interruptedRowPresent",
  "widgetOnlyReplyRowPresent",
  "threadLinesAvailable",
  "anchorUserPresent",
  "assistantRowPresent",
  "assistantFailurePresent",
  "assistantRetryPresent",
  "assistantInterrupted",
  "assistantHasMessageText",
  "assistantPhase",
  "assistantHasText",
]);
export const LIVENESS_DIAGNOSTIC_WRITE_FAILURE_ANNOTATION = Object.freeze({
  type: "privacy-safe-liveness-diagnostic-artifact",
  description: "write-failed",
});

/**
 * @param {{
 *   diagnosticPath: string,
 *   diagnosticRecord: Record<string, string | number | boolean | null>,
 *   annotations: { push(annotation: { type: string, description: string }): number },
 *   mkdirFn?: (path: string, options: { recursive: boolean, mode: number }) => Promise<string | undefined>,
 *   writeFileFn?: (path: string, data: string, options: { encoding: string, flag: string, mode: number }) => Promise<void>,
 * }} options
 * @returns {Promise<boolean>}
 */
export async function writePrivacySafeLivenessDiagnostic({
  diagnosticPath,
  diagnosticRecord,
  annotations,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
}) {
  try {
    const privacySafeRecord = {};
    for (const field of LIVENESS_DIAGNOSTIC_ARTIFACT_FIELDS) {
      const value = diagnosticRecord[field];
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        privacySafeRecord[field] = value;
      }
    }
    await mkdirFn(dirname(diagnosticPath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFileFn(
      diagnosticPath,
      `${JSON.stringify(
        {
          ...privacySafeRecord,
          schema: LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA,
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
