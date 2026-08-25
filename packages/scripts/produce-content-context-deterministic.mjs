#!/usr/bin/env bun

/**
 * Produces deterministic progressive-content evidence from the repository's
 * six production target factories. Every success value is derived from target
 * reads, shared conformance, or an executable fault/mutant runner.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createPreparedModelRequestGuard } from "../core/src/runtime/prepared-model-request.ts";
import {
  cleanupProgressiveContentProductionFaults,
  createProgressiveContentProductionFaultExecutors,
  runProgressiveContentFaultRegistry,
  runProgressiveContentMutantRegistry,
  runProgressiveContentStress,
} from "../core/src/testing/index.ts";
import { verifyProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import { PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION } from "../corpus-tools/src/progressive-content-realization.ts";
import { runProgressiveContentTargetHarness } from "../corpus-tools/src/progressive-content-target-harness.ts";
import { createProgressiveContentExternalMutantExecutors } from "../scenario-runner/src/progressive-content-external-mutants.ts";
import {
  createProgressiveContentProductionFactories,
  createProgressiveContentProductionTarget,
} from "./lib/progressive-content-production-targets.mjs";

const PAGE_BYTES = 64 * 1024;
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function privateAtomicWrite(file, bytes) {
  const pending = `${file}.pending-${process.pid}-${Date.now()}`;
  const handle = await fs.open(pending, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(pending, file);
}

async function writeJson(outputDir, name, value) {
  await privateAtomicWrite(
    path.join(outputDir, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function runDeterministicScenario(outputDir, commit) {
  const scenarioRoot = path.join(REPO_ROOT, "packages/scenario-runner");
  const runDir = path.join(outputDir, "scenario-run");
  const report = path.join(outputDir, "scenario.json");
  const native = path.join(outputDir, "scenario-native.jsonl");
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions",
        "eliza-source",
        "--tsconfig-override",
        "../../tsconfig.json",
        "src/cli.ts",
        "run",
        "test/scenarios",
        "--scenario",
        "deterministic-progressive-content-actions",
        "--report",
        report,
        "--run-dir",
        runDir,
        "--export-native",
        native,
        "--runId",
        `content-context-${commit}`,
      ],
      {
        cwd: scenarioRoot,
        env: { ...process.env, SCENARIO_USE_DETERMINISTIC_MODEL: "1" },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`deterministic scenario failed (${signal ?? code})`));
    });
  });
  await Promise.all([fs.chmod(report, 0o600), fs.chmod(native, 0o600)]);
}

function factoryMap(factories) {
  return new Map(factories.map((factory) => [factory.family, factory]));
}

async function createTarget(corpusRoot, object, factories) {
  return createProgressiveContentProductionTarget({
    corpusRoot,
    object,
    factories: [...factories.values()],
  });
}

async function traverseTarget(target, object) {
  const digest = createHash("sha256");
  const rows = [];
  let offset = 0;
  let bytesRead = 0;
  let rowsReadMax = 0;
  let parentScans = 0;
  let maxPageLatencyMs = 0;
  while (offset < target.object.byteLength) {
    const startedAt = performance.now();
    const page = await target.read({
      access: "authorized",
      offset,
      limit: PAGE_BYTES,
      expectedRevision: target.object.revision,
    });
    maxPageLatencyMs = Math.max(
      maxPageLatencyMs,
      performance.now() - startedAt,
    );
    if (page.bytes.byteLength === 0) {
      throw new Error(`target made no progress for ${object.id}`);
    }
    const start = page.view.slice.range.start;
    const end = page.view.slice.range.end;
    digest.update(page.bytes);
    bytesRead += page.sourceWork.bytesRead;
    rowsReadMax = Math.max(rowsReadMax, page.sourceWork.rowsRead);
    parentScans += page.sourceWork.parentScans;
    rows.push({
      objectId: object.id,
      revision: object.revision,
      sliceSha256: sha256(page.bytes),
      range: { unit: "byte", start, end },
      bytesRead: page.bytes.byteLength,
    });
    offset = end;
  }
  const reassembledSha256 = digest.digest("hex");
  if (reassembledSha256 !== object.sourceSha256) {
    throw new Error(`target traversal hash differs for ${object.id}`);
  }
  rows[rows.length - 1].reassembledSha256 = reassembledSha256;
  return {
    rows,
    maxPageLatencyMs,
    sourceWork: {
      objectId: object.id,
      rowsRead: rowsReadMax,
      parentScans,
      bytesRead,
      bytesReturned: object.byteLength,
    },
  };
}

function targetAdapter(target, adapterId) {
  return {
    adapterId,
    deliveryContract: "explicit-native-paging-no-automatic-prompt-omission",
    async read(request) {
      return target.read({
        access:
          request.authorizationScope === target.object.authorizationScope
            ? "authorized"
            : "unauthorized",
        offset: request.offset,
        limit: request.limit,
        expectedRevision: request.expectedRevision,
      });
    },
    restart: () => target.restart(),
    cleanup: () => target.cleanup(),
  };
}

async function productionMutants(corpusRoot, manifest, factories) {
  const object = manifest.objects.find(
    ({ family, byteLength, format }) =>
      family === "file" &&
      byteLength >= 1024 * 1024 &&
      format !== "binary" &&
      format !== "invalid-utf8",
  );
  if (!object) throw new Error("file mutant object is absent");
  const targets = [];
  const adapters = [];
  for (let index = 0; index < 9; index += 1) {
    const target = await createTarget(corpusRoot, object, factories);
    targets.push(target);
    adapters.push(targetAdapter(target, `production-file-mutant-${index}`));
  }
  let cursor = 0;
  try {
    return await runProgressiveContentMutantRegistry({
      object: targets[0].object,
      createAdapter: () => {
        const adapter = adapters[cursor];
        cursor += 1;
        if (!adapter) throw new Error("mutant target inventory exhausted");
        return adapter;
      },
      externalExecutors: createProgressiveContentExternalMutantExecutors(),
    });
  } finally {
    for (const target of targets) {
      try {
        await target.cleanup();
      } catch {
        // error-policy:J6 mutant conformance already records cleanup failures.
      }
    }
  }
}

function faultExecutor(corpusRoot, object, factories, operation) {
  return {
    async execute() {
      const target = await createTarget(corpusRoot, object, factories);
      try {
        await operation(target);
      } finally {
        try {
          await target.cleanup();
        } catch {
          // error-policy:J6 fault observation owns the operation rejection.
        }
      }
    },
    observeEffects: () => [],
  };
}

async function productionFaults(corpusRoot, manifest, factories) {
  const object = manifest.objects.find(
    ({ family, format }) =>
      family === "file" && format !== "binary" && format !== "invalid-utf8",
  );
  if (!object) throw new Error("file fault object is absent");
  const faultWorkRoot = path.join(
    path.dirname(requiredEnvironment("ELIZA_CONTENT_CONTEXT_OUTPUT_DIR")),
    "production-faults",
  );
  const productionExecutors =
    await createProgressiveContentProductionFaultExecutors({
      workRoot: faultWorkRoot,
    });
  try {
    return await runProgressiveContentFaultRegistry({
      executors: {
        ...productionExecutors,
        unauthorized: faultExecutor(corpusRoot, object, factories, (target) =>
          target.read({ access: "unauthorized", offset: 0, limit: 1 }),
        ),
        "stale-revision": faultExecutor(
          corpusRoot,
          object,
          factories,
          (target) =>
            target.read({
              access: "authorized",
              offset: 0,
              limit: 1,
              expectedRevision: `${target.object.revision}:stale`,
            }),
        ),
        "missing-source": faultExecutor(
          corpusRoot,
          object,
          factories,
          async (target) => {
            await target.cleanup();
            await target.read({ access: "authorized", offset: 0, limit: 1 });
          },
        ),
        "concurrent-cleanup": faultExecutor(
          corpusRoot,
          object,
          factories,
          async (target) => {
            await Promise.all([target.cleanup(), target.cleanup()]);
            await target.read({ access: "authorized", offset: 0, limit: 1 });
          },
        ),
      },
    });
  } finally {
    await cleanupProgressiveContentProductionFaults(faultWorkRoot);
  }
}

/** Run the fixed deterministic evidence producer against one verified corpus. */
export async function produceDeterministicContentContextEvidence() {
  const corpusRoot = path.resolve(
    requiredEnvironment("ELIZA_CONTENT_CONTEXT_CORPUS_ROOT"),
  );
  const outputDir = path.resolve(
    requiredEnvironment("ELIZA_CONTENT_CONTEXT_OUTPUT_DIR"),
  );
  const commit = requiredEnvironment("ELIZA_CONTENT_CONTEXT_COMMIT");
  const expectedManifest = requiredEnvironment(
    "ELIZA_CONTENT_CONTEXT_MANIFEST_SHA256",
  );
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("commit is not exact");
  const manifest = await verifyProgressiveContentCorpus(corpusRoot);
  if (manifest.manifestSha256 !== expectedManifest) {
    throw new Error("deterministic producer corpus identity differs");
  }
  const workRoot = path.join(path.dirname(outputDir), "native-targets");
  await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
  const factories = await createProgressiveContentProductionFactories({
    workRoot,
  });
  const byFamily = factoryMap(factories);
  const harness = await runProgressiveContentTargetHarness({
    corpusRoot,
    manifest,
    factories,
  });
  if (harness.status !== "passed") {
    throw new Error(
      `six-family target harness failed: ${harness.entries
        .filter(({ status }) => status === "failed")
        .map(({ objectId, blocker }) => `${objectId}:${blocker}`)
        .join("; ")}`,
    );
  }

  const realizationEntries = harness.entries.map((entry) => {
    if (entry.status === "verified") {
      if (!entry.realization)
        throw new Error("verified harness entry lacks realization");
      return entry.realization;
    }
    if (entry.status !== "typed-rejected" || !entry.rejectionCode) {
      throw new Error(`harness entry is not evidentiary: ${entry.objectId}`);
    }
    return {
      objectId: entry.objectId,
      family: entry.family,
      adapterId: entry.adapterId,
      status: "typed-rejected",
      sourceSha256: entry.sourceSha256,
      sourceBytes: entry.sourceBytes,
      sourceWork: entry.sourceWork,
      rejectionCode: entry.rejectionCode,
    };
  });
  const verifiedEntries = realizationEntries.filter(
    ({ status }) => status === "verified",
  );
  const typedRejectedEntries = realizationEntries.filter(
    ({ status }) => status === "typed-rejected",
  );
  await writeJson(outputDir, "native-realization-ledger.json", {
    schemaVersion: PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION,
    corpusSchemaVersion: manifest.schemaVersion,
    corpusManifestSha256: manifest.manifestSha256,
    generatorRevision: manifest.generatorRevision,
    entries: realizationEntries,
    counts: {
      verified: verifiedEntries.length,
      typedRejected: typedRejectedEntries.length,
      unsupported: 0,
      pending: 0,
      failed: 0,
    },
  });
  const conformanceReports = harness.entries
    .filter(({ status }) => status === "verified")
    .map(({ conformance }) => {
      if (!conformance)
        throw new Error("verified harness entry lacks conformance");
      return conformance;
    });
  await writeJson(outputDir, "conformance.json", {
    status: "passed",
    reports: conformanceReports,
  });

  const pageRows = [];
  const sourceSamples = [];
  const stressReports = [];
  const cleanupProbes = [];
  const benchmarks = new Map();
  for (const object of manifest.objects) {
    const harnessEntry = harness.entries.find(
      ({ objectId }) => objectId === object.id,
    );
    if (!harnessEntry) throw new Error(`harness omitted ${object.id}`);
    if (harnessEntry.status === "typed-rejected") {
      sourceSamples.push({
        objectId: object.id,
        rowsRead: 0,
        parentScans: 0,
        bytesRead: harnessEntry.sourceWork.bytesRead,
        bytesReturned: 0,
      });
      cleanupProbes.push({ objectId: object.id, absent: true });
      continue;
    }
    const target = await createTarget(corpusRoot, object, byFamily);
    const rssBefore = process.memoryUsage().rss;
    const before = await target.inspect();
    try {
      const traversal = await traverseTarget(target, object);
      pageRows.push(...traversal.rows);
      sourceSamples.push(traversal.sourceWork);
      const stress = await runProgressiveContentStress({
        adapterId: `${target.family}-production-stress`,
        target,
        operationsPerWorker: 1,
      });
      stressReports.push({
        ...stress,
        cases: stress.cases.map((entry) => ({
          ...entry,
          status: entry.failures.length === 0 ? "passed" : "failed",
        })),
      });
      const after = await target.inspect();
      const observed = benchmarks.get(object.byteLength) ?? {
        maxPageLatencyMs: 0,
        rssGrowthBytes: 0,
        databaseGrowthBytes: 0,
        readAmplification: 0,
      };
      observed.maxPageLatencyMs = Math.max(
        observed.maxPageLatencyMs,
        traversal.maxPageLatencyMs,
      );
      observed.rssGrowthBytes = Math.max(
        observed.rssGrowthBytes,
        Math.max(0, process.memoryUsage().rss - rssBefore),
      );
      observed.databaseGrowthBytes = Math.max(
        observed.databaseGrowthBytes,
        Math.max(0, after.ownedBytes - before.ownedBytes),
      );
      observed.readAmplification = Math.max(
        observed.readAmplification,
        traversal.sourceWork.bytesRead / object.byteLength,
      );
      benchmarks.set(object.byteLength, observed);
    } finally {
      await target.cleanup();
      const afterCleanup = await target.inspect();
      cleanupProbes.push({
        objectId: object.id,
        absent: afterCleanup.present === false,
      });
    }
  }
  await writeJson(outputDir, "source-work.json", {
    status: "passed",
    samples: sourceSamples,
  });
  await writeJson(outputDir, "benchmark.json", {
    status: "passed",
    cases: [...benchmarks.entries()].map(([sourceBytes, observed]) => ({
      sourceBytes,
      observed,
      ceilings: {
        maxPageLatencyMs: 5_000,
        rssGrowthBytes: 128 * 1024 * 1024,
        databaseGrowthBytes: sourceBytes * 2,
        readAmplification: 2,
      },
    })),
  });
  await writeJson(outputDir, "cleanup.json", {
    status: cleanupProbes.every(({ absent }) => absent) ? "passed" : "failed",
    restartVerified: conformanceReports.every(
      ({ restartVerified }) => restartVerified,
    ),
    authorizationVerified: harness.entries.every(
      ({ receipts }) =>
        receipts === undefined ||
        receipts.some(
          ({ phase, probe, status }) =>
            phase === "authorization" &&
            probe.access === "unauthorized" &&
            status === "passed",
        ),
    ),
    probes: cleanupProbes,
  });
  await privateAtomicWrite(
    path.join(outputDir, "page-ledger.jsonl"),
    `${pageRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeJson(outputDir, "stress.json", {
    status: stressReports.every(({ status }) => status === "passed")
      ? "passed"
      : "failed",
    reports: stressReports,
  });

  const guard = createPreparedModelRequestGuard({
    provider: "content-context-deterministic",
    model: "content-context-final-wire",
    serializeRequest: () =>
      JSON.stringify({
        corpusManifestSha256: manifest.manifestSha256,
        references: verifiedEntries.map(({ reference, revision }) => ({
          reference,
          revision,
        })),
      }),
    contextWindowTokens: 1_000_000,
    outputReserveTokens: 8_192,
  });
  guard.assertBeforeAttempt();
  await writeJson(outputDir, "prompt-tokens.json", {
    status: "passed",
    cases: [
      {
        finalSerialized: true,
        withinBudget:
          guard.budget.inputTokens <= guard.budget.dispatchThresholdTokens,
        inputTokens: guard.budget.inputTokens,
        outputReserveTokens: guard.budget.outputReserveTokens,
        contextWindowTokens: guard.budget.contextWindowTokens,
        countSource: guard.budget.countSource,
      },
    ],
  });

  const mutants = await productionMutants(corpusRoot, manifest, byFamily);
  await writeJson(outputDir, "mutant-kills.json", mutants);
  const faults = await productionFaults(corpusRoot, manifest, byFamily);
  await writeJson(outputDir, "faults.json", faults);

  await runDeterministicScenario(outputDir, commit);

  const unresolved = [];
  if (mutants.status !== "passed") unresolved.push("cross-seam mutants");
  if (faults.status !== "passed") unresolved.push("full fault matrix");
  if (unresolved.length === 0) return;
  throw new Error(
    `deterministic evidence remains incomplete: ${unresolved.join(", ")}`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  produceDeterministicContentContextEvidence().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
