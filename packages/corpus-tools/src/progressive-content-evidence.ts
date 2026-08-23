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
  for (const report of array(conformance.reports, "conformance reports").map(
    (value) => record(value, "conformance report"),
  )) {
    if (
      report.status !== "passed" ||
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
  for (const sample of array(sourceWork.samples, "source samples").map(
    (value) => record(value, "source sample"),
  )) {
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
    if (
      !benchmarkCases.some(
        ({ sourceBytes }) =>
          typeof sourceBytes === "number" && sourceBytes >= minimum,
      )
    )
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
  if (
    cleanup.status !== "passed" ||
    cleanup.restartVerified !== true ||
    cleanup.authorizationVerified !== true ||
    array(cleanup.probes, "cleanup probes").some(
      (value) => record(value, "cleanup probe").absent !== true,
    )
  )
    failures.push(
      "cleanup evidence lacks absence, restart, or authorization proof",
    );
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
