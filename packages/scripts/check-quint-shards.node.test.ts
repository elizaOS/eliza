import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  APALACHE_VERSION,
  loadQuintModels,
  main,
  QUINT_VERSION,
  quintRepositoryFingerprint,
} from "./check-quint.ts";
import { validateQuintShardReports } from "./check-quint-shards.ts";
import {
  parseQuintShard,
  quintShardForFile,
  selectQuintShard,
} from "./lib/quint-shards.ts";
import { testOutputPath } from "./lib/test-output.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface EvidenceResult {
  key: string;
  configuration: unknown;
  inputSha256: Record<string, string>;
  repositorySha256After: string;
  repositoryChanged: boolean;
  exitCode: number;
  signal: string | null;
  matchedExpectation: boolean;
  command: string[];
  expectedTemporalOutcome?: string;
  observedTemporalOutcome?: string;
  temporalProperties?: string[];
}

function defined<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

function fixture() {
  const output = testOutputPath("quint-shard-tests");
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(path.join(output, "repository-"));
  temporary.push(directory);
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Quint test",
      "-c",
      "user.email=quint@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "--no-verify",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );
  const folder = path.join(directory, "packages/example/quint");
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(directory, ".gitignore"), "test-results/\n");
  writeFileSync(path.join(folder, "source.ts"), "export const value = 1;\n");
  writeFileSync(path.join(folder, "conformance.mjs"), "process.exit(0);\n");
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    writeFileSync(path.join(folder, `${name}.qnt`), `module ${name} {}\n`);
    writeFileSync(
      path.join(folder, `${name}.cases.json`),
      JSON.stringify({
        sources: ["packages/example/quint/source.ts"],
        conformance: "packages/example/quint/conformance.mjs",
        cases: [
          {
            name: "bounded",
            main: name,
            init: "init",
            step: "step",
            invariants: ["Safe"],
            temporal: ["Progress", "Unsupported"],
            temporalChecks: [
              {
                property: "Progress",
                expect: "holds",
                assumptions: ["fair worker"],
              },
              {
                property: "Unsupported",
                expect: "counterexample",
                assumptions: ["unfair environment"],
              },
            ],
            maxSteps: 10,
            samples: 20,
          },
        ],
      }),
    );
  }
  return directory;
}

function evidence(directory: string, count = 4) {
  const models = loadQuintModels(directory);
  const fingerprint = quintRepositoryFingerprint(directory);
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const selected = selectQuintShard(models, { index, count });
    const results: EvidenceResult[] = selected.flatMap((model) =>
      model.cases.flatMap((item) => {
        const conformance = defined(model.conformance);
        const hashes = Object.fromEntries(
          [
            model.file,
            model.file.replace(/\.qnt$/, ".cases.json"),
            ...model.sources,
            conformance,
          ].map((file) => [
            file,
            createHash("sha256")
              .update(readFileSync(path.join(directory, file)))
              .digest("hex"),
          ]),
        );
        const common = {
          key: `${model.file}#${item.name}`,
          configuration: item,
          inputSha256: hashes,
          repositorySha256After: fingerprint,
          repositoryChanged: false,
          exitCode: 0,
          signal: null,
          matchedExpectation: true,
        };
        const verify = [
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
          "127.0.0.1:30000",
          "--verbosity",
          "3",
          "--invariants",
          ...item.invariants,
        ];
        return [
          {
            ...common,
            command: ["typecheck", path.join(directory, model.file)],
          },
          {
            ...common,
            command: [
              "test",
              path.join(directory, model.file),
              "--main",
              item.main,
              "--backend",
              "typescript",
              "--seed",
              "20261107",
            ],
          },
          {
            ...common,
            command: [...verify, "--temporal", "Progress"],
            expectedTemporalOutcome: "holds",
            observedTemporalOutcome: "holds",
            temporalProperties: ["Progress"],
          },
          {
            ...common,
            command: [...verify, "--temporal", "Unsupported"],
            exitCode: 1,
            expectedTemporalOutcome: "counterexample",
            observedTemporalOutcome: "counterexample",
            temporalProperties: ["Unsupported"],
          },
          { ...common, command: ["conformance", conformance] },
        ];
      }),
    );
    return {
      completed: true,
      mode: "exhaustive-tlc",
      quintVersion: QUINT_VERSION,
      apalacheVersion: APALACHE_VERSION,
      repositorySha256: fingerprint,
      observedRepositorySha256: fingerprint,
      shard: {
        index,
        count,
        models: selected.map((model) => model.file),
        allModels: models.map((model) => model.file),
      },
      results,
    };
  });
}

function populatedReport(reports: ReturnType<typeof evidence>) {
  return defined(reports.find((report) => report.results.length > 0));
}

function firstResult(reports: ReturnType<typeof evidence>) {
  return defined(populatedReport(reports).results[0]);
}

test("shards are stable, disjoint and collectively include every model", () => {
  const models = Array.from({ length: 103 }, (_, index) => ({
    file: `packages/cloud/quint/Model${index}.qnt`,
  }));
  const assigned = Array.from({ length: 4 }, (_, index) =>
    selectQuintShard(models, { index: index + 1, count: 4 }),
  ).flat();
  assert.equal(assigned.length, models.length);
  assert.equal(new Set(assigned).size, models.length);
  for (const model of models) {
    assert.equal(
      quintShardForFile(model.file, 4),
      quintShardForFile(model.file.replaceAll("/", "\\"), 4),
    );
  }
  assert.deepEqual(
    selectQuintShard([...models].reverse(), { index: 2, count: 4 }).reverse(),
    selectQuintShard(models, { index: 2, count: 4 }),
  );
  assert.deepEqual(parseQuintShard("--shard=3/4"), { index: 3, count: 4 });
  for (const flag of [
    "--shard=0/4",
    "--shard=5/4",
    "--shard=1/65",
    "--shard=1/0",
    "--shard=1.5/4",
    "--shard=1/4junk",
  ])
    assert.throws(() => parseQuintShard(flag));
});

test("complete reports include empty partitions and every temporal/conformance obligation", () => {
  const directory = fixture();
  const reports = evidence(directory);
  const summary = validateQuintShardReports(directory, reports, 4);
  assert.equal(summary.models, 3);
  assert.equal(summary.cases, 3);
  assert.equal(summary.commands, 15);
  assert.equal(summary.shards, 4);
});

test("sharding rejects unknown models and duplicate shard options before selection", async () => {
  const directory = fixture();
  const output = path.join(directory, "test-results", "invalid");
  await assert.rejects(
    main(["--shard=1/4", "MissingModel"], directory, output),
    /Unknown Quint specification: MissingModel/,
  );
  await assert.rejects(
    main(["--shard=1/4", "--shard=2/4"], directory, output),
    /Only one Quint shard/,
  );
});

test("missing, duplicate or incorrectly partitioned evidence fails closed", () => {
  const directory = fixture();
  const reports = evidence(directory);
  assert.throws(
    () => validateQuintShardReports(directory, reports.slice(1), 4),
    /Every configured/,
  );
  assert.throws(
    () =>
      validateQuintShardReports(
        directory,
        [reports[0], reports[0], ...reports.slice(2)],
        4,
      ),
    /Duplicate/,
  );
  const changed = structuredClone(reports);
  populatedReport(changed).shard.models.pop();
  assert.throws(
    () => validateQuintShardReports(directory, changed, 4),
    /selection omitted/,
  );
});

test("a missing case, scenario, conformance or safety command cannot count as a passing shard", () => {
  const directory = fixture();
  for (const kind of ["typecheck", "test", "verify", "conformance"]) {
    const reports = evidence(directory);
    const report = populatedReport(reports);
    report.results.splice(
      report.results.findIndex((row) => row.command[0] === kind),
      1,
    );
    assert.throws(
      () => validateQuintShardReports(directory, reports, 4),
      /missing or duplicated commands/,
    );
  }
  const reports = evidence(directory);
  const report = populatedReport(reports);
  report.results = [];
  assert.throws(
    () => validateQuintShardReports(directory, reports, 4),
    /missing or duplicated commands/,
  );
});

test("interrupted, stale, failed and weakened proofs are rejected", () => {
  const directory = fixture();
  for (const kind of ["typecheck", "test", "conformance"]) {
    const reports = evidence(directory);
    const row = defined(
      reports
        .flatMap((report) => report.results)
        .find((result) => result.command[0] === kind),
    );
    Object.assign(row, {
      exitCode: 1,
      expectedTemporalOutcome: "counterexample",
      observedTemporalOutcome: "counterexample",
    });
    assert.throws(
      () => validateQuintShardReports(directory, reports, 4),
      /Only verification/,
    );
  }
  for (const mutate of [
    (reports: ReturnType<typeof evidence>) => {
      reports[0].completed = false;
    },
    (reports: ReturnType<typeof evidence>) => {
      reports[0].mode = "simulation";
    },
    (reports: ReturnType<typeof evidence>) => {
      reports[0].repositorySha256 = "stale";
    },
    (reports: ReturnType<typeof evidence>) => {
      firstResult(reports).matchedExpectation = false;
    },
    (reports: ReturnType<typeof evidence>) => {
      firstResult(reports).signal = "SIGTERM";
    },
    (reports: ReturnType<typeof evidence>) => {
      firstResult(reports).inputSha256["packages/example/quint/source.ts"] =
        "changed";
    },
    (reports: ReturnType<typeof evidence>) => {
      const row = defined(
        reports
          .flatMap((r) => r.results)
          .find((r) => r.command[0] === "verify"),
      );
      row.command.splice(row.command.indexOf("Safe"), 1);
    },
    (reports: ReturnType<typeof evidence>) => {
      const row = defined(
        reports.flatMap((r) => r.results).find((r) => r.exitCode === 1),
      );
      row.observedTemporalOutcome = "holds";
    },
  ]) {
    const reports = evidence(directory);
    mutate(reports);
    assert.throws(() => validateQuintShardReports(directory, reports, 4));
  }
});

test("the real runner emits an exhaustive union across four shards", {
  timeout: 240_000,
}, async () => {
  const directory = fixture();
  mkdirSync(path.join(directory, "packages/scripts/quint"), {
    recursive: true,
  });
  writeFileSync(
    path.join(directory, "packages/scripts/quint/tlc.json"),
    '{"maxHeap":"-Xmx1G","stackSize":"-Xss8m","workers":2}',
  );
  const reports: unknown[] = [];
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    const base = `packages/example/quint/${name}`;
    writeFileSync(
      path.join(directory, `${base}.qnt`),
      `module ${name} {
      var state: bool
      action init = state' = false
      action step = state' = not(state)
      val Safe = state == false or state == true
      run scenarioTest = init.then(step).expect(state)
    }`,
    );
    writeFileSync(
      path.join(directory, `${base}.cases.json`),
      JSON.stringify({
        sources: ["packages/example/quint/source.ts"],
        conformance: "packages/example/quint/conformance.mjs",
        cases: [
          {
            name: "bounded",
            main: name,
            init: "init",
            step: "step",
            invariants: ["Safe"],
            temporal: [],
            maxSteps: 10,
            samples: 20,
          },
        ],
      }),
    );
  }
  for (let index = 1; index <= 4; index++) {
    const output = path.join(directory, "test-results", `shard-${index}`);
    await main([`--shard=${index}/4`], directory, output);
    reports.push(
      JSON.parse(readFileSync(path.join(output, "verification.json"), "utf8")),
    );
  }
  const summary = validateQuintShardReports(directory, reports, 4);
  assert.equal(summary.models, 3);
  assert.equal(summary.commands, 12);
  assert.equal(summary.cases, 3);
});
