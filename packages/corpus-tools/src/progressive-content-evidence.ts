/** Validates content-context evidence bytes, identities, and cross-artifact semantics before bundling. */

import { createHash } from "node:crypto";
import {
  PROGRESSIVE_CONTENT_FAULT_CASES,
  PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION,
  PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS,
} from "../../core/src/testing/progressive-content-faults.ts";
import {
  PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS,
  PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_REJECTIONS,
  PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION,
} from "../../core/src/testing/progressive-content-mixed-soak.ts";
import {
  PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION,
  PROGRESSIVE_CONTENT_REQUIRED_MUTANTS,
} from "../../core/src/testing/progressive-content-mutants.ts";
import {
  PROGRESSIVE_CONTENT_ANCHOR_TIME,
  PROGRESSIVE_CONTENT_SCHEMA_VERSION,
  progressiveContentManifestDigest,
} from "./progressive-content.ts";
import { validateProgressiveContentPostgresEvidence } from "./progressive-content-postgres-evidence.ts";
import { PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION } from "./progressive-content-realization.ts";
import { parseStrictJson } from "./strict-json.ts";

export const CONTENT_CONTEXT_RESULT_SCHEMA_VERSION =
  "elizaos.content-context.result.v3" as const;
export const CONTENT_CONTEXT_E2E_SCHEMA_VERSION =
  "elizaos.content-context.e2e.v1" as const;
export const CONTENT_CONTEXT_LIVE_TRAJECTORY_SCHEMA_VERSION =
  "elizaos.content-context.live-trajectory.v1" as const;
export const CONTENT_CONTEXT_LIVE_OBSERVER_SCHEMA_VERSION =
  "elizaos.content-context.live-observer.v1" as const;
export const CONTENT_CONTEXT_REQUIRED_ARTIFACTS = [
  "corpus-manifest.json",
  "native-realization-ledger.json",
  "conformance.json",
  "mutant-kills.json",
  "source-work.json",
  "benchmark.json",
  "cleanup.json",
  "page-ledger.jsonl",
  "prompt-tokens.json",
  "faults.json",
  "stress.json",
  "soak.json",
  "postgres.json",
  "scenario.json",
  "scenario-native.jsonl",
  "trajectories.jsonl",
  "e2e.json",
] as const;

export const CONTENT_CONTEXT_FAMILIES = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
] as const;

export const CONTENT_CONTEXT_REQUIRED_FAULTS =
  PROGRESSIVE_CONTENT_FAULT_CASES.map(([id]) => id);

export const CONTENT_CONTEXT_PERFORMANCE_POLICY = {
  conformance: {
    maxPageLatencyMs: 5_000,
    maxRssGrowthBytes: 128 * 1024 * 1024,
    maxReadAmplification: 2,
    maxReadCallsPerPage: 2,
    maxRowsPerPage: 8,
  },
  benchmark: {
    maxPageLatencyMs: 5_000,
    maxRssGrowthBytes: 128 * 1024 * 1024,
    maxReadAmplification: 2,
    maxDatabaseGrowthRatio: 2,
  },
  soak: { sampleEveryOperations: 1_000 },
} as const;

export type ContentContextRequiredArtifact =
  (typeof CONTENT_CONTEXT_REQUIRED_ARTIFACTS)[number];

export interface ContentContextResult {
  readonly schemaVersion: typeof CONTENT_CONTEXT_RESULT_SCHEMA_VERSION;
  readonly commit: string;
  readonly corpusManifestSha256: string;
  readonly generatorRevision: string;
  readonly status: "passed" | "failed";
  readonly artifacts: readonly {
    readonly name: ContentContextRequiredArtifact;
    readonly sha256: string;
    readonly bytes: number;
  }[];
}

export type ContentContextArtifactBytes = Readonly<
  Record<ContentContextRequiredArtifact, Uint8Array>
>;

export type ContentContextReferencedArtifactBytes = Readonly<
  Record<string, Uint8Array>
>;

export interface ContentContextE2EArtifactDeclaration {
  readonly kind:
    | "backend-log"
    | "browser-trace"
    | "network-log"
    | "database-state";
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Build the producer result from the exact artifact bytes that will be ingested. */
export function buildContentContextResult(input: {
  readonly commit: string;
  readonly corpusManifestSha256: string;
  readonly generatorRevision: string;
  readonly artifactBytes: ContentContextArtifactBytes;
  readonly referencedArtifactBytes: ContentContextReferencedArtifactBytes;
}): ContentContextResult {
  const result: ContentContextResult = {
    schemaVersion: CONTENT_CONTEXT_RESULT_SCHEMA_VERSION,
    commit: input.commit,
    corpusManifestSha256: input.corpusManifestSha256,
    generatorRevision: input.generatorRevision,
    status: "passed",
    artifacts: CONTENT_CONTEXT_REQUIRED_ARTIFACTS.map((name) => {
      const bytes = input.artifactBytes[name];
      return {
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      };
    }),
  };
  return validateContentContextResult(
    result,
    input.artifactBytes,
    input.referencedArtifactBytes,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TypeError(`${label} fields are not exact`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash a strict JSON value using the canonical representation required by live evidence. */
export function contentContextCanonicalEvidenceSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function json(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    return record(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        label,
      ),
      label,
    );
  } catch (error) {
    throw new TypeError(`${label} is not valid strict UTF-8 JSON`, {
      cause: error,
    });
  }
}

function jsonLines(
  bytes: Uint8Array,
  label: string,
): Record<string, unknown>[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8`, { cause: error });
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new TypeError(`${label} must not be empty`);
  return lines.map((line, index) => {
    try {
      return record(
        parseStrictJson(line, `${label} line ${index + 1}`),
        `${label} line ${index + 1}`,
      );
    } catch (error) {
      throw new TypeError(`${label} line ${index + 1} is invalid strict JSON`, {
        cause: error,
      });
    }
  });
}

const CONTENT_CONTEXT_E2E_ARTIFACT_KINDS = [
  "backend-log",
  "browser-trace",
  "network-log",
  "database-state",
] as const;

function safeE2EArtifactPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    !value.startsWith("e2e-artifacts/") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

/** Decode the exact E2E byte inventory referenced by a content-context report. */
export function contentContextE2EArtifactDeclarations(
  bytes: Uint8Array,
): readonly ContentContextE2EArtifactDeclaration[] {
  const report = json(bytes, "E2E report");
  exactKeys(
    report,
    [
      "schemaVersion",
      "status",
      "commit",
      "corpusManifestSha256",
      "runId",
      "checks",
      "artifacts",
    ],
    "E2E report",
  );
  const checks = record(report.checks, "E2E checks");
  exactKeys(
    checks,
    ["api", "ui", "inspector", "backend", "browser", "network", "database"],
    "E2E checks",
  );
  const artifacts = array(report.artifacts, "E2E artifacts").map(
    (value, index) => {
      const artifact = record(value, `E2E artifact ${index}`);
      exactKeys(
        artifact,
        ["kind", "path", "sha256", "bytes"],
        `E2E artifact ${index}`,
      );
      if (
        !(CONTENT_CONTEXT_E2E_ARTIFACT_KINDS as readonly unknown[]).includes(
          artifact.kind,
        ) ||
        !safeE2EArtifactPath(artifact.path) ||
        typeof artifact.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
        typeof artifact.bytes !== "number" ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes <= 0
      ) {
        throw new TypeError(`E2E artifact ${index} is invalid`);
      }
      return artifact as unknown as ContentContextE2EArtifactDeclaration;
    },
  );
  const paths = artifacts.map(({ path }) => path);
  const kinds = artifacts.map(({ kind }) => kind);
  if (
    report.schemaVersion !== CONTENT_CONTEXT_E2E_SCHEMA_VERSION ||
    artifacts.length !== CONTENT_CONTEXT_E2E_ARTIFACT_KINDS.length ||
    new Set(paths).size !== paths.length ||
    new Set(kinds).size !== kinds.length ||
    CONTENT_CONTEXT_E2E_ARTIFACT_KINDS.some((kind) => !kinds.includes(kind))
  ) {
    throw new TypeError("E2E artifact inventory is not exact");
  }
  return artifacts;
}

function e2eReferencedByteFailures(
  declarations: readonly ContentContextE2EArtifactDeclaration[],
  referencedArtifactBytes: ContentContextReferencedArtifactBytes,
): string[] {
  const failures: string[] = [];
  const declared = new Set(declarations.map(({ path }) => path));
  const supplied = Object.keys(referencedArtifactBytes);
  if (
    supplied.length !== declared.size ||
    supplied.some((artifactPath) => !declared.has(artifactPath))
  ) {
    return ["E2E referenced artifact byte fields are not exact"];
  }
  for (const declaration of declarations) {
    const artifactBytes = referencedArtifactBytes[declaration.path];
    if (
      !artifactBytes ||
      artifactBytes.byteLength !== declaration.bytes ||
      createHash("sha256").update(artifactBytes).digest("hex") !==
        declaration.sha256
    ) {
      failures.push(
        `E2E referenced artifact bytes differ: ${declaration.path}`,
      );
    }
  }
  return failures;
}

const RESOURCE_MEMORY_FIELDS = [
  "rssBytes",
  "heapUsedBytes",
  "externalBytes",
  "arrayBuffersBytes",
] as const;
const RESOURCE_RETAINED_FIELDS = [
  "fileDescriptors",
  "temporaryArtifacts",
  "databaseRows",
] as const;

function resourceSample(value: unknown, label: string): Record<string, number> {
  const sample = record(value, label);
  for (const field of [
    ...RESOURCE_MEMORY_FIELDS,
    ...RESOURCE_RETAINED_FIELDS,
    "walBytes",
  ]) {
    const metric = sample[field];
    if (
      typeof metric !== "number" ||
      !Number.isSafeInteger(metric) ||
      metric < 0
    )
      throw new TypeError(`${label}.${field} must be a non-negative integer`);
  }
  return sample as Record<string, number>;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ??
    0
  );
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function seriesDetectsLeak(
  samples: readonly Record<string, number>[],
  minimumMemoryAllowanceBytes = 16 * 1024 * 1024,
): boolean {
  if (samples.length < 2) return true;
  const split = Math.max(1, Math.floor(samples.length / 2));
  const early = samples.slice(0, split);
  const late = samples.slice(split);
  if (
    RESOURCE_MEMORY_FIELDS.some((field) => {
      const baseline = p95(early.map((sample) => sample[field] ?? 0));
      const growth = p95(late.map((sample) => sample[field] ?? 0)) - baseline;
      return (
        growth >
        Math.max(minimumMemoryAllowanceBytes, Math.ceil(baseline * 0.05))
      );
    })
  )
    return true;
  return (
    RESOURCE_RETAINED_FIELDS.some(
      (field) =>
        (samples.at(-1)?.[field] ?? 0) - (samples[0]?.[field] ?? 0) > 0,
    ) || (samples.at(-1)?.walBytes ?? 0) - (samples[0]?.walBytes ?? 0) > 0
  );
}

function soakResourceFailures(soak: Record<string, unknown>): string[] {
  const failures: string[] = [];
  if (
    soak.sampleEveryOperations !==
      CONTENT_CONTEXT_PERFORMANCE_POLICY.soak.sampleEveryOperations ||
    typeof soak.warmupOperations !== "number" ||
    !Number.isSafeInteger(soak.warmupOperations) ||
    soak.warmupOperations < 0 ||
    typeof soak.operations !== "number"
  )
    return ["soak resource sampling contract is invalid"];
  const points = array(soak.resourceSamples, "soak resource samples").map(
    (value, index) => {
      const point = record(value, `soak resource sample ${index}`);
      if (
        typeof point.operation !== "number" ||
        !Number.isSafeInteger(point.operation) ||
        point.operation < 0 ||
        typeof point.elapsedMs !== "number" ||
        !Number.isFinite(point.elapsedMs) ||
        point.elapsedMs < 0
      )
        throw new TypeError("soak resource sample coordinate is invalid");
      return {
        operation: point.operation,
        elapsedMs: point.elapsedMs,
        sample: resourceSample(point.sample, `soak resource sample ${index}`),
      };
    },
  );
  const expectedWarmup = Math.min(
    10_000,
    Math.floor((soak.operations as number) / 10),
  );
  if (soak.warmupOperations !== expectedWarmup)
    failures.push("soak warmup differs from validator policy");
  if (
    points.length !==
      Math.ceil(
        (soak.operations as number) / (soak.sampleEveryOperations as number),
      ) +
        1 ||
    points[0]?.operation !== 0 ||
    (points.at(-1)?.operation ?? -1) !== soak.operations ||
    points.some(
      (point, index) =>
        index > 0 &&
        (point.operation <= (points[index - 1]?.operation ?? -1) ||
          point.operation - (points[index - 1]?.operation ?? 0) > 1_000 ||
          point.elapsedMs < (points[index - 1]?.elapsedMs ?? 0)),
    )
  )
    failures.push("soak resource samples are sparse, incomplete, or unordered");
  const postWarmup = points
    .filter(({ operation }) => operation >= expectedWarmup)
    .map(({ sample }) => sample);
  if (seriesDetectsLeak(postWarmup))
    failures.push(
      "soak resource series exceeds memory or retained-resource bounds",
    );
  const drift = record(soak.resourceDrift, "soak resource drift");
  if (
    drift.status !== "passed" ||
    !Array.isArray(drift.failures) ||
    drift.failures.length !== 0
  )
    failures.push("soak resource drift report did not pass cleanly");
  const positiveSamples = array(
    soak.positiveLeakControlSamples,
    "positive leak-control samples",
  ).map((value, index) =>
    resourceSample(value, `positive leak-control sample ${index}`),
  );
  const positiveDrift = record(
    soak.positiveLeakControlDrift,
    "positive leak-control drift",
  );
  if (
    positiveSamples.length < 2 ||
    !seriesDetectsLeak(positiveSamples) ||
    positiveDrift.status !== "failed" ||
    !Array.isArray(positiveDrift.failures) ||
    positiveDrift.failures.length === 0
  )
    failures.push(
      "positive leak control was not proved by the production detector",
    );
  if (
    !Array.isArray(soak.failures) ||
    soak.failures.length !== 0 ||
    typeof soak.batches !== "number" ||
    !Number.isSafeInteger(soak.batches) ||
    soak.batches <= 0
  )
    failures.push("soak retained batch failures or lacks a batch count");
  return failures;
}

function soakFamilyFailures(soak: Record<string, unknown>): string[] {
  const failures: string[] = [];
  const families = array(soak.families, "soak families").map((value, index) =>
    record(value, `soak family ${index}`),
  );
  const names = families.map(({ family }) => family);
  const adapterIds = families.map(({ adapterId }) => adapterId);
  const objectIds = families.map(({ objectId }) => objectId);
  if (
    families.length !== CONTENT_CONTEXT_FAMILIES.length ||
    new Set(names).size !== families.length ||
    CONTENT_CONTEXT_FAMILIES.some((family) => !names.includes(family)) ||
    new Set(adapterIds).size !== families.length ||
    new Set(objectIds).size !== families.length
  )
    failures.push("soak families do not provide exact unique coverage");
  let operations = 0;
  const operationCounts: number[] = [];
  const realizations: Record<string, readonly [string, string]> = {
    file: ["filesystem", "typed-rejection"],
    document: ["document-store", "typed-rejection"],
    memory: ["memory-store", "typed-rejection"],
    email: ["message-store", "typed-rejection"],
    attachment: ["content-addressed-media", "native-bytes"],
    "tool-output": ["filesystem", "native-bytes"],
  };
  for (const family of families) {
    const work = record(family.sourceWork, "soak family source work");
    const realization =
      typeof family.family === "string"
        ? realizations[family.family]
        : undefined;
    if (
      typeof family.adapterId !== "string" ||
      !family.adapterId ||
      /(?:fixture|mock|stub|test)/iu.test(family.adapterId) ||
      typeof family.objectId !== "string" ||
      !family.objectId ||
      !realization ||
      family.authoritativeStore !== realization[0] ||
      family.binaryPolicy !== realization[1] ||
      typeof family.productionMethod !== "string" ||
      !family.productionMethod ||
      /(?:fixture|mock|stub|test)/iu.test(family.productionMethod) ||
      typeof family.operations !== "number" ||
      !Number.isSafeInteger(family.operations) ||
      family.operations <= 0 ||
      !Array.isArray(family.failures) ||
      family.failures.length !== 0 ||
      family.cleanupVerified !== true ||
      typeof work.bytesRead !== "number" ||
      !Number.isSafeInteger(work.bytesRead) ||
      work.bytesRead < 0 ||
      typeof work.readCalls !== "number" ||
      !Number.isSafeInteger(work.readCalls) ||
      work.readCalls < 0 ||
      typeof work.rowsRead !== "number" ||
      !Number.isSafeInteger(work.rowsRead) ||
      work.rowsRead < 0 ||
      work.parentScans !== 0 ||
      work.bytesRead > family.operations * 128 * 1024 ||
      work.readCalls > family.operations * 2 ||
      work.rowsRead > family.operations * 8
    )
      failures.push(
        `soak family ${String(family.family)} did not pass bounded work`,
      );
    if (typeof family.operations === "number") {
      operations += family.operations;
      operationCounts.push(family.operations);
    }
  }
  if (operations !== soak.operations)
    failures.push("soak family operation totals do not match the run");
  if (
    operationCounts.length !== CONTENT_CONTEXT_FAMILIES.length ||
    Math.max(...operationCounts) - Math.min(...operationCounts) > 1
  )
    failures.push("soak operations were not distributed across every family");
  return failures;
}

function soakLifecycleFailures(soak: Record<string, unknown>): string[] {
  const failures: string[] = [];
  const lifecycle = record(soak.lifecycle, "soak lifecycle");
  exactKeys(
    lifecycle,
    ["schemaVersion", "status", "required", "completedCycles", "results"],
    "soak lifecycle",
  );
  const required = array(lifecycle.required, "soak lifecycle required IDs");
  const results = array(lifecycle.results, "soak lifecycle results").map(
    (value, index) => record(value, `soak lifecycle result ${index}`),
  );
  const completedCycles = lifecycle.completedCycles;
  if (
    lifecycle.schemaVersion !==
      PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION ||
    lifecycle.status !== "passed" ||
    required.length !== PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.length ||
    required.some(
      (id, index) => id !== PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS[index],
    ) ||
    typeof completedCycles !== "number" ||
    !Number.isSafeInteger(completedCycles) ||
    completedCycles <= 0 ||
    completedCycles !== soak.batches ||
    results.length !==
      completedCycles * PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.length
  ) {
    failures.push(
      "soak lifecycle identity, coverage, or cycle count is invalid",
    );
  }
  const expectedRejections = new Map(
    Object.entries(PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_REJECTIONS),
  );
  const seen = new Set<string>();
  for (const result of results) {
    exactKeys(
      result,
      [
        "id",
        "cycle",
        "semantics",
        "status",
        "targetFamily",
        "expectedCode",
        "observedCode",
        "beforeGeneration",
        "afterGeneration",
        "beforeSliceSha256",
        "afterSliceSha256",
        "observedEffects",
        "reason",
      ],
      "soak lifecycle result",
    );
    const identity = `${String(result.cycle)}:${String(result.id)}`;
    const effects = array(
      result.observedEffects,
      "soak lifecycle observed effects",
    );
    if (
      typeof result.cycle !== "number" ||
      !Number.isSafeInteger(result.cycle) ||
      result.cycle < 1 ||
      result.cycle > Number(completedCycles) ||
      !PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.includes(
        result.id as (typeof PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS)[number],
      ) ||
      seen.has(identity) ||
      result.status !== "passed" ||
      result.reason !== null ||
      effects.some(
        (effect) =>
          typeof effect !== "string" ||
          PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS.includes(
            effect as (typeof PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS)[number],
          ),
      )
    ) {
      failures.push("soak lifecycle contains a failed or invalid result");
    }
    seen.add(identity);
    if (result.id === "restart") {
      if (
        result.semantics !== "target-transition" ||
        !CONTENT_CONTEXT_FAMILIES.includes(
          result.targetFamily as (typeof CONTENT_CONTEXT_FAMILIES)[number],
        ) ||
        result.expectedCode !== null ||
        result.observedCode !== null ||
        typeof result.beforeGeneration !== "string" ||
        result.beforeGeneration.length === 0 ||
        typeof result.afterGeneration !== "string" ||
        result.afterGeneration.length === 0 ||
        result.beforeGeneration === result.afterGeneration ||
        typeof result.beforeSliceSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(result.beforeSliceSha256) ||
        result.afterSliceSha256 !== result.beforeSliceSha256
      ) {
        failures.push("soak restart lifecycle result is invalid");
      }
      continue;
    }
    const rejection =
      typeof result.id === "string"
        ? expectedRejections.get(result.id)
        : undefined;
    if (
      !rejection ||
      result.semantics !== rejection[0] ||
      result.expectedCode !== rejection[1] ||
      result.observedCode !== rejection[1] ||
      result.targetFamily !== null ||
      result.beforeGeneration !== null ||
      result.afterGeneration !== null ||
      result.beforeSliceSha256 !== null ||
      result.afterSliceSha256 !== null
    ) {
      failures.push("soak rejection lifecycle result is invalid");
    }
  }
  if (
    typeof completedCycles === "number" &&
    Number.isSafeInteger(completedCycles) &&
    completedCycles > 0
  ) {
    for (let cycle = 1; cycle <= completedCycles; cycle += 1) {
      for (const id of PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS) {
        if (!seen.has(`${cycle}:${id}`)) {
          failures.push("soak lifecycle lacks exact per-cycle coverage");
        }
      }
    }
  }
  return failures;
}

function passingScenarioNativeRow(entry: Record<string, unknown>): boolean {
  try {
    exactKeys(
      entry,
      [
        "agentId",
        "batchId",
        "boundary",
        "callId",
        "callIndex",
        "format",
        "metadata",
        "modelType",
        "privacyAttestation",
        "provider",
        "purpose",
        "request",
        "response",
        "scenarioId",
        "scenarioStatus",
        "schemaVersion",
        "stepId",
        "stepIndex",
        "stepType",
        "timestamp",
        "trajectoryId",
      ],
      "scenario native row",
    );
    const stepTypes = ["messageHandler", "planner", "evaluation"];
    if (!stepTypes.includes(String(entry.stepType))) return false;
    const attestation = record(
      entry.privacyAttestation,
      "scenario native privacy attestation",
    );
    exactKeys(
      attestation,
      [
        "schema",
        "version",
        "source",
        "redacted",
        "reviewed",
        "passed",
        "attestationPath",
      ],
      "scenario native privacy attestation",
    );
    const request = record(entry.request, "scenario native request");
    exactKeys(
      request,
      entry.stepType === "evaluation"
        ? ["messages", "providerOptions", "tools"]
        : ["messages", "providerOptions", "toolChoice", "tools"],
      "scenario native request",
    );
    const response = record(entry.response, "scenario native response");
    exactKeys(
      response,
      entry.stepType === "planner" ? ["text", "toolCalls"] : ["text"],
      "scenario native response",
    );
    const metadata = record(entry.metadata, "scenario native metadata");
    const metadataKeys = [
      "task_type",
      "source_dataset",
      "trajectory_id",
      "step_id",
      "call_id",
      "agent_id",
      "source_run_id",
      "source_room_id",
      "scenario_id",
      "source_stage_kind",
      ...(entry.stepType === "planner" || entry.stepType === "evaluation"
        ? ["source_stage_iteration"]
        : []),
      "source_model_type",
      ...(entry.stepType === "planner" ? [] : ["source_provider"]),
      "trajectory_status",
      "scenario_status",
      "privacy_attestation",
    ];
    exactKeys(metadata, metadataKeys, "scenario native metadata");
    return (
      entry.format === "eliza_native_v1" &&
      entry.schemaVersion === 1 &&
      entry.boundary === "vercel_ai_sdk.generateText" &&
      entry.scenarioStatus === "passed" &&
      entry.scenarioId === "deterministic-progressive-content-actions" &&
      typeof entry.agentId === "string" &&
      entry.agentId.length > 0 &&
      entry.batchId === null &&
      typeof entry.callId === "string" &&
      entry.callId.length > 0 &&
      typeof entry.callIndex === "number" &&
      Number.isSafeInteger(entry.callIndex) &&
      entry.callIndex >= 0 &&
      typeof entry.modelType === "string" &&
      entry.modelType.length > 0 &&
      (entry.provider === null || typeof entry.provider === "string") &&
      typeof entry.purpose === "string" &&
      entry.purpose.length > 0 &&
      typeof entry.stepId === "string" &&
      entry.stepId.length > 0 &&
      typeof entry.stepIndex === "number" &&
      Number.isSafeInteger(entry.stepIndex) &&
      entry.stepIndex >= 0 &&
      typeof entry.timestamp === "number" &&
      Number.isSafeInteger(entry.timestamp) &&
      entry.timestamp > 0 &&
      typeof entry.trajectoryId === "string" &&
      entry.trajectoryId.length > 0 &&
      array(request.messages, "scenario native messages").length > 0 &&
      Array.isArray(request.tools) &&
      typeof response.text === "string" &&
      attestation.schema === "eliza.privacy_filter_attestation.v1" &&
      attestation.version === 1 &&
      attestation.source === "scenario_native_export" &&
      attestation.redacted === true &&
      attestation.reviewed === true &&
      attestation.passed === true &&
      canonicalJson(metadata.privacy_attestation) === canonicalJson(attestation)
    );
  } catch {
    return false;
  }
}

function scenarioNativeToolCall(entry: Record<string, unknown>): boolean {
  if (!passingScenarioNativeRow(entry)) return false;
  const response = record(entry.response, "scenario native response");
  return Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
}

function scenarioNativeFinal(entry: Record<string, unknown>): boolean {
  if (!passingScenarioNativeRow(entry) || entry.stepType !== "evaluation") {
    return false;
  }
  const response = record(entry.response, "scenario native response");
  if (typeof response.text !== "string") return false;
  try {
    const output = record(
      parseStrictJson(response.text, "scenario native final"),
      "scenario native final",
    );
    return (
      output.success === true &&
      output.decision === "FINISH" &&
      typeof output.messageToUser === "string" &&
      output.messageToUser.length > 0
    );
  } catch {
    return false;
  }
}

function deterministicScenarioFailures(
  report: Record<string, unknown>,
): string[] {
  const failures: string[] = [];
  exactKeys(
    report,
    [
      "completedAtIso",
      "evidenceSummary",
      "executionProfile",
      "failedCount",
      "passedCount",
      "providerName",
      "runId",
      "scenarios",
      "skippedCount",
      "startedAtIso",
      "totalCostUsd",
      "totalCount",
      "totals",
    ],
    "deterministic scenario report",
  );
  const scenarios = array(report.scenarios, "deterministic scenarios").map(
    (value) => record(value, "deterministic scenario"),
  );
  const scenario = scenarios[0];
  if (
    report.executionProfile !== "simulated" ||
    report.providerName !== "deterministic-model-provider" ||
    report.totalCount !== 1 ||
    report.passedCount !== 1 ||
    report.failedCount !== 0 ||
    report.skippedCount !== 0 ||
    scenarios.length !== 1 ||
    !scenario
  ) {
    return ["deterministic scenario aggregate did not pass exactly once"];
  }
  exactKeys(
    scenario,
    [
      "actionsCalled",
      "domain",
      "durationMs",
      "evidence",
      "executionProfile",
      "failedAssertions",
      "finalChecks",
      "id",
      "modelFixtureDiagnostics",
      "modelFixtureMode",
      "providerName",
      "status",
      "tags",
      "title",
      "turns",
    ],
    "deterministic progressive-content scenario",
  );
  const actions = array(scenario.actionsCalled, "scenario actions").map(
    (value) => record(value, "scenario action"),
  );
  const actionNames = new Set(actions.map(({ actionName }) => actionName));
  const finalChecks = array(scenario.finalChecks, "scenario final checks").map(
    (value) => record(value, "scenario final check"),
  );
  const diagnostics = record(
    scenario.modelFixtureDiagnostics,
    "scenario fixture diagnostics",
  );
  const fixtureCalls = array(diagnostics.calls, "scenario fixture calls");
  const unexpectedCalls = array(
    diagnostics.unexpectedCalls,
    "scenario unexpected fixture calls",
  );
  const requiredActions = ["FILE", "DOCUMENT", "ATTACHMENT", "MESSAGE"];
  if (
    scenario.id !== "deterministic-progressive-content-actions" ||
    scenario.status !== "passed" ||
    scenario.executionProfile !== "simulated" ||
    scenario.providerName !== "deterministic-model-provider" ||
    scenario.modelFixtureMode !== "strict-fixtures" ||
    array(scenario.failedAssertions, "scenario failed assertions").length !==
      0 ||
    unexpectedCalls.length !== 0 ||
    fixtureCalls.length < 3 ||
    requiredActions.some((name) => !actionNames.has(name)) ||
    !finalChecks.some(
      ({ label, status }) =>
        label === "progressive action ledger is isolated and exact" &&
        status === "passed",
    )
  ) {
    failures.push(
      "deterministic production-action scenario lacks strict real-path proof",
    );
  }
  return failures;
}

const LIVE_TRAJECTORY_KEYS = [
  "schemaVersion",
  "repetition",
  "family",
  "status",
  "commit",
  "corpusManifestSha256",
  "providerQualified",
  "provider",
  "model",
  "continuationDiscovered",
  "lateEvidenceRecovered",
  "exactAnswer",
  "answerLeakageDetected",
  "canaryLeakageDetected",
  "toolCalls",
  "noProgressReads",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "controllerDecision",
  "observerEvidence",
  "observerEvidenceSha256",
  "trajectory",
  "trajectorySha256",
] as const;

function validLiveTrajectory(
  entry: Record<string, unknown>,
  result: ContentContextResult,
): boolean {
  try {
    exactKeys(entry, LIVE_TRAJECTORY_KEYS, "live trajectory");
    const trajectory = record(entry.trajectory, "live trajectory payload");
    exactKeys(
      trajectory,
      ["schemaVersion", "messages", "toolCalls", "modelCalls", "finalAnswer"],
      "live trajectory payload",
    );
    const messages = array(trajectory.messages, "live trajectory messages");
    const toolCalls = array(trajectory.toolCalls, "live trajectory tool calls");
    const modelCalls = array(
      trajectory.modelCalls,
      "live trajectory model calls",
    );
    const observer = record(entry.observerEvidence, "live observer evidence");
    exactKeys(
      observer,
      [
        "schemaVersion",
        "judgeProvider",
        "judgeModel",
        "judgeResponse",
        "expectedAnswerSha256",
        "observedAnswerSha256",
        "continuationDiscovered",
        "lateEvidenceRecovered",
        "exactAnswer",
        "answerLeakageDetected",
        "canaryLeakageDetected",
        "toolCalls",
        "noProgressReads",
      ],
      "live observer evidence",
    );
    record(observer.judgeResponse, "live observer judge response");
    const validIdentity =
      entry.schemaVersion === CONTENT_CONTEXT_LIVE_TRAJECTORY_SCHEMA_VERSION &&
      typeof entry.repetition === "number" &&
      Number.isSafeInteger(entry.repetition) &&
      entry.repetition >= 0 &&
      entry.repetition < 5 &&
      entry.status === "passed" &&
      entry.commit === result.commit &&
      entry.corpusManifestSha256 === result.corpusManifestSha256 &&
      entry.providerQualified === true &&
      typeof entry.provider === "string" &&
      entry.provider.length > 0 &&
      typeof entry.model === "string" &&
      entry.model.length > 0 &&
      !/fixture|mock|test|deterministic/iu.test(
        `${entry.provider} ${entry.model}`,
      );
    const validClaims =
      CONTENT_CONTEXT_FAMILIES.includes(
        entry.family as (typeof CONTENT_CONTEXT_FAMILIES)[number],
      ) &&
      entry.continuationDiscovered === true &&
      entry.lateEvidenceRecovered === true &&
      entry.exactAnswer === true &&
      entry.answerLeakageDetected === false &&
      entry.canaryLeakageDetected === false &&
      typeof entry.toolCalls === "number" &&
      Number.isSafeInteger(entry.toolCalls) &&
      entry.toolCalls >= 2 &&
      entry.noProgressReads === 0 &&
      typeof entry.latencyMs === "number" &&
      Number.isFinite(entry.latencyMs) &&
      entry.latencyMs > 0 &&
      typeof entry.inputTokens === "number" &&
      Number.isSafeInteger(entry.inputTokens) &&
      entry.inputTokens > 0 &&
      typeof entry.outputTokens === "number" &&
      Number.isSafeInteger(entry.outputTokens) &&
      entry.outputTokens > 0 &&
      typeof entry.costUsd === "number" &&
      Number.isFinite(entry.costUsd) &&
      entry.costUsd >= 0 &&
      entry.controllerDecision === "qualified";
    const validTrajectory =
      trajectory.schemaVersion ===
        "elizaos.content-context.normalized-trajectory.v1" &&
      messages.length > 0 &&
      toolCalls.length >= 2 &&
      modelCalls.length > 0 &&
      typeof trajectory.finalAnswer === "string" &&
      trajectory.finalAnswer.length > 0 &&
      entry.trajectorySha256 ===
        contentContextCanonicalEvidenceSha256(trajectory);
    const validObserver =
      observer.schemaVersion === CONTENT_CONTEXT_LIVE_OBSERVER_SCHEMA_VERSION &&
      typeof observer.judgeProvider === "string" &&
      observer.judgeProvider.length > 0 &&
      typeof observer.judgeModel === "string" &&
      observer.judgeModel.length > 0 &&
      !/fixture|mock|test|deterministic/iu.test(
        `${observer.judgeProvider} ${observer.judgeModel}`,
      ) &&
      typeof observer.expectedAnswerSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(observer.expectedAnswerSha256) &&
      observer.observedAnswerSha256 === observer.expectedAnswerSha256 &&
      observer.continuationDiscovered === entry.continuationDiscovered &&
      observer.lateEvidenceRecovered === entry.lateEvidenceRecovered &&
      observer.exactAnswer === entry.exactAnswer &&
      observer.answerLeakageDetected === entry.answerLeakageDetected &&
      observer.canaryLeakageDetected === entry.canaryLeakageDetected &&
      observer.toolCalls === entry.toolCalls &&
      observer.noProgressReads === entry.noProgressReads &&
      entry.observerEvidenceSha256 ===
        contentContextCanonicalEvidenceSha256(observer);
    return validIdentity && validClaims && validTrajectory && validObserver;
  } catch {
    return false;
  }
}

function semanticFailures(
  result: ContentContextResult,
  bytes: ContentContextArtifactBytes,
  referencedArtifactBytes: ContentContextReferencedArtifactBytes,
): string[] {
  const failures: string[] = [];
  const manifest = json(bytes["corpus-manifest.json"], "corpus manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "generatorRevision",
      "rootSeed",
      "anchorTime",
      "profile",
      "publication",
      "objects",
      "formatFixtures",
      "logicalBytes",
      "manifestSha256",
    ],
    "corpus manifest",
  );
  const objects = array(manifest.objects, "corpus objects").map(
    (value, index) => {
      const object = record(value, `corpus object ${index}`);
      exactKeys(
        object,
        [
          "id",
          "family",
          "format",
          "relativePath",
          "byteLength",
          "sourceSha256",
          "revision",
          "authorizationScope",
          "coordinateSystem",
          "canaries",
        ],
        `corpus object ${index}`,
      );
      return object;
    },
  );
  const formatFixtures = array(
    manifest.formatFixtures,
    "corpus format fixtures",
  );
  if (
    manifest.schemaVersion !== PROGRESSIVE_CONTENT_SCHEMA_VERSION ||
    manifest.generatorRevision !== result.generatorRevision ||
    result.generatorRevision !== result.commit ||
    manifest.anchorTime !== PROGRESSIVE_CONTENT_ANCHOR_TIME ||
    manifest.profile !== "scale" ||
    manifest.publication !== "private-atomic-manifest-last-v1" ||
    typeof manifest.rootSeed !== "string" ||
    manifest.rootSeed.length === 0 ||
    typeof manifest.logicalBytes !== "number" ||
    !Number.isSafeInteger(manifest.logicalBytes) ||
    manifest.logicalBytes < 0 ||
    !Array.isArray(formatFixtures) ||
    progressiveContentManifestDigest(manifest) !== manifest.manifestSha256
  ) {
    failures.push("corpus manifest identity or policy is invalid");
  }
  for (const family of [
    "file",
    "document",
    "memory",
    "email",
    "attachment",
    "tool-output",
  ]) {
    const sizes = new Set(
      objects
        .filter((object) => object.family === family)
        .map(({ byteLength }) => byteLength),
    );
    for (const requiredBytes of [
      1024 * 1024,
      10 * 1024 * 1024,
      100 * 1024 * 1024,
    ]) {
      if (!sizes.has(requiredBytes))
        failures.push(`corpus ${family} missing ${requiredBytes} byte scale`);
    }
  }
  if (manifest.manifestSha256 !== result.corpusManifestSha256) {
    failures.push("manifest identity differs from result");
  }
  const ledger = json(
    bytes["native-realization-ledger.json"],
    "realization ledger",
  );
  exactKeys(
    ledger,
    [
      "schemaVersion",
      "corpusSchemaVersion",
      "corpusManifestSha256",
      "generatorRevision",
      "entries",
      "counts",
    ],
    "realization ledger",
  );
  if (ledger.corpusManifestSha256 !== result.corpusManifestSha256) {
    failures.push("realization ledger targets another manifest");
  }
  const realizationEntries = array(ledger.entries, "realization entries").map(
    (value) => record(value, "realization entry"),
  );
  const realizationCounts = record(ledger.counts, "realization counts");
  exactKeys(
    realizationCounts,
    ["verified", "typedRejected", "unsupported", "pending", "failed"],
    "realization counts",
  );
  const computedRealizationCounts = {
    verified: realizationEntries.filter(({ status }) => status === "verified")
      .length,
    typedRejected: realizationEntries.filter(
      ({ status }) => status === "typed-rejected",
    ).length,
    unsupported: realizationEntries.filter(
      ({ status }) => status === "unsupported",
    ).length,
    pending: realizationEntries.filter(({ status }) => status === "pending")
      .length,
    failed: realizationEntries.filter(({ status }) => status === "failed")
      .length,
  };
  if (
    ledger.schemaVersion !== PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION ||
    ledger.corpusSchemaVersion !== PROGRESSIVE_CONTENT_SCHEMA_VERSION ||
    ledger.generatorRevision !== result.generatorRevision ||
    Object.entries(computedRealizationCounts).some(
      ([status, count]) => realizationCounts[status] !== count,
    )
  ) {
    failures.push("realization ledger schema, revision, or counts are invalid");
  }
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  if (objectsById.size !== objects.length)
    failures.push("corpus object identities are duplicated");
  const realizedObjectIds = new Set<unknown>();
  const verifiedObjectIds = new Set<unknown>();
  const typedRejectedObjectIds = new Set<unknown>();
  for (const entry of realizationEntries) {
    const object = objectsById.get(entry.objectId);
    if (!object || realizedObjectIds.has(entry.objectId)) {
      failures.push("native realization identity is missing or duplicated");
    } else {
      realizedObjectIds.add(entry.objectId);
      if (
        entry.family !== object.family ||
        entry.sourceSha256 !== object.sourceSha256 ||
        entry.sourceBytes !== object.byteLength
      )
        failures.push("native realization differs from corpus object");
    }
    const work = record(entry.sourceWork, "realization source work");
    exactKeys(
      work,
      ["readCalls", "bytesRead", "maxReadBytes"],
      "realization source work",
    );
    const boundedWork =
      typeof work.readCalls === "number" &&
      Number.isSafeInteger(work.readCalls) &&
      work.readCalls >= 0 &&
      typeof work.bytesRead === "number" &&
      Number.isSafeInteger(work.bytesRead) &&
      work.bytesRead >= 0 &&
      typeof work.maxReadBytes === "number" &&
      Number.isSafeInteger(work.maxReadBytes) &&
      work.maxReadBytes >= 0 &&
      work.maxReadBytes <= 64 * 1024;
    const expectedRejection =
      object &&
      ["file", "document", "memory", "email"].includes(String(object.family)) &&
      object.format === "binary"
        ? "CONTENT_BINARY_UNSUPPORTED"
        : object &&
            ["file", "document", "memory", "email"].includes(
              String(object.family),
            ) &&
            object.format === "invalid-utf8"
          ? "CONTENT_INVALID_UTF8"
          : undefined;
    if (entry.status === "verified") {
      exactKeys(
        entry,
        [
          "objectId",
          "family",
          "adapterId",
          "status",
          "sourceSha256",
          "sourceBytes",
          "sourceWork",
          "reference",
          "revision",
          "authorizationScope",
          "cleanupIdentity",
          "resolverBindingSha256",
        ],
        "verified realization entry",
      );
      const reference = record(entry.reference, "realization reference");
      exactKeys(reference, ["kind", "ref"], "realization reference");
      if (
        expectedRejection !== undefined ||
        entry.revision !== object?.revision ||
        entry.authorizationScope !== object?.authorizationScope ||
        typeof entry.adapterId !== "string" ||
        entry.adapterId.length === 0 ||
        typeof reference.ref !== "string" ||
        reference.ref.length === 0 ||
        reference.kind !==
          (object?.family === "tool-output" ? "tool-result" : object?.family) ||
        typeof entry.cleanupIdentity !== "string" ||
        entry.cleanupIdentity.length === 0 ||
        typeof entry.resolverBindingSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.resolverBindingSha256) ||
        !boundedWork ||
        work.bytesRead !== entry.sourceBytes
      ) {
        failures.push(
          "native verified realization is invalid, unbounded, or incomplete",
        );
      }
      verifiedObjectIds.add(entry.objectId);
    } else if (entry.status === "typed-rejected") {
      exactKeys(
        entry,
        [
          "objectId",
          "family",
          "adapterId",
          "status",
          "sourceSha256",
          "sourceBytes",
          "sourceWork",
          "rejectionCode",
        ],
        "typed-rejected realization entry",
      );
      if (
        expectedRejection === undefined ||
        entry.rejectionCode !== expectedRejection ||
        typeof entry.adapterId !== "string" ||
        entry.adapterId.length === 0 ||
        !boundedWork ||
        typeof work.bytesRead !== "number" ||
        work.bytesRead > 64 * 1024
      ) {
        failures.push("native typed rejection is invalid or unbounded");
      }
      typedRejectedObjectIds.add(entry.objectId);
    } else {
      failures.push(
        "native realization is neither verified nor typed-rejected",
      );
    }
  }
  if (realizedObjectIds.size !== objects.length)
    failures.push("native realization does not cover every corpus object");

  const conformance = json(bytes["conformance.json"], "conformance");
  const conformanceReports = array(
    conformance.reports,
    "conformance reports",
  ).map((value) => record(value, "conformance report"));
  const conformanceObjectIds = new Set(
    conformanceReports.map(({ objectId }) => objectId),
  );
  if (
    conformanceReports.length !== verifiedObjectIds.size ||
    conformanceObjectIds.size !== conformanceReports.length ||
    [...verifiedObjectIds].some((id) => !conformanceObjectIds.has(id)) ||
    [...typedRejectedObjectIds].some((id) => conformanceObjectIds.has(id))
  )
    failures.push(
      "conformance does not cover every verified native object exactly once",
    );
  for (const report of conformanceReports) {
    const object = objectsById.get(report.objectId);
    if (
      report.status !== "passed" ||
      !object ||
      report.reassembledSha256 !== object.sourceSha256 ||
      typeof report.pages !== "number" ||
      !Number.isSafeInteger(report.pages) ||
      report.pages < (object.byteLength === 0 ? 0 : 1) ||
      report.restartVerified !== true ||
      report.concurrencyVerified !== true ||
      report.repeatedPageVerified !== true ||
      report.cleanupVerified !== true ||
      report.postCleanupProbeVerified !== true
    )
      failures.push("conformance report lacks a required proof");
    const performance = record(report.performance, "conformance performance");
    const ceilings = record(performance.ceilings, "conformance ceilings");
    for (const [actualField, ceilingField, maximum] of [
      [
        "maxPageLatencyMs",
        "maxPageLatencyMs",
        CONTENT_CONTEXT_PERFORMANCE_POLICY.conformance.maxPageLatencyMs,
      ],
      [
        "rssGrowthBytes",
        "maxRssGrowthBytes",
        CONTENT_CONTEXT_PERFORMANCE_POLICY.conformance.maxRssGrowthBytes,
      ],
      [
        "readAmplification",
        "maxReadAmplification",
        CONTENT_CONTEXT_PERFORMANCE_POLICY.conformance.maxReadAmplification,
      ],
      [
        "readCallsPerPageMax",
        "maxReadCallsPerPage",
        CONTENT_CONTEXT_PERFORMANCE_POLICY.conformance.maxReadCallsPerPage,
      ],
      [
        "rowsPerPageMax",
        "maxRowsPerPage",
        CONTENT_CONTEXT_PERFORMANCE_POLICY.conformance.maxRowsPerPage,
      ],
    ] as const) {
      const actual = performance[actualField];
      if (
        !finiteNonNegative(actual) ||
        actual > maximum ||
        ceilings[ceilingField] !== maximum
      )
        failures.push("conformance performance exceeded a ceiling");
    }
  }

  const mutants = json(bytes["mutant-kills.json"], "mutant report");
  const mutantResults = array(mutants.results, "mutant results").map((value) =>
    record(value, "mutant result"),
  );
  const requiredMutants = new Map<
    string,
    {
      readonly seam: string;
      readonly killingVector: string;
      readonly executor: string;
      readonly killingTestId: string;
    }
  >(
    PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.map(
      ({ id, seam, killingVector, executor, killingTestId }) => [
        id,
        { seam, killingVector, executor, killingTestId },
      ],
    ),
  );
  const observedMutantIds = new Set(mutantResults.map(({ id }) => id));
  if (
    mutants.schemaVersion !==
      PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION ||
    mutants.status !== "passed" ||
    mutants.required !== requiredMutants.size ||
    mutants.executed !== requiredMutants.size ||
    mutants.killed !== requiredMutants.size ||
    mutants.killRate !== 1 ||
    mutantResults.length !== requiredMutants.size ||
    observedMutantIds.size !== mutantResults.length ||
    [...requiredMutants.keys()].some((id) => !observedMutantIds.has(id)) ||
    mutantResults.some(
      ({
        id,
        seam,
        killingVector,
        executor,
        killingTestId,
        status,
        failureVectors,
      }) => {
        const expected =
          typeof id === "string" ? requiredMutants.get(id) : undefined;
        return (
          !expected ||
          seam !== expected.seam ||
          killingVector !== expected.killingVector ||
          executor !== expected.executor ||
          killingTestId !== expected.killingTestId ||
          status !== "killed" ||
          !Array.isArray(failureVectors) ||
          !failureVectors.includes(expected.killingVector)
        );
      },
    )
  )
    failures.push("mutant report does not prove executable kills");

  const sourceWork = json(bytes["source-work.json"], "source work");
  const sourceSamples = array(sourceWork.samples, "source samples").map(
    (value) => record(value, "source sample"),
  );
  const sourceObjectIds = new Set(
    sourceSamples.map(({ objectId }) => objectId),
  );
  if (
    sourceSamples.length !== objects.length ||
    sourceObjectIds.size !== sourceSamples.length ||
    objects.some(({ id }) => !sourceObjectIds.has(id))
  )
    failures.push("source-work does not cover every object exactly once");
  for (const sample of sourceSamples) {
    if (
      typeof sample.rowsRead !== "number" ||
      sample.rowsRead > 8 ||
      sample.parentScans !== 0 ||
      typeof sample.bytesRead !== "number" ||
      typeof sample.bytesReturned !== "number" ||
      sample.bytesRead > sample.bytesReturned * 2 + 64 * 1024
    )
      failures.push("source-work sample is unbounded");
  }

  const benchmark = json(bytes["benchmark.json"], "benchmark");
  const benchmarkCases = array(benchmark.cases, "benchmark cases").map(
    (value) => record(value, "benchmark case"),
  );
  for (const minimum of [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024]) {
    if (!benchmarkCases.some(({ sourceBytes }) => sourceBytes === minimum))
      failures.push(`benchmark lacks ${minimum} byte scale`);
  }
  for (const entry of benchmarkCases) {
    const observed = record(entry.observed, "benchmark observed");
    const ceilings = record(entry.ceilings, "benchmark ceilings");
    const sourceBytes = entry.sourceBytes;
    if (
      typeof sourceBytes !== "number" ||
      !Number.isSafeInteger(sourceBytes) ||
      sourceBytes <= 0
    ) {
      failures.push("benchmark source size is invalid");
      continue;
    }
    const policy = {
      maxPageLatencyMs:
        CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxPageLatencyMs,
      rssGrowthBytes:
        CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxRssGrowthBytes,
      databaseGrowthBytes:
        sourceBytes *
        CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxDatabaseGrowthRatio,
      readAmplification:
        CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxReadAmplification,
    };
    for (const [metric, maximum] of Object.entries(policy)) {
      if (
        !finiteNonNegative(observed[metric]) ||
        observed[metric] > maximum ||
        ceilings[metric] !== maximum
      )
        failures.push(`benchmark ${metric} exceeded ceiling`);
    }
  }

  const cleanup = json(bytes["cleanup.json"], "cleanup");
  const cleanupProbes = array(cleanup.probes, "cleanup probes").map((value) =>
    record(value, "cleanup probe"),
  );
  const cleanupObjectIds = new Set(
    cleanupProbes.map(({ objectId }) => objectId),
  );
  if (
    cleanup.status !== "passed" ||
    cleanup.restartVerified !== true ||
    cleanup.authorizationVerified !== true ||
    cleanupProbes.length !== objects.length ||
    cleanupObjectIds.size !== cleanupProbes.length ||
    objects.some(({ id }) => !cleanupObjectIds.has(id)) ||
    cleanupProbes.some(({ absent }) => absent !== true)
  )
    failures.push(
      "cleanup evidence lacks absence, restart, or authorization proof",
    );

  const pageLedger = jsonLines(bytes["page-ledger.jsonl"], "page ledger");
  const pageRowsByObject = new Map<string, Record<string, unknown>[]>();
  for (const row of pageLedger) {
    if (typeof row.objectId !== "string") continue;
    const rows = pageRowsByObject.get(row.objectId) ?? [];
    rows.push(row);
    pageRowsByObject.set(row.objectId, rows);
  }
  if (
    pageRowsByObject.size !== verifiedObjectIds.size ||
    [...pageRowsByObject.keys()].some(
      (id) => !objectsById.has(id) || !verifiedObjectIds.has(id),
    ) ||
    [...verifiedObjectIds].some((id) => !pageRowsByObject.has(String(id))) ||
    [...typedRejectedObjectIds].some((id) =>
      pageRowsByObject.has(String(id)),
    ) ||
    pageLedger.some((entry) => {
      const range = record(entry.range, "page ledger range");
      return (
        typeof entry.objectId !== "string" ||
        typeof entry.revision !== "string" ||
        typeof entry.sliceSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sliceSha256) ||
        typeof range.start !== "number" ||
        !Number.isSafeInteger(range.start) ||
        typeof range.end !== "number" ||
        !Number.isSafeInteger(range.end) ||
        range.end <= range.start ||
        (range.unit !== undefined && range.unit !== "byte") ||
        typeof entry.bytesRead !== "number" ||
        !Number.isSafeInteger(entry.bytesRead) ||
        entry.bytesRead !== range.end - range.start ||
        entry.bytesRead > 64 * 1024
      );
    })
  )
    failures.push("page ledger lacks exact bounded native reads");
  for (const object of objects.filter(({ id }) => verifiedObjectIds.has(id))) {
    if (typeof object.id !== "string") {
      failures.push("page ledger encountered an invalid corpus identity");
      continue;
    }
    const rows = pageRowsByObject.get(object.id) ?? [];
    let expectedStart = 0;
    let terminalRows = 0;
    for (const row of rows) {
      const range = record(row.range, "page ledger range");
      if (
        row.revision !== object.revision ||
        range.start !== expectedStart ||
        typeof range.end !== "number" ||
        range.end < expectedStart
      ) {
        expectedStart = -1;
        break;
      }
      expectedStart = range.end;
      if (row.reassembledSha256 !== undefined) {
        terminalRows += 1;
        if (
          range.end !== object.byteLength ||
          row.reassembledSha256 !== object.sourceSha256
        ) {
          expectedStart = -1;
          break;
        }
      }
    }
    if (
      expectedStart !== object.byteLength ||
      rows.length === 0 ||
      terminalRows !== 1 ||
      (rows.length === 1 && rows[0]?.sliceSha256 !== object.sourceSha256)
    )
      failures.push(`page ledger is not a full traversal for ${object.id}`);
  }

  const promptTokens = json(bytes["prompt-tokens.json"], "prompt tokens");
  const promptTokenCases = array(promptTokens.cases, "prompt token cases");
  if (
    promptTokenCases.length === 0 ||
    promptTokenCases.some((value) => {
      const entry = record(value, "prompt token case");
      return (
        entry.finalSerialized !== true ||
        entry.withinBudget !== true ||
        typeof entry.inputTokens !== "number" ||
        typeof entry.outputReserveTokens !== "number" ||
        typeof entry.contextWindowTokens !== "number" ||
        entry.inputTokens + entry.outputReserveTokens >
          entry.contextWindowTokens
      );
    })
  )
    failures.push("final prompt-token evidence is incomplete or over budget");

  const faults = json(bytes["faults.json"], "fault report");
  const faultCatalog = array(faults.catalog, "fault catalog");
  const faultResults = array(faults.results, "fault results").map((value) =>
    record(value, "fault result"),
  );
  const requiredFaults = new Map<
    string,
    { readonly stage: string; readonly expectedCode: string }
  >(
    PROGRESSIVE_CONTENT_FAULT_CASES.map(([id, stage, expectedCode]) => [
      id,
      { stage, expectedCode },
    ]),
  );
  if (
    faults.schemaVersion !== PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION ||
    faults.status !== "passed" ||
    faults.required !== requiredFaults.size ||
    faults.executed !== requiredFaults.size ||
    faultCatalog.length !== CONTENT_CONTEXT_REQUIRED_FAULTS.length ||
    new Set(faultCatalog).size !== faultCatalog.length ||
    CONTENT_CONTEXT_REQUIRED_FAULTS.some((id) => !faultCatalog.includes(id)) ||
    faultResults.length !== CONTENT_CONTEXT_REQUIRED_FAULTS.length ||
    new Set(faultResults.map(({ id }) => id)).size !== faultResults.length ||
    CONTENT_CONTEXT_REQUIRED_FAULTS.some(
      (id) => !faultResults.some((result) => result.id === id),
    ) ||
    faultResults.some(
      ({
        id,
        stage,
        expectedCode,
        forbiddenEffects,
        status,
        observedCode,
        observedEffects,
      }) => {
        const expected =
          typeof id === "string" ? requiredFaults.get(id) : undefined;
        return (
          !expected ||
          stage !== expected.stage ||
          expectedCode !== expected.expectedCode ||
          status !== "passed" ||
          observedCode !== expected.expectedCode ||
          !Array.isArray(forbiddenEffects) ||
          forbiddenEffects.length !==
            PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS.length ||
          PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS.some(
            (effect) => !forbiddenEffects.includes(effect),
          ) ||
          !Array.isArray(observedEffects) ||
          observedEffects.some((effect) => forbiddenEffects.includes(effect))
        );
      },
    )
  )
    failures.push("fault matrix is incomplete or failed");

  const stress = json(bytes["stress.json"], "stress report");
  const stressReports = array(stress.reports, "stress reports").map((value) =>
    record(value, "stress report"),
  );
  const stressObjectIds = new Set(
    stressReports.map(({ objectId }) => objectId),
  );
  if (
    stress.status !== "passed" ||
    stressReports.length !== verifiedObjectIds.size ||
    stressObjectIds.size !== stressReports.length ||
    [...verifiedObjectIds].some((id) => !stressObjectIds.has(id)) ||
    [...typedRejectedObjectIds].some((id) => stressObjectIds.has(id)) ||
    stressReports.some((report) => {
      if (report.status !== "passed") return true;
      const cases = array(report.cases, "stress cases").map((value) =>
        record(value, "stress case"),
      );
      return (
        [1, 8, 32, 64].some(
          (level) => !cases.some(({ concurrency }) => concurrency === level),
        ) ||
        cases.some((entry) => {
          const work = record(entry.sourceWork, "stress source work");
          return (
            entry.status !== "passed" ||
            (Array.isArray(entry.failures) && entry.failures.length > 0) ||
            work.parentScans !== 0 ||
            typeof entry.operations !== "number" ||
            !Number.isSafeInteger(entry.operations) ||
            entry.operations <= 0 ||
            typeof work.bytesRead !== "number" ||
            typeof work.readCalls !== "number" ||
            typeof work.rowsRead !== "number" ||
            work.bytesRead > entry.operations * 128 * 1024 ||
            work.readCalls > entry.operations * 2 ||
            work.rowsRead > entry.operations * 8
          );
        })
      );
    })
  )
    failures.push("stress evidence lacks required concurrency levels");

  const soak = json(bytes["soak.json"], "soak report");
  const soakFailures = soakResourceFailures(soak);
  const soakLifecycle = soakLifecycleFailures(soak);
  if (
    soak.schemaVersion !== "elizaos.progressive-content.mixed-soak.v1" ||
    soak.status !== "passed" ||
    soak.commit !== result.commit ||
    soak.corpusManifestSha256 !== result.corpusManifestSha256 ||
    soak.clockSource !== "system-monotonic" ||
    soak.evidenceEligible !== true ||
    typeof soak.durationMs !== "number" ||
    !Number.isFinite(soak.durationMs) ||
    soak.durationMs < 6 * 60 * 60 * 1_000 ||
    soak.requiredDurationMs !== 6 * 60 * 60 * 1_000 ||
    typeof soak.operations !== "number" ||
    !Number.isSafeInteger(soak.operations) ||
    soak.operations < 100_000 ||
    soak.requiredOperations !== 100_000 ||
    soak.positiveLeakControlDetected !== true ||
    soak.positiveLeakControlKind !== "retained-array-buffer" ||
    soakFailures.length > 0 ||
    soakFamilyFailures(soak).length > 0 ||
    soakLifecycle.length > 0
  )
    failures.push(
      "soak evidence lacks production duration, exact family operations, or leak control",
    );
  failures.push(...soakFailures);
  failures.push(...soakLifecycle);

  try {
    validateProgressiveContentPostgresEvidence(
      json(bytes["postgres.json"], "Postgres report"),
      {
        commit: result.commit,
        corpusManifestSha256: result.corpusManifestSha256,
        objects: objects.map((object) => ({
          id: String(object.id),
          family: String(object.family),
          format: String(object.format),
          byteLength: Number(object.byteLength),
          sourceSha256: String(object.sourceSha256),
          revision: String(object.revision),
          authorizationScope: String(object.authorizationScope),
        })),
      },
    );
  } catch (error) {
    failures.push(
      `real Postgres evidence is incomplete: ${
        error instanceof Error ? error.message : "invalid report"
      }`,
    );
  }

  const scenario = json(bytes["scenario.json"], "scenario report");
  failures.push(...deterministicScenarioFailures(scenario));

  const nativeScenario = jsonLines(
    bytes["scenario-native.jsonl"],
    "scenario native export",
  );
  if (
    nativeScenario.some((entry) => !passingScenarioNativeRow(entry)) ||
    !nativeScenario.some(scenarioNativeToolCall) ||
    !nativeScenario.some(scenarioNativeFinal)
  )
    failures.push(
      "scenario native export contains invalid rows or lacks tool and final events",
    );

  const trajectories = jsonLines(bytes["trajectories.jsonl"], "trajectories");
  const repetitions = new Set(trajectories.map(({ repetition }) => repetition));
  const trajectoryCoordinates = new Set(
    trajectories.map(
      ({ repetition, family }) => `${String(repetition)}:${String(family)}`,
    ),
  );
  if (
    trajectories.length !== 5 * CONTENT_CONTEXT_FAMILIES.length ||
    repetitions.size !== 5 ||
    [...repetitions].some(
      (repetition) =>
        typeof repetition !== "number" ||
        !Number.isSafeInteger(repetition) ||
        repetition < 0 ||
        repetition >= 5,
    ) ||
    trajectoryCoordinates.size !== trajectories.length ||
    [...repetitions].some((repetition) =>
      CONTENT_CONTEXT_FAMILIES.some(
        (family) =>
          !trajectoryCoordinates.has(`${String(repetition)}:${family}`),
      ),
    ) ||
    trajectories.some((entry) => !validLiveTrajectory(entry, result))
  )
    failures.push(
      "live-model trajectories lack five qualified clean six-family repetitions",
    );

  const e2e = json(bytes["e2e.json"], "E2E report");
  const e2eArtifacts = contentContextE2EArtifactDeclarations(bytes["e2e.json"]);
  const e2eChecks = record(e2e.checks, "E2E checks");
  if (
    e2e.status !== "passed" ||
    e2e.commit !== result.commit ||
    e2e.corpusManifestSha256 !== result.corpusManifestSha256 ||
    typeof e2e.runId !== "string" ||
    !e2e.runId ||
    [
      "api",
      "ui",
      "inspector",
      "backend",
      "browser",
      "network",
      "database",
    ].some((key) => e2eChecks[key] !== true)
  )
    failures.push("real API/UI inspector E2E evidence is incomplete");
  failures.push(
    ...e2eReferencedByteFailures(e2eArtifacts, referencedArtifactBytes),
  );
  return failures;
}

/** Reject incomplete declarations, byte mismatches, or semantically false success evidence. */
export function validateContentContextResult(
  value: unknown,
  artifactBytes: ContentContextArtifactBytes,
  referencedArtifactBytes: ContentContextReferencedArtifactBytes,
): ContentContextResult {
  const input = record(value, "content-context result");
  exactKeys(
    input,
    [
      "schemaVersion",
      "commit",
      "corpusManifestSha256",
      "generatorRevision",
      "status",
      "artifacts",
    ],
    "content-context result",
  );
  const suppliedArtifactNames = Object.keys(
    artifactBytes as Readonly<Record<string, Uint8Array>>,
  );
  if (
    suppliedArtifactNames.length !==
      CONTENT_CONTEXT_REQUIRED_ARTIFACTS.length ||
    suppliedArtifactNames.some(
      (name) =>
        !(CONTENT_CONTEXT_REQUIRED_ARTIFACTS as readonly string[]).includes(
          name,
        ),
    )
  ) {
    throw new TypeError("content-context artifact byte fields are not exact");
  }
  if (
    input.schemaVersion !== CONTENT_CONTEXT_RESULT_SCHEMA_VERSION ||
    typeof input.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(input.commit) ||
    typeof input.corpusManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.corpusManifestSha256) ||
    typeof input.generatorRevision !== "string" ||
    !input.generatorRevision.trim() ||
    (input.status !== "passed" && input.status !== "failed")
  )
    throw new TypeError("content-context result identity or status is invalid");
  const artifacts = array(input.artifacts, "content-context artifacts");
  if (artifacts.length !== CONTENT_CONTEXT_REQUIRED_ARTIFACTS.length) {
    throw new TypeError("content-context artifact declarations are not exact");
  }
  const seen = new Set<string>();
  for (const value of artifacts) {
    const artifact = record(value, "content-context artifact");
    exactKeys(
      artifact,
      ["name", "sha256", "bytes"],
      "content-context artifact",
    );
    const name = artifact.name;
    if (
      typeof name !== "string" ||
      !(CONTENT_CONTEXT_REQUIRED_ARTIFACTS as readonly string[]).includes(
        name,
      ) ||
      seen.has(name) ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      typeof artifact.bytes !== "number" ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0
    )
      throw new TypeError("content-context artifact declaration is invalid");
    const actual = artifactBytes[name as ContentContextRequiredArtifact];
    if (!(actual instanceof Uint8Array)) {
      throw new TypeError(`content-context bytes missing: ${name}`);
    }
    if (
      actual.byteLength !== artifact.bytes ||
      createHash("sha256").update(actual).digest("hex") !== artifact.sha256
    )
      throw new TypeError(`content-context artifact bytes differ: ${name}`);
    seen.add(name);
  }
  const missing = CONTENT_CONTEXT_REQUIRED_ARTIFACTS.filter(
    (name) => !seen.has(name),
  );
  if (missing.length > 0) {
    throw new TypeError(
      `content-context result is missing: ${missing.join(",")}`,
    );
  }
  const typed = value as ContentContextResult;
  const failures = semanticFailures(
    typed,
    artifactBytes,
    referencedArtifactBytes,
  );
  if (typed.status === "passed" && failures.length > 0) {
    throw new TypeError(
      `content-context success is semantically invalid: ${failures.join("; ")}`,
    );
  }
  return typed;
}
