/** Closed, privacy-safe progress evidence for the credentialed Cloud trajectory. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CLOUD_LIVE_TRAJECTORY_TIMEOUT_MS = 35 * 60 * 1_000;
export const CLOUD_LIVE_NAVIGATION_TIMEOUT_MS = 2 * 60 * 1_000;
export const CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA =
  "elizaos.cloud.trajectory-progress/v1";

export const CLOUD_LIVE_TRAJECTORY_PHASES = [
  "protected-cloud-boot",
  "pre-identity-runtime-choice",
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
  preIdentity?: CloudLivePreIdentityDiagnostic;
}

export interface CloudLivePreIdentityDiagnostic {
  runtimeCloudActionAttemptCount: number;
  runtimeCloudActionSuccessCount: number;
  runtimeCloudActionTimeoutCount: number;
  runtimeCloudRecoveryVisibleCount: number;
  personalIdentityRetryVisibleCount: number;
  personalIdentityGetRequestCount: number;
  successfulPersonalIdentityGetResponseCount: number;
  clientErrorPersonalIdentityGetResponseCount: number;
  serverErrorPersonalIdentityGetResponseCount: number;
  otherPersonalIdentityGetResponseCount: number;
  failedPersonalIdentityGetRequestCount: number;
  pendingPersonalIdentityGetRequestCount: number;
  completedPersonalIdentityResponseBodyCount: number;
  parsedPersonalIdentityResponseBodyCount: number;
  decodedSharedPersonalIdentityResponseCount: number;
  decodedDedicatedPersonalIdentityResponseCount: number;
  uninspectablePersonalIdentityResponseBodyCount: number;
  dedicatedQuoteGetRequestCount: number;
  successfulDedicatedQuoteGetResponseCount: number;
  clientErrorDedicatedQuoteGetResponseCount: number;
  serverErrorDedicatedQuoteGetResponseCount: number;
  otherDedicatedQuoteGetResponseCount: number;
  failedDedicatedQuoteGetRequestCount: number;
  pendingDedicatedQuoteGetRequestCount: number;
  completedDedicatedQuoteResponseBodyCount: number;
  parsedDedicatedQuoteResponseBodyCount: number;
  decodedDedicatedQuoteResponseCount: number;
  uninspectableDedicatedQuoteResponseBodyCount: number;
  dedicatedActivationPostRequestCount: number;
  successfulDedicatedActivationPostResponseCount: number;
  clientErrorDedicatedActivationPostResponseCount: number;
  serverErrorDedicatedActivationPostResponseCount: number;
  otherDedicatedActivationPostResponseCount: number;
  failedDedicatedActivationPostRequestCount: number;
  pendingDedicatedActivationPostRequestCount: number;
  completedDedicatedActivationResponseBodyCount: number;
  parsedDedicatedActivationResponseBodyCount: number;
  decodedDedicatedActivationReceiptCount: number;
  uninspectableDedicatedActivationResponseBodyCount: number;
  dedicatedCutoverPostRequestCount: number;
  successfulDedicatedCutoverPostResponseCount: number;
  clientErrorDedicatedCutoverPostResponseCount: number;
  serverErrorDedicatedCutoverPostResponseCount: number;
  otherDedicatedCutoverPostResponseCount: number;
  failedDedicatedCutoverPostRequestCount: number;
  pendingDedicatedCutoverPostRequestCount: number;
  completedDedicatedCutoverResponseBodyCount: number;
  parsedDedicatedCutoverResponseBodyCount: number;
  decodedDedicatedCutoverPendingResponseCount: number;
  decodedDedicatedCutoverFinalResponseCount: number;
  uninspectableDedicatedCutoverResponseBodyCount: number;
}

const CLOUD_LIVE_PRE_IDENTITY_DIAGNOSTIC_KEYS = [
  "runtimeCloudActionAttemptCount",
  "runtimeCloudActionSuccessCount",
  "runtimeCloudActionTimeoutCount",
  "runtimeCloudRecoveryVisibleCount",
  "personalIdentityRetryVisibleCount",
  "personalIdentityGetRequestCount",
  "successfulPersonalIdentityGetResponseCount",
  "clientErrorPersonalIdentityGetResponseCount",
  "serverErrorPersonalIdentityGetResponseCount",
  "otherPersonalIdentityGetResponseCount",
  "failedPersonalIdentityGetRequestCount",
  "pendingPersonalIdentityGetRequestCount",
  "completedPersonalIdentityResponseBodyCount",
  "parsedPersonalIdentityResponseBodyCount",
  "decodedSharedPersonalIdentityResponseCount",
  "decodedDedicatedPersonalIdentityResponseCount",
  "uninspectablePersonalIdentityResponseBodyCount",
  "dedicatedQuoteGetRequestCount",
  "successfulDedicatedQuoteGetResponseCount",
  "clientErrorDedicatedQuoteGetResponseCount",
  "serverErrorDedicatedQuoteGetResponseCount",
  "otherDedicatedQuoteGetResponseCount",
  "failedDedicatedQuoteGetRequestCount",
  "pendingDedicatedQuoteGetRequestCount",
  "completedDedicatedQuoteResponseBodyCount",
  "parsedDedicatedQuoteResponseBodyCount",
  "decodedDedicatedQuoteResponseCount",
  "uninspectableDedicatedQuoteResponseBodyCount",
  "dedicatedActivationPostRequestCount",
  "successfulDedicatedActivationPostResponseCount",
  "clientErrorDedicatedActivationPostResponseCount",
  "serverErrorDedicatedActivationPostResponseCount",
  "otherDedicatedActivationPostResponseCount",
  "failedDedicatedActivationPostRequestCount",
  "pendingDedicatedActivationPostRequestCount",
  "completedDedicatedActivationResponseBodyCount",
  "parsedDedicatedActivationResponseBodyCount",
  "decodedDedicatedActivationReceiptCount",
  "uninspectableDedicatedActivationResponseBodyCount",
  "dedicatedCutoverPostRequestCount",
  "successfulDedicatedCutoverPostResponseCount",
  "clientErrorDedicatedCutoverPostResponseCount",
  "serverErrorDedicatedCutoverPostResponseCount",
  "otherDedicatedCutoverPostResponseCount",
  "failedDedicatedCutoverPostRequestCount",
  "pendingDedicatedCutoverPostRequestCount",
  "completedDedicatedCutoverResponseBodyCount",
  "parsedDedicatedCutoverResponseBodyCount",
  "decodedDedicatedCutoverPendingResponseCount",
  "decodedDedicatedCutoverFinalResponseCount",
  "uninspectableDedicatedCutoverResponseBodyCount",
] as const satisfies readonly (keyof CloudLivePreIdentityDiagnostic)[];

interface WriteCloudLiveTrajectoryDiagnosticOptions {
  diagnosticPath: string;
  phase: CloudLiveTrajectoryPhase;
  elapsedMs: number;
  preIdentity?: CloudLivePreIdentityDiagnostic;
  mkdirFn?: typeof mkdir;
  writeFileFn?: typeof writeFile;
}

export function createCloudLiveTrajectoryDiagnostic(
  phase: CloudLiveTrajectoryPhase,
  elapsedMs: number,
  preIdentity?: CloudLivePreIdentityDiagnostic,
): CloudLiveTrajectoryDiagnostic {
  if (!CLOUD_LIVE_TRAJECTORY_PHASES.includes(phase)) {
    throw new Error("[cloud-live] unsupported trajectory phase");
  }
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error(
      "[cloud-live] trajectory elapsed time must be non-negative",
    );
  }
  const diagnostic: CloudLiveTrajectoryDiagnostic = {
    schema: CLOUD_LIVE_TRAJECTORY_DIAGNOSTIC_SCHEMA,
    phase,
    elapsedMs,
  };
  if (preIdentity) {
    const closedCounters = {} as CloudLivePreIdentityDiagnostic;
    for (const key of CLOUD_LIVE_PRE_IDENTITY_DIAGNOSTIC_KEYS) {
      const value = preIdentity[key];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          "[cloud-live] pre-identity counters must be non-negative integers",
        );
      }
      closedCounters[key] = value;
    }
    diagnostic.preIdentity = closedCounters;
  }
  return diagnostic;
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
  preIdentity,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
}: WriteCloudLiveTrajectoryDiagnosticOptions): Promise<void> {
  const diagnostic = createCloudLiveTrajectoryDiagnostic(
    phase,
    elapsedMs,
    preIdentity,
  );
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

/**
 * Retain the best-effort progress receipt without allowing an evidence-write
 * failure to replace the trajectory failure that the receipt is describing.
 */
export async function rethrowCloudLiveFailureAfterDiagnostic(
  cause: unknown,
  writeDiagnostic: () => Promise<void>,
): Promise<never> {
  try {
    await writeDiagnostic();
  } catch {
    console.warn("[cloud-live] trajectory diagnostic write unavailable");
    // error-policy:J7 the diagnostic is secondary evidence; an unavailable
    // evidence sink emits one fixed payload-free warning but must not mask the
    // original live identity failure.
  }
  throw cause;
}
