import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

assert(
  ["darwin", "linux"].includes(process.platform),
  "Clipboard command binding requires the native macOS/Linux fixture lane",
);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-clipboard-lease-binding");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "result.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    "src/credential-clipboard-binding.test.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
    `--fsModuleCachePath=${path.join(directory, "cache")}`,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-browser"),
    encoding: "utf8",
    timeout: 120_000,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Clipboard command conformance failed; see ${directory}`,
);
const result = JSON.parse(await readFile(report, "utf8"));
const tests = result.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(result.success, true);
assert.equal(tests.length, 3);
assert.equal(result.numFailedTests, 0);
assert.equal(result.numPendingTests, 0);
assert(tests.every((test) => test.status === "passed"));
assert.deepEqual(
  tests.map((test) => test.title).sort(),
  [
    "expires through the original executable and environment after PATH changes",
    "does not fall back to a different executable when the admitted one disappears",
    "uses the admitted executable and environment for process-exit cleanup",
  ].sort(),
);
const inputs = {};
for (const file of [
  "plugins/plugin-browser/src/credential-clipboard.ts",
  "plugins/plugin-browser/src/credential-clipboard-binding.test.ts",
  "plugins/plugin-browser/quint/ClipboardLeaseBinding.qnt",
  "plugins/plugin-browser/quint/check-clipboard-lease-binding.mjs",
])
  inputs[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ node: process.version, inputs, tests }, null, 2)}\n`,
);
console.log(
  `Clipboard command binding passed 3 real subprocess cases; evidence ${directory}`,
);
