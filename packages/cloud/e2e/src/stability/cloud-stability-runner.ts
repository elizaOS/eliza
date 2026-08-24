/**
 * Owns the manifest-driven Cloud stability lane contract and report artifacts.
 * The controller is dependency-injected so unit tests exercise plan, failure,
 * and artifact semantics without substituting for the production subprocess adapter.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
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

const CLOUD_STABILITY_MAX_CANONICAL_BYTES = 8 * 1024 * 1024;
const CLOUD_STABILITY_CHECKSUM_BYTES = 81;

const CLOUD_STABILITY_CANONICAL_OPTIONS = {
  maxDepth: 32,
  maxNodes: 100_000,
  maxOutputChars: CLOUD_STABILITY_MAX_CANONICAL_BYTES,
  sparseArrayHoles: "null" as const,
  onUnbounded: () => {
    throw new Error("Cloud stability artifact exceeds canonical limits");
  },
};

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

/** Returns the one bounded byte representation used for storage and hashing. */
export function canonicalCloudStabilityJson(value: unknown): string {
  const canonical = canonicalJsonString(
    value,
    CLOUD_STABILITY_CANONICAL_OPTIONS,
  );
  if (
    Buffer.byteLength(canonical, "utf8") > CLOUD_STABILITY_MAX_CANONICAL_BYTES
  ) {
    throw new Error("Cloud stability artifact exceeds canonical byte limit");
  }
  return canonical;
}

export function canonicalCloudStabilitySha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCloudStabilityJson(value), "utf8")
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
): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const bytes = canonicalCloudStabilityJson(value);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
  return bytes;
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

export interface CloudStabilityArtifactManifest extends CloudStabilityManifest {
  manifestSha256: string;
  reportSha256: string;
}

export interface VerifiedCloudStabilityArtifacts {
  report: unknown;
  manifest: CloudStabilityArtifactManifest;
  reportSha256: string;
}

async function readBoundedArtifact(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error(`${path.basename(filePath)} exceeds its artifact limit`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      bytes.byteLength > maximumBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${path.basename(filePath)} changed while being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonicalArtifact(bytes: Buffer, artifactName: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    // error-policy:J2 Invalid retained JSON is an integrity failure with cause.
    throw new Error(`${artifactName} is not valid JSON`, { cause });
  }
  const canonical = Buffer.from(canonicalCloudStabilityJson(parsed), "utf8");
  if (!bytes.equals(canonical)) {
    throw new Error(`${artifactName} is not canonical JSON`);
  }
  return parsed;
}

function parseArtifactManifest(value: unknown): CloudStabilityArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud stability artifact manifest must be an object");
  }
  const record = Object.fromEntries(Object.entries(value));
  const { manifestSha256, reportSha256, ...laneManifest } = record;
  if (
    typeof manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    typeof reportSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(reportSha256)
  ) {
    throw new Error("Cloud stability artifact manifest hashes are invalid");
  }
  const manifest = parseCloudStabilityManifest(laneManifest);
  if (manifestSha256 !== canonicalCloudStabilitySha256(manifest)) {
    throw new Error("Cloud stability manifest checksum does not match");
  }
  return { ...manifest, manifestSha256, reportSha256 };
}

/** Verifies retained report bytes, sidecar, and manifest before returning data. */
export async function verifyCloudStabilityArtifacts(
  outputRoot: string,
): Promise<VerifiedCloudStabilityArtifacts> {
  const [reportBytes, checksumBytes, manifestBytes] = await Promise.all([
    readBoundedArtifact(
      path.join(outputRoot, "stability.json"),
      CLOUD_STABILITY_MAX_CANONICAL_BYTES,
    ),
    readBoundedArtifact(
      path.join(outputRoot, "stability.sha256"),
      CLOUD_STABILITY_CHECKSUM_BYTES,
    ),
    readBoundedArtifact(
      path.join(outputRoot, "manifest.json"),
      CLOUD_STABILITY_MAX_CANONICAL_BYTES,
    ),
  ]);
  const report = parseCanonicalArtifact(reportBytes, "stability.json");
  const manifest = parseArtifactManifest(
    parseCanonicalArtifact(manifestBytes, "manifest.json"),
  );
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const expectedSidecar = `${reportSha256}  stability.json\n`;
  if (!checksumBytes.equals(Buffer.from(expectedSidecar, "utf8"))) {
    throw new Error("stability.sha256 does not match retained report bytes");
  }
  if (
    manifest.reportSha256 !== reportSha256 ||
    canonicalCloudStabilitySha256(report) !== reportSha256
  ) {
    throw new Error("Cloud stability report checksums do not match");
  }
  return { report, manifest, reportSha256 };
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
  const reportBytes = await writeJsonAtomic(
    path.join(input.outputRoot, "stability.json"),
    report,
  );
  const reportSha256 = createHash("sha256")
    .update(reportBytes, "utf8")
    .digest("hex");
  if (reportSha256 !== canonicalCloudStabilitySha256(report)) {
    throw new Error("Cloud stability report bytes are not canonical");
  }
  await writeTextAtomic(
    path.join(input.outputRoot, "stability.sha256"),
    `${reportSha256}  stability.json\n`,
  );
  await writeJsonAtomic(path.join(input.outputRoot, "manifest.json"), {
    ...manifest,
    manifestSha256: canonicalCloudStabilitySha256(manifest),
    reportSha256,
  });
  await verifyCloudStabilityArtifacts(input.outputRoot);
  return report;
}
