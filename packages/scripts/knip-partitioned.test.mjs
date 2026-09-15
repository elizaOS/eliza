/**
 * Proves the partitioned Knip command with real subprocesses and a deterministic fake Knip executable.
 *
 * The fixture exercises target discovery, configuration composition, inventory
 * stability, advisory/strict policy, and every infrastructure failure class.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(
  new URL("./knip-partitioned.mjs", import.meta.url),
);
const REAL_KNIP = fileURLToPath(
  new URL("../../node_modules/knip/bin/knip.js", import.meta.url),
);
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

function fixture(modes = {}, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "knip-partitioned-"));
  roots.push(root);
  const workspaces = ["packages/*"];
  writeJson(path.join(root, "package.json"), {
    name: "fixture-root",
    private: true,
    workspaces,
  });
  writeJson(path.join(root, "knip.json"), {
    entry: ["global-entry.ts"],
    ignore: ["**/dist/**"],
    ignoreDependencies: ["global-dynamic-package"],
    workspaces: {
      "packages/alpha": {
        entry: ["root-public-entry.ts"],
        ignoreDependencies: ["root-dynamic-package"],
      },
      ...(options.duplicateNested
        ? { "packages/alpha/": { entry: ["duplicate.ts"] } }
        : {}),
      "plugins/plugin-local-inference/native": {
        entry: ["scripts/**/*.mjs", "package.json"],
      },
      "plugins/plugin-tailscale": {
        entry: ["src/index.ts"],
      },
    },
  });
  const fixtureWorkspaces = [
    "packages/zeta",
    "packages/alpha",
    "plugins/plugin-local-inference/native",
    ...(options.manyDependents
      ? Array.from({ length: 17 }, (_, index) => `packages/consumer-${index}`)
      : []),
  ];
  for (const workspace of fixtureWorkspaces) {
    writeJson(path.join(root, workspace, "package.json"), {
      name: workspace.replaceAll("/", "-"),
      private: true,
      fakeKnipMode: modes[workspace] ?? "clean",
      ...(workspace === "packages/alpha"
        ? { scripts: { typecheck: "tsc --noEmit -p tsconfig.build.json" } }
        : {}),
      ...(workspace.startsWith("packages/consumer-")
        ? { dependencies: { "packages-alpha": "workspace:*" } }
        : {}),
    });
    if (workspace.startsWith("packages/consumer-")) {
      writeText(
        path.join(root, workspace, "src/index.ts"),
        'import "../../alpha/src/lib";\n',
      );
    }
  }
  writeJson(path.join(root, "packages/alpha/tsconfig.build.json"), {
    compilerOptions: { strict: true },
  });
  writeJson(path.join(root, "packages/alpha/knip.json"), {
    entry: ["local-public-entry.ts"],
    ignoreDependencies: ["local-dynamic-package"],
  });
  const fakeKnip = path.join(root, "fake-knip.mjs");
  writeFileSync(
    fakeKnip,
    `import { readFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const directory = args[args.indexOf("--directory") + 1];
const configFile = args[args.indexOf("--config") + 1];
const workspaceIndex = args.indexOf("--workspace");
const target = workspaceIndex === -1 ? "." : args[workspaceIndex + 1];
const manifest = JSON.parse(readFileSync(path.join(directory, target, "package.json"), "utf8"));
const mode = manifest.fakeKnipMode;
if (mode === "missing") process.exit(0);
if (mode === "malformed") { process.stdout.write("{not-json\\n"); process.exit(0); }
if (mode === "stale-check") {
  const reportsDir = path.dirname(path.dirname(configFile));
  const run = JSON.parse(readFileSync(path.join(reportsDir, "run.json"), "utf8"));
  let aggregateExists = true;
  try { readFileSync(path.join(reportsDir, "aggregate.json")); } catch { aggregateExists = false; }
  process.stderr.write(JSON.stringify({ observedStatus: run.status, aggregateExists }) + "\\n");
  process.exit(7);
}
const contract = JSON.stringify({ dotenvQuiet: process.env.DOTENV_CONFIG_QUIET, hasStrictArg: args.includes("--strict"), nodeOptions: process.env.NODE_OPTIONS, tsConfig: args.includes("--tsConfig") ? path.relative(directory, args[args.indexOf("--tsConfig") + 1]).replaceAll("\\\\", "/") : null });
const selected = args.flatMap((arg, index) => arg === "--workspace" ? [args[index + 1]] : []);
const intersectionExports = selected.includes("packages/consumer-0") ? [{ name: "trulyUnused" }] : [{ name: "consumedElsewhere" }, { name: "trulyUnused" }];
const shardCycles = selected.includes("packages/consumer-0") ? [[{ name: "cycleOnlyOneShard" }]] : [];
const report = mode === "intersection" ? { issues: [{ file: target + "/src/index.ts", exports: intersectionExports, cycles: shardCycles }] } : mode === "future" ? { issues: [{ file: target + "/src/index.ts", futureIssues: [{ name: "new" }] }] } : mode === "finding" ? { issues: [{ file: target + "/src/index.ts", exports: [{ name: contract }] }] } : { issues: [] };
process.stdout.write(JSON.stringify(report) + "\\n");
if (mode === "nonzero") process.exit(7);
if (mode === "abort") process.kill(process.pid, "SIGABRT");
if (mode === "oom") { process.stderr.write("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\\n"); process.kill(process.pid, "SIGABRT"); }
`,
    "utf8",
  );
  return { root, fakeKnip };
}

function run({ root, fakeKnip }, extra = [], reportName = "reports/knip") {
  return spawnSync(
    process.execPath,
    [
      RUNNER,
      "--repo-root",
      root,
      "--reports-dir",
      reportName,
      "--knip-bin",
      fakeKnip,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

function readReport(root, reportName, file) {
  return JSON.parse(readFileSync(path.join(root, reportName, file), "utf8"));
}

test("discovers each workspace once, composes config, and keeps aggregate stable", () => {
  const value = fixture({ "packages/alpha": "finding" });
  const first = run(value, [], "reports/first");
  assert.equal(first.status, 0, first.stderr);
  const aggregate = readReport(value.root, "reports/first", "aggregate.json");
  assert.deepEqual(
    aggregate.ledger.map(({ workspace }) => workspace),
    [
      "packages/alpha",
      "packages/zeta",
      "plugins/plugin-local-inference/native",
    ],
  );
  assert.equal(
    new Set(aggregate.ledger.map(({ workspace }) => workspace)).size,
    3,
  );
  assert.equal(
    aggregate.ledger.some(
      ({ workspace }) => workspace === "plugins/plugin-tailscale",
    ),
    false,
  );
  assert.equal(aggregate.findingCount, 1);
  assert.deepEqual(JSON.parse(aggregate.findings[0].finding.name), {
    dotenvQuiet: "true",
    hasStrictArg: false,
    nodeOptions: "--max-old-space-size=4096",
    tsConfig: "packages/alpha/tsconfig.build.json",
  });
  const alphaConfig = readReport(
    value.root,
    "reports/first",
    "configs/packages--alpha--shard-000.json",
  );
  assert.deepEqual(alphaConfig.entry, ["global-entry.ts"]);
  assert.deepEqual(alphaConfig.workspaces["packages/alpha"].entry, [
    "root-public-entry.ts",
    "local-public-entry.ts",
  ]);
  assert.deepEqual(alphaConfig.ignoreDependencies, ["global-dynamic-package"]);
  assert.deepEqual(
    alphaConfig.workspaces["packages/alpha"].ignoreDependencies,
    ["root-dynamic-package", "local-dynamic-package"],
  );
  assert.equal("plugins/plugin-tailscale" in alphaConfig.workspaces, false);

  const second = run(value, [], "reports/second");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    readFileSync(path.join(value.root, "reports/first/aggregate.json"), "utf8"),
    readFileSync(
      path.join(value.root, "reports/second/aggregate.json"),
      "utf8",
    ),
  );

  const strict = run(value, ["--strict"], "reports/strict");
  assert.equal(strict.status, 1);
  assert.deepEqual(
    readReport(value.root, "reports/strict", "aggregate.json").findings,
    aggregate.findings,
  );
  const strictRun = readReport(value.root, "reports/strict", "run.json");
  assert.equal(strictRun.infrastructureFailed, false);
  assert.equal(strictRun.strictFindingFailure, true);
});

test("duplicate targets fail before partial audit output", () => {
  const value = fixture({}, { duplicateNested: true });
  const result = run(value);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate root Knip workspace identity/);
});

test("stale green artifacts are invalidated before the first partition runs", () => {
  const value = fixture({ "packages/alpha": "stale-check" });
  writeJson(path.join(value.root, "reports/knip/run.json"), {
    status: "completed",
  });
  writeJson(path.join(value.root, "reports/knip/aggregate.json"), {
    staleGreen: true,
  });
  const result = run(value);
  assert.equal(result.status, 1);
  const report = readReport(value.root, "reports/knip", "run.json");
  assert.equal(report.status, "failed");
  assert.match(
    report.executions[0].shards[0].stderr,
    /"observedStatus":"incomplete"/,
  );
  assert.match(
    report.executions[0].shards[0].stderr,
    /"aggregateExists":false/,
  );
  const aggregate = readReport(value.root, "reports/knip", "aggregate.json");
  assert.equal("staleGreen" in aggregate, false);
});

for (const [mode, expected] of [
  ["missing", /Missing Knip JSON output/],
  ["malformed", /Malformed Knip JSON output/],
  ["nonzero", /exited 7/],
  ["abort", /terminated by SIGABRT/],
  ["oom", /out of memory/],
]) {
  test(`${mode} partition evidence fails the aggregate`, () => {
    const value = fixture({ "packages/alpha": mode });
    const result = run(value);
    assert.equal(result.status, 1);
    const report = readReport(value.root, "reports/knip", "run.json");
    assert.equal(report.infrastructureFailed, true);
    assert.match(report.executions[0].shards[0].failure, expected);
    assert.equal(report.status, "failed");
    const aggregate = readReport(value.root, "reports/knip", "aggregate.json");
    assert.equal(aggregate.complete, false);
    assert.equal(aggregate.status, "failed");
    assert.deepEqual(aggregate.outcomes.failedPartitions, ["packages/alpha"]);
    assert.deepEqual(
      aggregate.outcomes.oomPartitions,
      mode === "oom" ? ["packages/alpha"] : [],
    );
  });
}

test("unknown future issue types fail closed", () => {
  const value = fixture({ "packages/alpha": "future" });
  const result = run(value);
  assert.equal(result.status, 1);
  const report = readReport(value.root, "reports/knip", "run.json");
  assert.match(
    report.executions[0].shards[0].failure,
    /Unknown Knip issue type futureIssues/,
  );
});

test("canonical report lock rejects a concurrent publisher", () => {
  const value = fixture();
  mkdirSync(path.join(value.root, "reports/knip"), { recursive: true });
  writeFileSync(path.join(value.root, "reports/knip/run.lock"), "held", "utf8");
  const result = run(value);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publication is already locked/);
});

test("shard aggregation intersects unused exports and unions observed cycles", () => {
  const value = fixture(
    { "packages/alpha": "intersection" },
    { manyDependents: true },
  );
  const result = run(value);
  assert.equal(result.status, 0, result.stderr);
  const aggregate = readReport(value.root, "reports/knip", "aggregate.json");
  const alpha = readReport(
    value.root,
    "reports/knip",
    "run.json",
  ).executions.find(({ workspace }) => workspace === "packages/alpha");
  assert.equal(alpha.shardCount, 2);
  const serialized = JSON.stringify(aggregate.findings);
  assert.match(serialized, /trulyUnused/);
  assert.doesNotMatch(serialized, /consumedElsewhere/);
  assert.match(serialized, /cycleOnlyOneShard/);
});

test("real Knip shards retain cross-workspace use and exact nested ownership", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "knip-real-graph-"));
  roots.push(root);
  writeJson(path.join(root, "package.json"), {
    name: "real-graph-fixture",
    private: true,
    type: "module",
    workspaces: ["packages/*", "packages/*/*"],
  });
  writeJson(path.join(root, "knip.json"), {
    ignoreWorkspaces: ["."],
    workspaces: {
      "packages/producer": {
        entry: ["src/public.ts", "src/dynamic.ts"],
        project: ["src/**/*.ts"],
      },
      "packages/consumer": {
        entry: ["src/index.ts"],
        project: ["src/**/*.ts"],
      },
      "packages/parent": {
        entry: ["src/index.ts"],
        project: ["src/**/*.ts"],
      },
      "packages/parent/child": {
        entry: ["src/index.ts"],
        project: ["src/**/*.ts"],
      },
    },
  });
  writeJson(path.join(root, "packages/producer/package.json"), {
    name: "@fixture/producer",
    private: true,
    type: "module",
  });
  writeText(
    path.join(root, "packages/producer/src/lib.ts"),
    "export const consumed = 1;\nexport const trulyUnused = 2;\n",
  );
  writeText(
    path.join(root, "packages/producer/src/public.ts"),
    "export const publicApi = 1;\n",
  );
  writeText(
    path.join(root, "packages/producer/src/orphan.ts"),
    "export const trulyUnused = 2;\n",
  );
  writeText(
    path.join(root, "packages/producer/src/dynamic.ts"),
    "export const dynamicApi = 1;\n",
  );
  writeJson(path.join(root, "packages/consumer/package.json"), {
    name: "@fixture/consumer",
    private: true,
    type: "module",
  });
  writeText(
    path.join(root, "packages/consumer/src/index.ts"),
    'import { consumed } from "../../producer/src/lib.js";\nconsole.log(consumed);\n',
  );
  writeJson(path.join(root, "packages/parent/package.json"), {
    name: "@fixture/parent",
    private: true,
    type: "module",
  });
  writeText(
    path.join(root, "packages/parent/src/index.ts"),
    "export const parentPublic = 1;\n",
  );
  writeJson(path.join(root, "packages/parent/child/package.json"), {
    name: "@fixture/child",
    private: true,
    type: "module",
  });
  writeText(
    path.join(root, "packages/parent/child/src/index.ts"),
    "export const childPublic = 1;\n",
  );
  writeText(
    path.join(root, "packages/parent/child/src/unused.ts"),
    "export const childUnused = 1;\n",
  );

  const result = run({ root, fakeKnip: REAL_KNIP }, [], "reports/real");
  assert.equal(result.status, 0, result.stderr);
  const aggregate = readReport(root, "reports/real", "aggregate.json");
  assert.equal(aggregate.complete, true);
  const producerPartition = aggregate.ledger.find(
    ({ workspace }) => workspace === "packages/producer",
  );
  assert.deepEqual(producerPartition.manifestDependents, []);
  assert.deepEqual(producerPartition.sourceDependents, ["packages/consumer"]);
  const nestedPartition = aggregate.ledger.find(
    ({ workspace }) => workspace === "packages/parent/child",
  );
  assert.equal(nestedPartition.isolatedDirectory, nestedPartition.workspace);
  const nestedRun = readReport(
    root,
    "reports/real",
    "run.json",
  ).executions.find(({ workspace }) => workspace === nestedPartition.workspace);
  assert.equal(nestedRun.shards[0].command.includes("--workspace"), false);
  const serialized = JSON.stringify(aggregate.findings);
  assert.doesNotMatch(serialized, /consumed/);
  assert.match(serialized, /packages\/producer\/src\/orphan\.ts/);
  assert.doesNotMatch(serialized, /publicApi|dynamicApi/);
  assert.equal(
    aggregate.findings.some(
      ({ workspace, file }) =>
        workspace === "packages/parent/child" &&
        file.includes("packages/parent/child/"),
    ),
    true,
  );
  assert.equal(
    aggregate.findings.some(
      ({ workspace, file }) =>
        workspace === "packages/parent" &&
        file.includes("packages/parent/child/"),
    ),
    false,
  );
});
