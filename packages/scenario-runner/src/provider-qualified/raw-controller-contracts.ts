/**
 * Supplies closed, reusable evidence bindings for executable provider
 * controllers. The helpers preserve exact probe inputs, bind replay requests,
 * verify trajectories from their isolated directory, and reject stale or
 * reordered raw receipts before they can reach an evidence signer.
 */

import { createHash } from "node:crypto";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import type {
  ProviderFailureProbeHashBinding,
  ProviderFailureProbeMaterial,
} from "./operator-authorization.ts";
import {
  type VerifiedScenarioTrajectorySet,
  verifyScenarioTrajectories,
} from "./trajectory-verifier.ts";

export interface ValidatedProviderFailureProbeExecution {
  material: Readonly<ProviderFailureProbeMaterial>;
  binding: Readonly<ProviderFailureProbeHashBinding>;
}

export interface ProviderReplayBinding {
  scenarioId: string;
  runId: string;
  runNonce: string;
  originalIngressRequestIdSha256: string;
  originalProviderEventIdSha256: string;
  originalEffectSha256: string;
  operationSha256: string;
}

export interface DeployedTrajectoryRunMaterial {
  runDir: string;
  runId: string;
  scenarioId: string;
  scenarioStartedAtIso: string;
  scenarioEndedAtIso: string;
  environment: string;
  expectedRelativePaths: readonly string[];
}

const MAX_RAW_RECEIPT_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

function parseDeployedTrajectoryRunMaterial(
  value: unknown,
): DeployedTrajectoryRunMaterial {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(
      "raw provider controller trajectory material must be a plain object",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "runDir",
    "runId",
    "scenarioId",
    "scenarioStartedAtIso",
    "scenarioEndedAtIso",
    "environment",
    "expectedRelativePaths",
  ] as const;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(
      "raw provider controller trajectory material violates the closed shape",
    );
  }
  for (const key of keys.slice(0, 6)) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(
        `raw provider controller trajectory material ${key} is invalid`,
      );
    }
  }
  if (
    !Array.isArray(record.expectedRelativePaths) ||
    record.expectedRelativePaths.length === 0 ||
    !record.expectedRelativePaths.every(
      (relativePath) =>
        typeof relativePath === "string" && relativePath.length > 0,
    )
  ) {
    throw new Error(
      "raw provider controller trajectory expectedRelativePaths is invalid",
    );
  }
  return Object.freeze({
    runDir: record.runDir as string,
    runId: record.runId as string,
    scenarioId: record.scenarioId as string,
    scenarioStartedAtIso: record.scenarioStartedAtIso as string,
    scenarioEndedAtIso: record.scenarioEndedAtIso as string,
    environment: record.environment as string,
    expectedRelativePaths: Object.freeze([...record.expectedRelativePaths]),
  });
}

function freezeJson(value: unknown, path: string): unknown {
  const canonical = canonicalJsonValue(value, path);
  if (Array.isArray(canonical)) {
    return Object.freeze(
      canonical.map((item, index) => freezeJson(item, `${path}[${index}]`)),
    );
  }
  if (canonical !== null && typeof canonical === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(canonical).map(([key, item]) => [
          key,
          freezeJson(item, `${path}.${key}`),
        ]),
      ),
    );
  }
  return canonical;
}

/** Retain immutable canonical probe material beside its validated hash tuple. */
export function bindValidatedFailureProbeExecutions(input: {
  materials: readonly ProviderFailureProbeMaterial[];
  bindings: readonly ProviderFailureProbeHashBinding[];
}): readonly ValidatedProviderFailureProbeExecution[] {
  if (input.materials.length !== input.bindings.length) {
    throw new Error(
      "raw provider controller failure probe cardinality changed",
    );
  }
  return Object.freeze(
    input.materials.map((material, index) => {
      const binding = input.bindings[index];
      if (material.probeId !== binding.probeId) {
        throw new Error("raw provider controller failure probe order changed");
      }
      return Object.freeze({
        material: Object.freeze({
          probeId: material.probeId,
          requestPayload: freezeJson(
            material.requestPayload,
            `failureProbe.${material.probeId}.requestPayload`,
          ),
          expectedErrorCode: freezeJson(
            material.expectedErrorCode,
            `failureProbe.${material.probeId}.expectedErrorCode`,
          ),
          scope: freezeJson(
            material.scope,
            `failureProbe.${material.probeId}.scope`,
          ),
          authorizationGrant: freezeJson(
            material.authorizationGrant,
            `failureProbe.${material.probeId}.authorizationGrant`,
          ),
        }),
        binding: Object.freeze({ ...binding }),
      });
    }),
  );
}

/** Build the exact replay tuple a protected capability must echo. */
export function buildProviderReplayBinding(input: {
  scenarioId: string;
  runId: string;
  runNonce: string;
  ingressRequestId: string;
  providerEventId: string;
  effectSha256: string;
  operation: unknown;
}): Readonly<ProviderReplayBinding> {
  return Object.freeze({
    scenarioId: input.scenarioId,
    runId: input.runId,
    runNonce: input.runNonce,
    originalIngressRequestIdSha256: createHash("sha256")
      .update(input.ingressRequestId)
      .digest("hex"),
    originalProviderEventIdSha256: createHash("sha256")
      .update(input.providerEventId)
      .digest("hex"),
    originalEffectSha256: input.effectSha256,
    operationSha256: canonicalSha256(input.operation, "providerOperation"),
  });
}

/** Verify the exact freshly isolated trajectory directory returned by a capability. */
export function verifyDeployedTrajectoryRun(input: {
  material: unknown;
  expectedRunId: string;
  expectedScenarioId: string;
  now: Date;
}): VerifiedScenarioTrajectorySet {
  const material = parseDeployedTrajectoryRunMaterial(input.material);
  if (
    material.runId !== input.expectedRunId ||
    material.scenarioId !== input.expectedScenarioId
  ) {
    throw new Error("raw provider controller trajectory correlation mismatch");
  }
  return verifyScenarioTrajectories({
    ...material,
    expectedRelativePaths: [...material.expectedRelativePaths],
    now: input.now,
  });
}

/** Reject non-monotonic, future-dated, or stale raw provider receipts. */
export function assertRawReceiptChronology(input: {
  timestamps: readonly [string, string, ...string[]];
  collectedAtMs: number;
}): void {
  if (!Number.isSafeInteger(input.collectedAtMs) || input.collectedAtMs < 0) {
    throw new Error("raw provider controller collection clock is invalid");
  }
  const parsed = input.timestamps.map((value) => Date.parse(value));
  if (parsed.some((value) => !Number.isFinite(value))) {
    throw new Error("raw provider controller receipt timestamp is invalid");
  }
  if (parsed.some((value, index) => index > 0 && value < parsed[index - 1])) {
    throw new Error("raw provider controller receipt chronology is inverted");
  }
  if (
    parsed[0] < input.collectedAtMs - MAX_RAW_RECEIPT_AGE_MS ||
    parsed[parsed.length - 1] > input.collectedAtMs + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error(
      "raw provider controller receipt interval is stale or future-dated",
    );
  }
}
