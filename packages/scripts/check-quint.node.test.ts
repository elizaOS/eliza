import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const coveredEntry = {
  id: "example",
  model: `${example}.qnt`,
  sources: [stateSource],
  invariants: ["Safe"],
  status: "modeled",
  limitations: [],
};

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
