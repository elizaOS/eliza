/** Qualify credential cache resolution and its durable revocation boundary. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "InferenceCredentialCache.qnt"),
  "Inference credential cache conformance requires its own model path",
);
const suites = new Map([
  [
    "packages/cloud/api/__tests__/inference-admission-gate.miniflare.test.ts",
    [
      "independent callers observe API-key revocation immediately",
      "subject and organization suspension are reversible durable fences",
      "clearing one subject denial cannot clear an independent denial",
    ],
  ],
  [
    "packages/cloud/shared/src/lib/services/inference-auth-hot-path.pglite.test.ts",
    [
      "read the primary and never consult or write the authorization cache",
      "a warm entry authorizes with zero primary queries and no refresh",
      "a stale entry is still served with zero primary queries and refreshes off-response",
      "a first-ever miss is decided by the primary once and its decision is projected under waitUntil",
      "a suspension found by the async refresh makes the next request fail",
      "a revocation found by the async refresh makes the next request fail",
      "writer invalidation sends the next request to the primary, never a stale allow",
      "a cached key expiry denies locally with zero primary queries",
      "an entry is bound to its credential hash: another key's entry never authorizes",
      "no gate call precedes the decision, whatever the gate would answer",
      "an unresponsive gate neither delays nor fails a warm request",
    ],
  ],
]);
const pattern = `(?:${[...suites.values()]
  .flat()
  .map((name) => RegExp.escape(name))
  .join("|")})$`;
const output = testOutputPath("quint-inference-credential-cache");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "240000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=60000",
    "--test-name-pattern",
    pattern,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    ...suites.keys(),
  ],
  {
    cwd: root,
    stdio: "inherit",
    // This conformance run exercises the cache. Cloud CI disables the cache
    // globally, so select the same isolated in-memory backend as the suite.
    env: { ...process.env, CACHE_ENABLED: "true", MOCK_REDIS: "1" },
  },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Inference credential cache checks failed");

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors, 0);
const required = [...suites].flatMap(([file, names]) =>
  names.map((name) => `${file} > ${name}`),
);
const executed = [
  ...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
]
  .filter((match) => !/<skipped\b/.test(match[2] ?? ""))
  .map((match) => {
    const name = match[1]
      .match(/\bname="([^"]+)"/)?.[1]
      .replaceAll("&apos;", "'");
    const file = match[1].match(/\bfile="([^"]+)"/)?.[1];
    return `${file} > ${name}`;
  });
assert.deepEqual(
  executed.sort(),
  required.sort(),
  "Required checks did not execute",
);
console.log(
  `Inference credential cache passed ${summary.executedTests} required Workerd and PGlite checks. Report ${report}`,
);
