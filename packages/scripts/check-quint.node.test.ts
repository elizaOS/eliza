import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyTemporalOutcome,
  createQuintInventory,
  loadQuintModels,
  main,
  quintRepositoryFingerprint,
  requireQuintRepositoryFingerprint,
  selectQuintModels,
} from "./check-quint.ts";
import { testOutputPath } from "./lib/test-output.ts";

const directories: string[] = [];
const modelCase = {
  name: "bounded",
  main: "Example",
  init: "init",
  step: "step",
  invariants: ["Safe"],
  temporal: [],
  maxSteps: 20,
  samples: 100,
};

function fixture(files: Record<string, string>): string {
  mkdirSync(testOutputPath("quint-runner-tests"), { recursive: true });
  const directory = mkdtempSync(
    testOutputPath("quint-runner-tests", "repository-"),
  );
  directories.push(directory);
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Quint test",
      "-c",
      "user.email=quint-test@example.invalid",
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
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an untracked specification must have checked cases", () => {
  const directory = fixture({ "packages/example/quint/Example.qnt": "" });
  assert.throws(() => loadQuintModels(directory), /no checked cases/);
});

test("missing source links and duplicate cases fail closed", () => {
  const base = "packages/example/quint/Example";
  const directory = fixture({
    [`${base}.qnt`]: "",
    "packages/example/src/state.ts": "",
    [`${base}.cases.json`]: JSON.stringify({
      sources: ["packages/example/src/missing.ts"],
      cases: [modelCase],
    }),
  });
  assert.throws(() => loadQuintModels(directory), /source does not exist/);
  writeFileSync(
    path.join(directory, `${base}.cases.json`),
    JSON.stringify({
      sources: ["packages/example/src/state.ts"],
      cases: [modelCase, modelCase],
    }),
  );
  assert.throws(() => loadQuintModels(directory), /Duplicate Quint case/);
});

test("model selection rejects typos even beside a valid selection", () => {
  const base = "packages/example/quint/Example";
  const directory = fixture({
    [`${base}.qnt`]: "",
    "packages/example/src/state.ts": "",
    [`${base}.cases.json`]: JSON.stringify({
      sources: ["packages/example/src/state.ts"],
      cases: [modelCase],
    }),
  });
  const models = loadQuintModels(directory);
  assert.deepEqual(
    selectQuintModels(models, ["packages/example/quint"]),
    models,
  );
  assert.throws(
    () => selectQuintModels(models, ["Example", "Exmaple"]),
    /Unknown Quint specification: Exmaple/,
  );
});

test("required deadlock checks cannot be dropped from a case", () => {
  const base = "packages/example/quint/Example";
  const directory = fixture({
    [`${base}.qnt`]: "",
    "packages/example/src/state.ts": "",
    [`${base}.cases.json`]: JSON.stringify({
      sources: ["packages/example/src/state.ts"],
      cases: [{ ...modelCase, deadlock: true }],
    }),
  });
  assert.throws(() => loadQuintModels(directory), /Missing DeadlockFree/);
});

test("temporal properties require explicit matching expectations and assumptions", () => {
  const base = "packages/example/quint/Example";
  const directory = fixture({
    [`${base}.qnt`]: "",
    "source.ts": "",
    [`${base}.cases.json`]: "{}",
  });
  const temporal = {
    property: "Progress",
    expect: "holds",
    assumptions: ["Fair clock"],
  };
  for (const item of [
    { ...modelCase, temporal: ["Progress"] },
    { ...modelCase, temporal: ["Progress"], temporalChecks: [] },
    {
      ...modelCase,
      temporal: ["Progress"],
      temporalChecks: [{ ...temporal, assumptions: [] }],
    },
    {
      ...modelCase,
      temporal: ["Progress"],
      temporalChecks: [{ property: "Progress", assumptions: ["Fair clock"] }],
    },
    {
      ...modelCase,
      temporal: ["Progress"],
      temporalChecks: [{ ...temporal, property: "Other" }],
    },
    {
      ...modelCase,
      temporal: ["Progress"],
      temporalChecks: [temporal, temporal],
    },
  ]) {
    writeFileSync(
      path.join(directory, `${base}.cases.json`),
      JSON.stringify({ sources: ["source.ts"], cases: [item] }),
    );
    assert.throws(() => loadQuintModels(directory));
  }
});

test("arbitrary failures cannot satisfy expected temporal counterexamples", () => {
  assert.equal(
    classifyTemporalOutcome(1, "error: found a counterexample"),
    "checker-error",
  );
  assert.equal(
    classifyTemporalOutcome(
      null,
      "Temporal property q_temporalProps was violated",
      "ETIMEDOUT",
    ),
    "checker-error",
  );
  assert.equal(
    classifyTemporalOutcome(
      0,
      "Model checking completed. No error has been found.",
    ),
    "checker-error",
  );
});

const example = "packages/example/quint/Example";
const stateSource = "packages/example/src/state.ts";
const helperSource = "packages/example/src/helper.ts";
const checkedFiles = {
  ".gitignore": "test-results/\n",
  [`${example}.qnt`]: `module Example {
    var state: int
    action init = state' = 0
    action step = state' = if (state == 0) 1 else 0
    val Safe = state == 0 or state == 1
  }`,
  [stateSource]: "export const status = 'ready';\n",
  [helperSource]: "export const helper = 1;\n",
  [`${example}.cases.json`]: JSON.stringify({
    sources: [stateSource],
    bounds: "One boolean state",
    cases: [{ ...modelCase, constants: { stateCount: 2 } }],
  }),
};

test("the shared runner records positive liveness and expected unfair schedules separately", async () => {
  const directory = fixture({
    ...checkedFiles,
    "packages/scripts/quint/tlc.json":
      '{"maxHeap":"-Xmx1G","stackSize":"-Xss8m","workers":2}',
    [`${example}.qnt`]: `module Example {
      var state: int
      action init = state' = 0
      action advance = all { state == 0, state' = 1 }
      action step = any { advance, state' = state }
      val Safe = state == 0 or state == 1
      temporal UnfairProgress = eventually(state == 1)
      temporal FairProgress = advance.weakFair(state) implies eventually(state == 1)
      temporal FairSinks = advance.weakFair(state) implies eventually(always(state == 1))
      temporal StableOnceReached = always((state == 1 implies next(state) == 1).orKeep(state))
    }`,
    [`${example}.cases.json`]: JSON.stringify({
      sources: [stateSource],
      cases: [
        {
          ...modelCase,
          temporal: ["UnfairProgress", "FairProgress", "FairSinks"],
          temporalChecks: [
            {
              property: "UnfairProgress",
              expect: "counterexample",
              assumptions: ["No scheduler fairness"],
            },
            {
              property: "FairProgress",
              expect: "holds",
              assumptions: ["advance is weakly fair relative to state"],
            },
            {
              property: "FairSinks",
              expect: "holds",
              assumptions: [
                "advance is weakly fair relative to state; state 1 is terminal",
              ],
            },
          ],
        },
        {
          ...modelCase,
          name: "transition-safety",
          temporal: ["StableOnceReached"],
          temporalChecks: [
            {
              property: "StableOnceReached",
              expect: "holds",
              assumptions: ["No scheduler fairness"],
            },
          ],
        },
      ],
    }),
  });
  const output = path.join(directory, "test-results/quint");
  await main([], directory, output);
  const report = JSON.parse(
    readFileSync(path.join(output, "verification.json"), "utf8"),
  );
  assert.equal(report.completed, true);
  const temporal = report.results.filter(
    (item: { temporalProperties?: string[] }) =>
      item.temporalProperties?.length,
  );
  assert.deepEqual(
    temporal.map(
      (item: { observedTemporalOutcome: string }) =>
        item.observedTemporalOutcome,
    ),
    ["holds", "counterexample", "holds"],
  );
  assert.deepEqual(temporal[0].temporalProperties, [
    "FairProgress",
    "FairSinks",
  ]);
  assert.deepEqual(temporal[2].temporalProperties, ["StableOnceReached"]);
  assert.doesNotMatch(
    readFileSync(path.join(output, temporal[2].log), "utf8"),
    /Checking (?:\d+ branches of )?temporal properties/,
  );
  assert(
    temporal.every(
      (item: { matchedExpectation: boolean; temporalAssumptions: string[] }) =>
        item.matchedExpectation && item.temporalAssumptions.length > 0,
    ),
  );
  assert.equal(
    new Set(report.results.map((item: { log: string }) => item.log)).size,
    report.results.length,
  );
});

test("TLC state and action properties retain their checked outcomes", async () => {
  const directory = fixture({
    ...checkedFiles,
    "packages/scripts/quint/tlc.json":
      '{"maxHeap":"-Xmx512M","stackSize":"-Xss8m","workers":2}',
    [`${example}.qnt`]: `module Example {
      var state: int
      action init = state' = 0
      action step = state' = 1
      val Safe = state == 0 or state == 1
      temporal StateProperty = always(state == 0 or state == 1)
      temporal ActionProperty = always((next(state) >= state).orKeep(state))
      temporal ViolatedProperty = always(state == 0)
    }`,
    [`${example}.cases.json`]: JSON.stringify({
      sources: [stateSource],
      cases: [
        {
          ...modelCase,
          name: "state-and-action-properties",
          temporal: ["StateProperty", "ActionProperty"],
          temporalChecks: ["StateProperty", "ActionProperty"].map(
            (property) => ({
              property,
              expect: "holds",
              assumptions: [
                "No fairness is required for these safety properties",
              ],
            }),
          ),
        },
        {
          ...modelCase,
          name: "violated-state-property",
          temporal: ["ViolatedProperty"],
          temporalChecks: [
            {
              property: "ViolatedProperty",
              expect: "holds",
              assumptions: [
                "Intentionally false safety property exercises the checker result",
              ],
            },
          ],
        },
      ],
    }),
  });
  const output = path.join(directory, "test-results/quint");
  await assert.rejects(main([], directory, output), /Quint checks failed/);
  const report = JSON.parse(
    readFileSync(path.join(output, "verification.json"), "utf8"),
  );
  const positive = report.results.find(
    (item: { key: string; command: string[] }) =>
      item.key.endsWith("#state-and-action-properties") &&
      item.command[0] === "verify",
  );
  const negative = report.results.find(
    (item: { key: string; command: string[] }) =>
      item.key.endsWith("#violated-state-property") &&
      item.command[0] === "verify",
  );
  assert.equal(positive.exitCode, 0);
  assert.equal(positive.matchedExpectation, true);
  assert.equal(positive.observedTemporalOutcome, "holds");
  const log = readFileSync(path.join(output, positive.log), "utf8");
  assert.doesNotMatch(log, /Checking (?:\d+ branches of )?temporal properties/);
  assert.match(log, /Model checking completed\. No error has been found\./);
  assert.notEqual(negative.exitCode, 0);
  assert.equal(negative.matchedExpectation, false);
  assert.equal(negative.observedTemporalOutcome, "checker-error");
  assert.equal(report.completed, false);
});

test("a missing temporal definition fails the shared runner rather than becoming a negative success", async () => {
  const directory = fixture({
    ...checkedFiles,
    "packages/scripts/quint/tlc.json":
      '{"maxHeap":"-Xmx1G","stackSize":"-Xss8m","workers":2}',
    [`${example}.cases.json`]: JSON.stringify({
      sources: [stateSource],
      cases: [
        {
          ...modelCase,
          temporal: ["Missing"],
          temporalChecks: [
            {
              property: "Missing",
              expect: "counterexample",
              assumptions: ["No assumptions"],
            },
          ],
        },
      ],
    }),
  });
  const output = path.join(directory, "test-results/quint");
  await assert.rejects(main([], directory, output), /Quint checks failed/);
  const report = JSON.parse(
    readFileSync(path.join(output, "verification.json"), "utf8"),
  );
  assert.equal(report.completed, false);
  assert.equal(report.results.at(-1).observedTemporalOutcome, "checker-error");
});

test("an implementation conformance failure fails the shared run", async () => {
  const conformance = "packages/example/quint/check.mjs";
  const directory = fixture({
    ...checkedFiles,
    [conformance]: "process.exitCode = 17;\n",
    [`${example}.cases.json`]: JSON.stringify({
      sources: [stateSource, conformance],
      cases: [modelCase],
      conformance,
    }),
  });
  const output = path.join(directory, "test-results/quint");
  await assert.rejects(
    main(["--simulate"], directory, output),
    /Quint checks failed/,
  );
  const report = JSON.parse(
    readFileSync(path.join(output, "simulation.json"), "utf8"),
  );
  assert.equal(report.completed, false);
  assert.equal(report.results.at(-1).command[0], "conformance");
  assert.equal(report.results.at(-1).exitCode, 17);
  assert.equal(report.results.at(-1).matchedExpectation, false);
});

const coveredEntry = {
  id: "example",
  model: `${example}.qnt`,
  sources: [stateSource],
  invariants: ["Safe"],
  status: "modeled",
  limitations: [],
};

test("inventory includes native, ESM, shell and database state owners", () => {
  const nativeSources = {
    "plugins/native/src/Journal.java": "enum InstallPhase { IDLE, RUNNING }",
    "packages/native/owner.go": "type OwnerState struct { Running bool }",
    "packages/host/queue.mjs": "let phase = 'waiting';",
    "packages/native/lease.cc": "enum class LeaseState { idle, owned };",
    "packages/native/schema.sql": "CREATE TABLE requests (status TEXT);",
    "packages/native/owner.sh": "state=waiting",
  };
  const directory = fixture({
    ...checkedFiles,
    ...nativeSources,
    "plugins/native/test/Journal.java": "enum InstallPhase { IDLE }",
  });
  const inventory = createQuintInventory(directory, loadQuintModels(directory));
  const discovered = inventory.candidates.map((candidate) => candidate.file);
  for (const file of Object.keys(nativeSources))
    assert(discovered.includes(file));
  assert(!discovered.includes("plugins/native/test/Journal.java"));
});

test("the completeness gate separates ownerless reviews from unchecked state and declared gaps", async () => {
  const source = "packages/example/src/contracts.ts";
  const contents = 'export type ExampleState = "ready" | "closed";\n';
  const review = {
    source,
    sha256: createHash("sha256").update(contents).digest("hex"),
    reason: "Declares the status sent by the example service.",
  };
  const reviewFile = "packages/example/quint/ownerless-sources.json";
  const directory = fixture({ ...checkedFiles, [source]: contents });
  const output = path.join(directory, "test-results/quint");
  const args = ["--inventory", "--require-complete"];

  await assert.rejects(
    main(args, directory, output),
    /1 unreviewed source candidates/,
  );
  writeFileSync(path.join(directory, reviewFile), JSON.stringify([review]));
  await main(args, directory, output);
  const inventory = JSON.parse(
    readFileSync(path.join(output, "inventory.json"), "utf8"),
  );
  assert.equal(inventory.unreferencedCandidates, 1);
  assert.equal(inventory.unreviewedCandidates, 0);
  assert.deepEqual(inventory.ownerlessSources, [review]);

  const uncheckedSource = path.join(directory, "packages/example/src/queue.ts");
  writeFileSync(uncheckedSource, 'let status = "waiting";\n');
  await assert.rejects(
    main(args, directory, output),
    /1 unreviewed source candidates/,
  );
  rmSync(uncheckedSource);
  const coveragePath = path.join(
    directory,
    "packages/example/quint/coverage.json",
  );
  writeFileSync(
    coveragePath,
    JSON.stringify([{ ...coveredEntry, status: "partial" }]),
  );
  await assert.rejects(
    main(args, directory, output),
    /0 unreviewed source candidates and 1 declared gaps/,
  );
  writeFileSync(
    coveragePath,
    JSON.stringify([
      {
        ...coveredEntry,
        model: null,
        invariants: [],
        status: "unmodeled",
        sources: [`./${source}`],
      },
    ]),
  );
  await assert.rejects(
    main(args, directory, output),
    /conflicts with a model or coverage entry/,
  );
});

test("an ownerless review must match one current candidate with no checked model", () => {
  const source = "packages/example/src/contracts.ts";
  const contents = 'export type ExampleState = "ready";\n';
  const review = {
    source,
    sha256: createHash("sha256").update(contents).digest("hex"),
    reason: "Declares the status sent by the example service.",
  };
  const reviewFile = "packages/example/quint/ownerless-sources.json";
  const directory = fixture({
    ...checkedFiles,
    [source]: contents,
    [reviewFile]: JSON.stringify([review, review]),
  });
  const check = () =>
    createQuintInventory(directory, loadQuintModels(directory));
  assert.throws(check, /Duplicate Quint ownerless source review/);
  writeFileSync(path.join(directory, reviewFile), JSON.stringify([review]));
  writeFileSync(
    path.join(directory, source),
    contents.replace("ready", "closed"),
  );
  assert.throws(check, /Stale Quint ownerless source review/);
  rmSync(path.join(directory, source));
  assert.throws(check, /Quint ownerless source is not an inventory candidate/);

  writeFileSync(path.join(directory, source), contents);
  writeFileSync(
    path.join(directory, `${example}.cases.json`),
    JSON.stringify({ sources: [stateSource, source], cases: [modelCase] }),
  );
  assert.throws(check, /conflicts with a model or coverage entry/);
});

test("the repository fingerprint binds tracked and untracked helper contents", () => {
  const directory = fixture(checkedFiles);
  const original = quintRepositoryFingerprint(directory);
  writeFileSync(
    path.join(directory, helperSource),
    "export const helper = 2;\n",
  );
  assert.throws(
    () => requireQuintRepositoryFingerprint(directory, original),
    /Repository changed/,
  );
  execFileSync("git", ["add", helperSource], { cwd: directory });
  const staged = quintRepositoryFingerprint(directory);
  writeFileSync(
    path.join(directory, helperSource),
    "export const helper = 3;\n",
  );
  assert.throws(
    () => requireQuintRepositoryFingerprint(directory, staged),
    /Repository changed/,
  );
});

test("manifest changes after loading invalidate the original snapshot", () => {
  const directory = fixture(checkedFiles);
  const original = quintRepositoryFingerprint(directory);
  const models = loadQuintModels(directory);
  writeFileSync(
    path.join(directory, `${example}.cases.json`),
    JSON.stringify({
      sources: [stateSource],
      cases: [{ ...modelCase, invariants: ["DifferentProperty"] }],
    }),
  );
  assert.deepEqual(models[0].cases[0].invariants, ["Safe"]);
  assert.throws(
    () => requireQuintRepositoryFingerprint(directory, original),
    /Repository changed/,
  );
});

test("new imported helper files change the run snapshot", () => {
  const directory = fixture(checkedFiles);
  const original = quintRepositoryFingerprint(directory);
  writeFileSync(
    path.join(directory, "packages/example/quint/Helper.qnt"),
    "module Helper {}\n",
  );
  assert.throws(
    () => requireQuintRepositoryFingerprint(directory, original),
    /Repository changed/,
  );
});

test("ignored reports and the generated compiler directory do not change the snapshot", () => {
  const directory = fixture(checkedFiles);
  const original = quintRepositoryFingerprint(directory);
  for (const file of [
    "test-results/generated.tla",
    "_apalache-out/generated.tla",
  ]) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "generated compiler output\n");
  }
  requireQuintRepositoryFingerprint(directory, original);
  assert.equal(loadQuintModels(directory).length, 1);
});

test("maintained TLA+ and PlusCal inputs are rejected even when untracked", () => {
  for (const file of ["Legacy.tla", "Legacy.pcal", "Legacy.TLA"]) {
    const directory = fixture({
      ...checkedFiles,
      [`packages/example/${file}`]: "legacy",
    });
    assert.throws(
      () => loadQuintModels(directory),
      /Maintained formal models must use Quint/,
    );
  }
});

test("coverage claims must name checked invariants and linked implementation sources", () => {
  const coverageFile = "packages/example/quint/coverage.json";
  const directory = fixture({
    ...checkedFiles,
    [coverageFile]: JSON.stringify([
      { ...coveredEntry, invariants: ["Unchecked"] },
    ]),
  });
  const models = loadQuintModels(directory);
  assert.throws(
    () => createQuintInventory(directory, models),
    /claims unchecked invariant: Unchecked/,
  );
  writeFileSync(
    path.join(directory, coverageFile),
    JSON.stringify([{ ...coveredEntry, sources: [helperSource] }]),
  );
  assert.throws(
    () => createQuintInventory(directory, models),
    /claims an unlinked source/,
  );
  writeFileSync(
    path.join(directory, coverageFile),
    JSON.stringify([{ ...coveredEntry, sources: [`./${stateSource}`] }]),
  );
  assert.equal(createQuintInventory(directory, models).declaredGaps, 0);
});

test("partial coverage cannot claim a property without its checked model", () => {
  const directory = fixture({
    ...checkedFiles,
    "packages/example/quint/coverage.json": JSON.stringify([
      { ...coveredEntry, model: null, status: "partial" },
    ]),
  });
  assert.throws(
    () => createQuintInventory(directory, loadQuintModels(directory)),
    /claims unchecked invariant/,
  );
});

test("the normal simulation entry point records one unchanged snapshot", async () => {
  const directory = fixture(checkedFiles);
  const output = path.join(directory, "test-results/quint");
  const fingerprint = quintRepositoryFingerprint(directory);
  await main(["--simulate"], directory, output);
  const report = JSON.parse(
    readFileSync(path.join(output, "simulation.json"), "utf8"),
  );
  assert.equal(report.completed, true);
  assert.equal(report.repositorySha256, fingerprint);
  assert.equal(report.results.length, 3);
  assert.equal(report.results[0].bounds, "One boolean state");
  assert.deepEqual(report.results[0].configuration.constants, {
    stateCount: 2,
  });
  assert(
    report.results.every(
      (result: { repositorySha256After: string; repositoryChanged: boolean }) =>
        result.repositorySha256After === fingerprint &&
        !result.repositoryChanged,
    ),
  );
  const simulationReceipt = readFileSync(path.join(output, "simulation.json"));
  const verificationReceipt =
    '{"completed":true,"previousVerification":true}\n';
  writeFileSync(path.join(output, "verification.json"), verificationReceipt);
  for (const args of [["--inventory"], ["--inventory", "--simulate"]]) {
    await main(args, directory, output);
    assert.equal(
      readFileSync(path.join(output, "verification.json"), "utf8"),
      verificationReceipt,
    );
    assert.deepEqual(
      readFileSync(path.join(output, "simulation.json")),
      simulationReceipt,
    );
  }
});

test("the normal entry point rejects an unlisted dependency changed during conformance", async () => {
  const conformance = "packages/example/quint/conformance.mjs";
  const directory = fixture({
    ...checkedFiles,
    [conformance]: `import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('../src/helper.ts', import.meta.url), 'export const helper = 9;\\n');`,
    [`${example}.cases.json`]: JSON.stringify({
      sources: [stateSource],
      conformance,
      cases: [modelCase],
    }),
  });
  const output = path.join(directory, "test-results/quint");
  await assert.rejects(
    main(["--simulate"], directory, output),
    /Repository changed during .*conformance/,
  );
  const report = JSON.parse(
    readFileSync(path.join(output, "simulation.json"), "utf8"),
  );
  assert.equal(report.completed, false);
  assert.equal(report.results.at(-1).repositoryChanged, true);
  assert.equal(report.results.at(-1).exitCode, 0);
});

test("child cancellation stops later cases and remains visible in evidence", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const conformance = "packages/example/quint/conformance.mjs";
    const later = "packages/example/quint/Later";
    const directory = fixture({
      ...checkedFiles,
      [conformance]: `process.kill(process.pid, '${signal}');`,
      [`${example}.cases.json`]: JSON.stringify({
        sources: [stateSource],
        conformance,
        cases: [modelCase],
      }),
      [`${later}.qnt`]: checkedFiles[`${example}.qnt`],
      [`${later}.cases.json`]: checkedFiles[`${example}.cases.json`],
    });
    const output = path.join(directory, "test-results/quint");
    await assert.rejects(main(["--simulate"], directory, output), {
      name: "AbortError",
      message: `Quint verification cancelled by ${signal}`,
    });
    const report = JSON.parse(
      readFileSync(path.join(output, "simulation.json"), "utf8"),
    );
    assert.equal(report.completed, false);
    assert.equal(report.results.at(-1).signal, signal);
    assert.equal(report.results.length, 4);
    assert.equal(report.repositorySha256, report.observedRepositorySha256);
  }
});

test("cached case settings cannot be certified after a conformance mutation", async () => {
  const conformance = "packages/example/quint/conformance.mjs";
  const changedManifest = JSON.stringify({
    sources: [stateSource],
    cases: [{ ...modelCase, invariants: ["DifferentProperty"] }],
  });
  const directory = fixture({
    ...checkedFiles,
    [conformance]: `import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./Example.cases.json', import.meta.url), ${JSON.stringify(changedManifest)});`,
    [`${example}.cases.json`]: JSON.stringify({
      sources: [stateSource],
      conformance,
      cases: [modelCase],
    }),
  });
  const output = path.join(directory, "test-results/quint");
  await assert.rejects(
    main(["--simulate"], directory, output),
    /Repository changed during .*conformance/,
  );
  const report = JSON.parse(
    readFileSync(path.join(output, "simulation.json"), "utf8"),
  );
  assert.equal(report.completed, false);
  assert.notEqual(report.repositorySha256, report.observedRepositorySha256);
  assert.equal(report.results.at(-1).repositoryChanged, true);
});

test("CLI cancellation reaps checker descendants and retains incomplete evidence", {
  timeout: 90_000,
}, async () => {
  const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 30_000;
    while (!ready()) {
      assert(Date.now() < deadline, "timed out waiting for process evidence");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const running = (pid: number) => {
    try {
      if (process.platform !== "linux") {
        process.kill(pid, 0);
        return true;
      }
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return (
        stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
      );
    } catch (error) {
      if (
        ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return false;
      throw error;
    }
  };
  const signals =
    process.platform === "win32"
      ? (["SIGTERM"] as const)
      : (["SIGINT", "SIGTERM"] as const);
  for (const signal of signals) {
    const conformance = "packages/example/quint/conformance.mjs";
    const directory = fixture({
      ...checkedFiles,
      ".gitignore": "test-results/\nnode_modules\n",
      [`${example}.cases.json`]: JSON.stringify({
        sources: [stateSource],
        conformance,
        cases: [modelCase],
      }),
      "packages/scripts/check-quint.ts": readFileSync(
        path.join(scriptRoot, "check-quint.ts"),
        "utf8",
      ),
      "packages/scripts/run-with-deadline.ts": readFileSync(
        path.join(scriptRoot, "run-with-deadline.ts"),
        "utf8",
      ),
      "packages/scripts/lib/test-output.ts": readFileSync(
        path.join(scriptRoot, "lib/test-output.ts"),
        "utf8",
      ),
      "packages/scripts/lib/quint-shards.ts": readFileSync(
        path.join(scriptRoot, "lib/quint-shards.ts"),
        "utf8",
      ),
      [conformance]: `import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0)); require('node:fs').writeFileSync('test-results/ready-child', String(process.pid)); setInterval(() => {}, 1000);"]);
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
const timer = setInterval(() => {
  if (existsSync('test-results/ready-child')) {
    writeFileSync('test-results/ready-parent', String(process.pid));
    clearInterval(timer);
  }
}, 10);
setInterval(() => {}, 1000);`,
    });
    symlinkSync(
      path.resolve(scriptRoot, "../../node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    const child = spawn(
      process.execPath,
      [path.join(directory, "packages/scripts/check-quint.ts"), "--simulate"],
      {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let childOutput = "";
    child.stdout?.on("data", (chunk) => {
      childOutput += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      childOutput += chunk;
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const evidence = path.join(directory, "test-results");
    const pids: number[] = [];
    try {
      await waitFor(() => {
        try {
          return (
            Number(readFileSync(path.join(evidence, "ready-parent"), "utf8")) >
            0
          );
        } catch {
          return false;
        }
      });
      for (const file of ["ready-parent", "ready-child"])
        pids.push(Number(readFileSync(path.join(evidence, file), "utf8")));
      child.kill(signal);
      const result = await closed;
      assert(
        result.code === (signal === "SIGINT" ? 130 : 143) ||
          result.signal === signal,
      );
      assert.deepEqual(
        pids.filter(running),
        [],
        "checker descendants survived cancellation",
      );
      const report = JSON.parse(
        readFileSync(path.join(evidence, "quint/simulation.json"), "utf8"),
      );
      assert.equal(report.completed, false);
    } catch (error) {
      throw new Error(`${String(error)}\n${childOutput}`, { cause: error });
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      child.kill("SIGKILL");
      await closed;
    }
  }
});
