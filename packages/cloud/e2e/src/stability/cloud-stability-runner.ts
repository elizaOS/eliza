/**
 * Owns the manifest-driven Cloud stability lane contract and report artifacts.
 * The controller is dependency-injected so unit tests exercise plan, failure,
 * and artifact semantics without substituting for the production subprocess adapter.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createScenarioStabilityPlan,
  executeScenarioStability,
  type ScenarioStabilityExecutionAdapter,
  type ScenarioStabilityExecutionReport,
  type ScenarioStabilityExecutionTarget,
} from "@elizaos/scenario-runner";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";

export type CloudStabilityMode = "deterministic-mock" | "real-llm";

export interface CloudStabilityManifest {
  schemaVersion: 1;
  runId: string;
  mode: CloudStabilityMode;
  scenarioId: string;
  provider: string;
  model: string;
  scenarioFingerprint: string;
  worldFingerprint: string;
  fixtureManifestFingerprint?: string;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
}

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error(`${field} must be a bounded identifier`);
  }
  return value;
}

function stabilityRunId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error("runId must match the canonical stability plan pattern");
  }
  return value;
}

export function canonicalCloudStabilitySha256(value: unknown): string {
  return createHash("sha256")
    .update(
      canonicalJsonString(value, {
        maxDepth: 32,
        maxNodes: 100_000,
        maxOutputChars: 8 * 1024 * 1024,
        sparseArrayHoles: "null",
        onUnbounded: () => {
          throw new Error("Cloud stability manifest exceeds canonical limits");
        },
      }),
    )
    .digest("hex");
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

/** Validates the checked-in or workflow-supplied lane manifest. */
export function parseCloudStabilityManifest(
  value: unknown,
): CloudStabilityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud stability manifest must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Cloud stability manifest must be an ordinary object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !descriptors[key] ||
        !("value" in descriptors[key]),
    )
  ) {
    throw new Error("Cloud stability manifest requires own data properties");
  }
  const record = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  const expectedKeys = new Set([
    "schemaVersion",
    "runId",
    "mode",
    "scenarioId",
    "provider",
    "model",
    "scenarioFingerprint",
    "worldFingerprint",
    "timeoutMs",
    "maxInputTokens",
    "maxOutputTokens",
    "maxToolCalls",
    ...(record.mode === "deterministic-mock"
      ? ["fixtureManifestFingerprint"]
      : []),
  ]);
  if (
    Object.keys(record).length !== expectedKeys.size ||
    Object.keys(record).some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Cloud stability manifest contains noncanonical fields");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("Cloud stability manifest schemaVersion must be 1");
  }
  if (record.mode !== "deterministic-mock" && record.mode !== "real-llm") {
    throw new Error("Cloud stability manifest mode is invalid");
  }
  const parsed: CloudStabilityManifest = {
    schemaVersion: 1,
    runId: stabilityRunId(record.runId),
    mode: record.mode,
    scenarioId: boundedIdentifier(record.scenarioId, "scenarioId"),
    provider: boundedIdentifier(record.provider, "provider"),
    model: boundedIdentifier(record.model, "model"),
    scenarioFingerprint: boundedIdentifier(
      record.scenarioFingerprint,
      "scenarioFingerprint",
    ),
    worldFingerprint: boundedIdentifier(
      record.worldFingerprint,
      "worldFingerprint",
    ),
    timeoutMs: positiveInteger(record.timeoutMs, "timeoutMs"),
    maxInputTokens: positiveInteger(record.maxInputTokens, "maxInputTokens"),
    maxOutputTokens: positiveInteger(record.maxOutputTokens, "maxOutputTokens"),
    maxToolCalls: positiveInteger(record.maxToolCalls, "maxToolCalls"),
  };
  if (record.mode === "deterministic-mock") {
    if (
      typeof record.fixtureManifestFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.fixtureManifestFingerprint)
    ) {
      throw new Error(
        "deterministic mode requires a SHA-256 fixture fingerprint",
      );
    }
    parsed.fixtureManifestFingerprint = record.fixtureManifestFingerprint;
  }
  return parsed;
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const bytes = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) {
    throw new Error("Cloud stability report exceeds 64 MiB");
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export interface RunCloudStabilityLaneInput {
  manifest: CloudStabilityManifest;
  outputRoot: string;
  adapter: ScenarioStabilityExecutionAdapter;
}

/** Executes and persists the exact-three aggregate even when it blocks the lane. */
export async function runCloudStabilityLane(
  input: RunCloudStabilityLaneInput,
): Promise<ScenarioStabilityExecutionReport> {
  const manifest = parseCloudStabilityManifest(input.manifest);
  const target: ScenarioStabilityExecutionTarget = {
    scenarioId: manifest.scenarioId,
    model: { provider: manifest.provider, model: manifest.model },
  };
  const report = await executeScenarioStability({
    plan: createScenarioStabilityPlan({
      runId: manifest.runId,
      outputRoot: input.outputRoot,
    }),
    targets: [target],
    budgets: {
      timeoutMs: manifest.timeoutMs,
      maxInputTokens: manifest.maxInputTokens,
      maxOutputTokens: manifest.maxOutputTokens,
      maxToolCalls: manifest.maxToolCalls,
    },
    adapter: input.adapter,
  });
  await writeJsonAtomic(path.join(input.outputRoot, "stability.json"), report);
  const reportSha256 = canonicalCloudStabilitySha256(report);
  await writeTextAtomic(
    path.join(input.outputRoot, "stability.sha256"),
    `${reportSha256}  stability.json\n`,
  );
  await writeJsonAtomic(path.join(input.outputRoot, "manifest.json"), {
    ...manifest,
    manifestSha256: canonicalCloudStabilitySha256(manifest),
    reportSha256,
  });
  return report;
}
