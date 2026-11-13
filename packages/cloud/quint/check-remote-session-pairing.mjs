/** Check target-created pairing against canonical migrations and real PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "RemoteSessionPairing.qnt"),
  "Remote session pairing conformance requires its own model path",
);
const suite =
  "packages/cloud/shared/src/db/repositories/remote-command-envelopes.pglite.test.ts";
const required = [
  "revokes claimed target pairings before reporting host cleanup complete",
  "runs target challenge claim, confirmation, expiry, denial, replay, and no-resurrection",
  "consumes a host-bound pairing verifier only once",
  "discovers one host-bound session from only its six-digit code",
  "commits an exact staged activation idempotently without admitting pre-commit commands",
  "serializes staged commit against host finalization",
  "compensates an exact activation idempotently under host finalization",
  "serializes activation compensation with host finalization",
];
const pattern = `(?:${required.map((name) => RegExp.escape(name)).join("|")})$`;
const output = testOutputPath("quint-remote-session-pairing");
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
    "--test-name-pattern",
    pattern,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    suite,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Remote session pairing checks failed");
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, required.length]],
);
const names = [
  ...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
]
  .filter((match) => !/<skipped\b/.test(match[2] ?? ""))
  .map((match) => match[1].match(/\bname="([^"]+)"/)?.[1])
  .sort();
assert.deepEqual(names, [...required].sort());
console.log(
  `Remote session pairing passed ${required.length} required checks. Report ${report}`,
);
