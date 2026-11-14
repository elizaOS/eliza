/** Require a complete, non-overlapping set of source-bound formal results. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APALACHE_VERSION,
  loadQuintModels,
  QUINT_VERSION,
  quintRepositoryFingerprint,
} from "./check-quint.ts";
import { selectQuintShard } from "./lib/quint-shards.ts";
import { testOutputPath } from "./lib/test-output.ts";

function record(value: unknown, message: string): Record<string, unknown> {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    message,
  );
  return value as Record<string, unknown>;
}

function strings(value: unknown, message: string): string[] {
  assert.ok(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    message,
  );
  return value as string[];
}

export function validateQuintShardReports(
  directory: string,
  reports: unknown[],
  count: number,
) {
  const models = loadQuintModels(directory);
  // This also validates the count, including the empty-partition case.
  selectQuintShard(models, { index: 1, count });
  assert.equal(
    reports.length,
    count,
    "Every configured Quint shard must provide a report",
  );
  const fingerprint = quintRepositoryFingerprint(directory);
  const allFiles = models.map((model) => model.file);
  const seen = new Set<number>();
  let commands = 0;
  let cases = 0;

  for (const rawReport of reports) {
    const report = record(rawReport, "Invalid Quint shard report");
    const shard = record(
      report.shard,
      "Unsharded evidence cannot satisfy the shard gate",
    );
    assert.ok(typeof shard.index === "number", "Missing shard index");
    const index = shard.index;
    assert.ok(
      Number.isSafeInteger(index) && index >= 1 && index <= count,
      "Invalid shard index",
    );
    assert.equal(
      shard.count,
      count,
      "Shard count does not match the configured gate",
    );
    assert.ok(!seen.has(index), "Duplicate Quint shard report");
    seen.add(index);
    assert.equal(
      report.mode,
      "exhaustive-tlc",
      "Simulation is not exhaustive verification",
    );
    assert.equal(
      report.quintVersion,
      QUINT_VERSION,
      "Unexpected Quint version",
    );
    assert.equal(
      report.apalacheVersion,
      APALACHE_VERSION,
      "Unexpected checker version",
    );
    assert.equal(report.completed, true, "Quint shard did not complete");
    assert.equal(
      report.repositorySha256,
      fingerprint,
      "Quint shard used different source",
    );
    assert.equal(
      report.observedRepositorySha256,
      fingerprint,
      "Quint shard source changed",
    );
    assert.deepEqual(
      shard.allModels,
      allFiles,
      "Shard inventory differs from current source",
    );
    const selected = selectQuintShard(models, { index, count });
    assert.deepEqual(
      shard.models,
      selected.map((model) => model.file),
      "Shard selection omitted, duplicated or moved a model",
    );
    assert.ok(Array.isArray(report.results), "Quint shard results are missing");
    const results = report.results.map((value) =>
      record(value, "Invalid formal command result"),
    );
    const expectedKeys = new Set(
      selected.flatMap((model) =>
        model.cases.map((item) => `${model.file}#${item.name}`),
      ),
    );
    for (const result of results) {
      assert.ok(
        typeof result.key === "string" && expectedKeys.has(result.key),
        "Unexpected model/case result",
      );
      assert.equal(
        result.matchedExpectation,
        true,
        "A formal outcome did not match its obligation",
      );
      assert.equal(
        result.repositoryChanged,
        false,
        "Source changed during a formal command",
      );
      assert.equal(
        result.repositorySha256After,
        fingerprint,
        "Command used different source",
      );
      assert.equal(
        result.signal,
        null,
        "Interrupted commands do not count as verification",
      );
      assert.equal(
        result.error,
        undefined,
        "A command infrastructure error is not a proof",
      );
      const kind = strings(result.command, "Invalid command")[0];
      if (kind !== "verify") {
        assert.equal(
          result.exitCode,
          0,
          "Only verification may produce an expected counterexample",
        );
        for (const key of [
          "expectedTemporalOutcome",
          "observedTemporalOutcome",
          "temporalProperties",
        ]) {
          assert.equal(
            result[key],
            undefined,
            "Only verification may carry temporal evidence",
          );
        }
      }
      if (result.expectedTemporalOutcome === "counterexample") {
        assert.equal(
          result.exitCode,
          1,
          "Expected counterexample exit is missing",
        );
        assert.equal(
          result.observedTemporalOutcome,
          "counterexample",
          "Expected counterexample was not observed",
        );
      } else {
        assert.equal(result.exitCode, 0, "Formal command failed");
        if (result.expectedTemporalOutcome !== undefined) {
          assert.equal(result.expectedTemporalOutcome, "holds");
          assert.equal(result.observedTemporalOutcome, "holds");
        }
      }
    }

    for (const model of selected) {
      const sourceFiles = [
        ...new Set([
          model.file,
          model.file.replace(/\.qnt$/, ".cases.json"),
          ...model.sources,
          ...(model.conformance ? [model.conformance] : []),
        ]),
      ];
      const inputHashes = Object.fromEntries(
        sourceFiles.map((file) => [
          file,
          createHash("sha256")
            .update(readFileSync(path.join(directory, file)))
            .digest("hex"),
        ]),
      );
      for (const item of model.cases) {
        cases++;
        const key = `${model.file}#${item.name}`;
        const rows = results.filter((result) => result.key === key);
        const negatives = (item.temporalChecks ?? []).filter(
          (check) => check.expect === "counterexample",
        );
        const positives = (item.temporalChecks ?? []).filter(
          (check) => check.expect === "holds",
        );
        const hasConformance = Boolean(
          model.conformance && item === model.cases.at(-1),
        );
        assert.equal(
          rows.length,
          3 + negatives.length + Number(hasConformance),
          `${key}: missing or duplicated commands`,
        );
        for (const row of rows) {
          assert.deepEqual(
            row.configuration,
            item,
            `${key}: configuration changed`,
          );
          assert.deepEqual(
            row.inputSha256,
            inputHashes,
            `${key}: inputs differ from checked source`,
          );
          const command = strings(row.command, "Invalid command");
          if (command[0] === "typecheck") {
            assert.deepEqual(command, [
              "typecheck",
              path.join(directory, model.file),
            ]);
          }
          if (command[0] === "test") {
            assert.deepEqual(command, [
              "test",
              path.join(directory, model.file),
              "--main",
              item.main,
              "--backend",
              "typescript",
              "--seed",
              "20261107",
            ]);
          }
          if (command[0] === "verify") {
            const endpoint = command[command.indexOf("--server-endpoint") + 1];
            assert.match(endpoint ?? "", /^127\.0\.0\.1:[1-9]\d{0,4}$/);
            const temporal = strings(
              row.temporalProperties ?? [],
              "Invalid temporal properties",
            );
            assert.deepEqual(
              command,
              [
                "verify",
                path.join(directory, model.file),
                "--main",
                item.main,
                "--init",
                item.init,
                "--step",
                item.step,
                "--backend",
                "tlc",
                "--apalache-version",
                APALACHE_VERSION,
                "--tlc-config",
                path.join(directory, "packages/scripts/quint/tlc.json"),
                "--server-endpoint",
                endpoint,
                "--verbosity",
                "3",
                "--invariants",
                ...item.invariants,
                ...(temporal.length ? ["--temporal", temporal.join(",")] : []),
              ],
              `${key}: formal command differs from the required invocation`,
            );
          }
          if (command[0] !== "conformance") {
            assert.equal(
              command[1],
              path.join(directory, model.file),
              `${key}: wrong specification`,
            );
          }
          if (command[0] === "test" || command[0] === "verify") {
            const option = (name: string) => {
              const position = command.indexOf(name);
              return position === -1 ? undefined : command[position + 1];
            };
            assert.equal(option("--main"), item.main, `${key}: wrong module`);
            if (command[0] === "verify") {
              assert.equal(option("--init"), item.init);
              assert.equal(option("--step"), item.step);
              assert.equal(option("--backend"), "tlc");
              const start = command.indexOf("--invariants") + 1;
              assert.ok(start > 0, `${key}: invariant arguments missing`);
              const following = command.slice(start);
              const end = following.findIndex((part) => part.startsWith("--"));
              assert.deepEqual(
                end === -1 ? following : following.slice(0, end),
                item.invariants,
              );
              assert.deepEqual(
                option("--temporal")?.split(",") ?? [],
                row.temporalProperties ?? [],
                `${key}: temporal arguments differ from checked obligations`,
              );
            }
          }
        }
        const ofKind = (kind: string) =>
          rows.filter(
            (row) => strings(row.command, "Invalid command")[0] === kind,
          );
        assert.equal(
          ofKind("typecheck").length,
          1,
          `${key}: typecheck missing`,
        );
        assert.equal(ofKind("test").length, 1, `${key}: scenarios missing`);
        assert.equal(
          ofKind("conformance").length,
          Number(hasConformance),
          `${key}: conformance missing`,
        );
        if (hasConformance)
          assert.deepEqual(ofKind("conformance")[0].command, [
            "conformance",
            model.conformance,
          ]);
        const verifies = ofKind("verify");
        assert.equal(
          verifies.length,
          1 + negatives.length,
          `${key}: verification missing`,
        );
        const base = verifies.filter(
          (row) => row.expectedTemporalOutcome !== "counterexample",
        );
        assert.equal(base.length, 1, `${key}: safety verification missing`);
        assert.equal(
          base[0].expectedTemporalOutcome,
          positives.length ? "holds" : undefined,
        );
        assert.deepEqual(
          base[0].temporalProperties ?? [],
          positives.map((check) => check.property),
        );
        const negativeProperties = verifies
          .filter((row) => row.expectedTemporalOutcome === "counterexample")
          .flatMap((row) =>
            strings(row.temporalProperties, "Missing counterexample property"),
          );
        assert.deepEqual(
          negativeProperties.sort(),
          negatives.map((check) => check.property).sort(),
          `${key}: counterexample obligations changed`,
        );
      }
    }
    commands += results.length;
  }
  return {
    status: "passed",
    shards: count,
    models: models.length,
    cases,
    commands,
    repositorySha256: fingerprint,
  };
}

function reportFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return reportFiles(file);
    return entry.isFile() && entry.name === "verification.json" ? [file] : [];
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = path.resolve(import.meta.dirname, "../..");
  const input = process.argv[2];
  assert.ok(
    input,
    "Usage: check-quint-shards.ts <download-directory> <shard-count>",
  );
  const count = Number(process.argv[3]);
  const files = reportFiles(path.resolve(input));
  const summary = validateQuintShardReports(
    directory,
    files.map((file) => JSON.parse(readFileSync(file, "utf8"))),
    count,
  );
  const output = testOutputPath("quint");
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, "shards-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `Verified ${summary.shards} shards covering all ${summary.models} models, ${summary.cases} cases and ${summary.commands} formal commands`,
  );
}
