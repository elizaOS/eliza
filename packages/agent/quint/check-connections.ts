/** Runs named conversation readiness checks over real HTTP and SQLite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const testFile = "packages/agent/test/conversation-rename-sqlite.test.ts";
const output = testOutputPath("quint-agent-connections");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const reportPath = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "packages/agent/vitest.config.ts",
    testFile,
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Conformance terminated by ${result.signal}`);
assert.equal(result.status, 0, `Conformance failed. Report ${reportPath}`);
const tests = requireVitestConformance(
  JSON.parse(await readFile(reportPath, "utf8")),
  path.join(root, testFile),
  [
    "keeps a conversation rename on SQLite after the list is rebuilt from the database",
    "rejects creation when the conversation is deleted during room setup",
  ],
);
console.log(
  `Conformance passed ${tests.length} required cases. Evidence ${reportPath}`,
);
