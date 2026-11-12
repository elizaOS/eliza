/** Run the real SDK streaming route with a controlled Anthropic SSE response. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "ChatSdkStreamSettlement.qnt"),
  "Chat SDK stream conformance requires its own model path",
);
const suite =
  "packages/cloud/api/__tests__/anthropic-web-search-abort.pglite.test.ts";
const required =
  "a failed server search followed by abort retains unknown settlement, not a search charge";
const output = testOutputPath("quint-chat-sdk-stream-settlement");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=60000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    suite,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Chat SDK stream implementation check failed");

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, 1]],
  "The streaming abort implementation check must execute",
);
assert(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].some(
    (match) => match[1] === required,
  ),
  "The required SDK streaming abort case did not execute",
);
console.log(
  `Chat SDK stream passed one required route check. Report ${report}`,
);
