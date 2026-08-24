/** Validates content-context evidence bytes, identities, and cross-artifact semantics before bundling. */

import { createHash } from "node:crypto";

export const CONTENT_CONTEXT_RESULT_SCHEMA_VERSION =
  "elizaos.content-context.result.v2" as const;
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

export const CONTENT_CONTEXT_REQUIRED_FAULTS = [
  "unauthorized",
  "revoked-authorization",
  "stale-revision",
  "missing-source",
  "tampered-reference",
  "concurrent-cleanup",
] as const;

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

/** Build the producer result from the exact artifact bytes that will be ingested. */
export function buildContentContextResult(input: {
  readonly commit: string;
  readonly corpusManifestSha256: string;
  readonly generatorRevision: string;
  readonly artifactBytes: ContentContextArtifactBytes;
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
  return validateContentContextResult(result, input.artifactBytes);
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

function json(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      label,
    );
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8 JSON`, { cause: error });
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
      return record(JSON.parse(line), `${label} line ${index + 1}`);
    } catch (error) {
      throw new TypeError(`${label} line ${index + 1} is invalid JSON`, {
        cause: error,
      });
    }
  });
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
  return RESOURCE_RETAINED_FIELDS.some(
    (field) => (samples.at(-1)?.[field] ?? 0) - (samples[0]?.[field] ?? 0) > 0,
  );
}

function soakResourceFailures(soak: Record<string, unknown>): string[] {
  const failures: string[] = [];
  if (
    soak.sampleEveryOperations !== 1_000 ||
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
  if (
    points.length < 51 ||
    points[0]?.operation !== 0 ||
    (points.at(-1)?.operation ?? -1) < soak.operations ||
    points.some(
      (point, index) =>
        index > 0 &&
        (point.operation <= (points[index - 1]?.operation ?? -1) ||
          point.operation - (points[index - 1]?.operation ?? 0) > 2_000 ||
          point.elapsedMs < (points[index - 1]?.elapsedMs ?? 0)),
    )
  )
    failures.push("soak resource samples are sparse, incomplete, or unordered");
  const postWarmup = points
    .filter(({ operation }) => operation >= (soak.warmupOperations as number))
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

function passingScenarioNativeRow(entry: Record<string, unknown>): boolean {
  const attestation =
    entry.privacyAttestation && typeof entry.privacyAttestation === "object"
      ? (entry.privacyAttestation as Record<string, unknown>)
      : null;
  return (
    entry.format === "eliza_native_v1" &&
    entry.scenarioStatus === "passed" &&
    attestation?.passed === true
  );
}

function scenarioNativeToolCall(entry: Record<string, unknown>): boolean {
  if (!passingScenarioNativeRow(entry)) return false;
  const response = record(entry.response, "scenario native response");
  return Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
}

function scenarioNativeFinal(entry: Record<string, unknown>): boolean {
  if (!passingScenarioNativeRow(entry) || entry.stepType !== "evaluator") {
    return false;
  }
  const response = record(entry.response, "scenario native response");
  if (typeof response.text !== "string") return false;
  try {
    const output = record(JSON.parse(response.text), "scenario native final");
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

function semanticFailures(
  result: ContentContextResult,
  bytes: ContentContextArtifactBytes,
): string[] {
  const failures: string[] = [];
  const manifest = json(bytes["corpus-manifest.json"], "corpus manifest");
  const objects = array(manifest.objects, "corpus objects").map((value) =>
    record(value, "corpus object"),
  );
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
    for (const requiredBytes of [1024 * 1024, 10 * 1024 * 1024]) {
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
  if (ledger.corpusManifestSha256 !== result.corpusManifestSha256) {
    failures.push("realization ledger targets another manifest");
  }
  const realizationEntries = array(ledger.entries, "realization entries").map(
    (value) => record(value, "realization entry"),
  );
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  if (objectsById.size !== objects.length)
    failures.push("corpus object identities are duplicated");
  const realizedObjectIds = new Set<unknown>();
  for (const entry of realizationEntries) {
    const object = objectsById.get(entry.objectId);
    if (!object || realizedObjectIds.has(entry.objectId)) {
      failures.push("native realization identity is missing or duplicated");
    } else {
      realizedObjectIds.add(entry.objectId);
      if (
        entry.family !== object.family ||
        entry.sourceSha256 !== object.sourceSha256 ||
        entry.sourceBytes !== object.byteLength ||
        entry.revision !== object.revision ||
        entry.authorizationScope !== object.authorizationScope
      )
        failures.push("native realization differs from corpus object");
    }
    if (entry.status !== "verified")
      failures.push("native realization is not verified");
    const work = record(entry.sourceWork, "realization source work");
    if (
      typeof work.maxReadBytes !== "number" ||
      work.maxReadBytes > 64 * 1024 ||
      work.bytesRead !== entry.sourceBytes
    )
      failures.push(
        "native realization source work is unbounded or incomplete",
      );
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
    conformanceReports.length !== objects.length ||
    conformanceObjectIds.size !== conformanceReports.length ||
    objects.some(({ id }) => !conformanceObjectIds.has(id))
  )
    failures.push(
      "conformance does not cover every native object exactly once",
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
    for (const [actual, maximum] of [
      [performance.maxPageLatencyMs, ceilings.maxPageLatencyMs],
      [performance.rssGrowthBytes, ceilings.maxRssGrowthBytes],
      [performance.readAmplification, ceilings.maxReadAmplification],
      [performance.readCallsPerPageMax, ceilings.maxReadCallsPerPage],
      [performance.rowsPerPageMax, ceilings.maxRowsPerPage],
    ]) {
      if (
        typeof actual !== "number" ||
        typeof maximum !== "number" ||
        actual > maximum
      )
        failures.push("conformance performance exceeded a ceiling");
    }
  }

  const mutants = json(bytes["mutant-kills.json"], "mutant report");
  const mutantResults = array(mutants.results, "mutant results").map((value) =>
    record(value, "mutant result"),
  );
  if (
    mutants.status !== "passed" ||
    typeof mutants.required !== "number" ||
    mutants.required < 9 ||
    mutants.killRate !== 1 ||
    mutants.required !== mutants.executed ||
    mutants.required !== mutants.killed ||
    mutantResults.some(
      ({ status, failureVectors }) =>
        status !== "killed" ||
        !Array.isArray(failureVectors) ||
        failureVectors.length === 0,
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
  for (const minimum of [1024 * 1024, 10 * 1024 * 1024]) {
    if (!benchmarkCases.some(({ sourceBytes }) => sourceBytes === minimum))
      failures.push(`benchmark lacks ${minimum} byte scale`);
  }
  for (const entry of benchmarkCases) {
    const observed = record(entry.observed, "benchmark observed");
    const ceilings = record(entry.ceilings, "benchmark ceilings");
    for (const metric of [
      "maxPageLatencyMs",
      "rssGrowthBytes",
      "databaseGrowthBytes",
      "readAmplification",
    ]) {
      if (
        typeof observed[metric] !== "number" ||
        typeof ceilings[metric] !== "number" ||
        observed[metric] > ceilings[metric]
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
    pageRowsByObject.size !== objects.length ||
    [...pageRowsByObject.keys()].some((id) => !objectsById.has(id)) ||
    pageLedger.some((entry) => {
      const range = record(entry.range, "page ledger range");
      return (
        typeof entry.objectId !== "string" ||
        typeof entry.revision !== "string" ||
        typeof entry.sliceSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sliceSha256) ||
        typeof range.start !== "number" ||
        typeof range.end !== "number" ||
        range.end < range.start ||
        typeof entry.bytesRead !== "number" ||
        entry.bytesRead > 64 * 1024
      );
    })
  )
    failures.push("page ledger lacks exact bounded native reads");
  for (const object of objects) {
    if (typeof object.id !== "string") {
      failures.push("page ledger encountered an invalid corpus identity");
      continue;
    }
    const rows = pageRowsByObject.get(object.id) ?? [];
    let expectedStart = 0;
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
    }
    if (
      expectedStart !== object.byteLength ||
      rows.length === 0 ||
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
  if (
    faults.status !== "passed" ||
    typeof faults.required !== "number" ||
    faults.required === 0 ||
    faults.required !== faults.executed ||
    faultCatalog.length !== CONTENT_CONTEXT_REQUIRED_FAULTS.length ||
    new Set(faultCatalog).size !== faultCatalog.length ||
    CONTENT_CONTEXT_REQUIRED_FAULTS.some((id) => !faultCatalog.includes(id)) ||
    faultResults.length !== CONTENT_CONTEXT_REQUIRED_FAULTS.length ||
    new Set(faultResults.map(({ id }) => id)).size !== faultResults.length ||
    CONTENT_CONTEXT_REQUIRED_FAULTS.some(
      (id) => !faultResults.some((result) => result.id === id),
    ) ||
    faultResults.some(({ status }) => status !== "passed")
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
    stressReports.length !== objects.length ||
    stressObjectIds.size !== stressReports.length ||
    objects.some(({ id }) => !stressObjectIds.has(id)) ||
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
  if (
    soak.status !== "passed" ||
    soak.commit !== result.commit ||
    soak.corpusManifestSha256 !== result.corpusManifestSha256 ||
    typeof soak.durationMs !== "number" ||
    soak.durationMs < 6 * 60 * 60 * 1_000 ||
    typeof soak.operations !== "number" ||
    soak.operations < 100_000 ||
    soak.positiveLeakControlDetected !== true ||
    soakResourceFailures(soak).length > 0
  )
    failures.push("soak evidence lacks duration, operations, or leak control");

  const postgres = json(bytes["postgres.json"], "Postgres report");
  const postgresFamilies = array(postgres.families, "Postgres families");
  if (
    postgres.status !== "passed" ||
    postgres.backend !== "postgres" ||
    postgres.commit !== result.commit ||
    postgres.corpusManifestSha256 !== result.corpusManifestSha256 ||
    typeof postgres.version !== "string" ||
    !postgres.version ||
    typeof postgres.command !== "string" ||
    !postgres.command ||
    postgresFamilies.length !== CONTENT_CONTEXT_FAMILIES.length ||
    new Set(postgresFamilies).size !== postgresFamilies.length ||
    CONTENT_CONTEXT_FAMILIES.some(
      (family) => !postgresFamilies.includes(family),
    ) ||
    postgres.sharedVectorsPassed !== true
  )
    failures.push("real Postgres evidence is incomplete");

  const scenario = json(bytes["scenario.json"], "scenario report");
  const lateEvidenceFamilies = new Set(
    array(scenario.lateEvidenceFamilies, "late evidence families"),
  );
  if (
    scenario.status !== "passed" ||
    scenario.deterministic !== true ||
    scenario.productionActions !== true ||
    scenario.strictFixtures !== true ||
    ["file", "document", "memory", "email", "attachment", "tool-output"].some(
      (family) => !lateEvidenceFamilies.has(family),
    )
  )
    failures.push("deterministic production-action scenario is incomplete");

  const nativeScenario = jsonLines(
    bytes["scenario-native.jsonl"],
    "scenario native export",
  );
  if (
    !nativeScenario.some(scenarioNativeToolCall) ||
    !nativeScenario.some(scenarioNativeFinal)
  )
    failures.push("scenario native export lacks tool and final events");

  const trajectories = jsonLines(bytes["trajectories.jsonl"], "trajectories");
  const repetitions = new Set(trajectories.map(({ repetition }) => repetition));
  if (
    trajectories.length < 5 ||
    repetitions.size < 5 ||
    trajectories.some(
      (entry) =>
        entry.status !== "passed" ||
        entry.commit !== result.commit ||
        entry.corpusManifestSha256 !== result.corpusManifestSha256 ||
        entry.providerQualified !== true ||
        typeof entry.provider !== "string" ||
        !entry.provider ||
        typeof entry.model !== "string" ||
        !entry.model ||
        /fixture|mock|test|deterministic/iu.test(
          `${entry.provider} ${entry.model}`,
        ) ||
        entry.answerLeakageDetected === true,
    )
  )
    failures.push(
      "live-model trajectories lack five qualified clean repetitions",
    );

  const e2e = json(bytes["e2e.json"], "E2E report");
  if (
    e2e.status !== "passed" ||
    e2e.commit !== result.commit ||
    e2e.corpusManifestSha256 !== result.corpusManifestSha256 ||
    typeof e2e.runId !== "string" ||
    !e2e.runId ||
    !Array.isArray(e2e.artifactPaths) ||
    e2e.artifactPaths.length < 4 ||
    [
      "api",
      "ui",
      "inspector",
      "backend",
      "browser",
      "network",
      "database",
      "artifacts",
    ].some((key) => e2e[key] !== true)
  )
    failures.push("real API/UI inspector E2E evidence is incomplete");
  return failures;
}

/** Reject incomplete declarations, byte mismatches, or semantically false success evidence. */
export function validateContentContextResult(
  value: unknown,
  artifactBytes: ContentContextArtifactBytes,
): ContentContextResult {
  const input = record(value, "content-context result");
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
  const seen = new Set<string>();
  for (const value of artifacts) {
    const artifact = record(value, "content-context artifact");
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
  const failures = semanticFailures(typed, artifactBytes);
  if (typed.status === "passed" && failures.length > 0) {
    throw new TypeError(
      `content-context success is semantically invalid: ${failures.join("; ")}`,
    );
  }
  return typed;
}
