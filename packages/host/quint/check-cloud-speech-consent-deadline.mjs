/** Require the actual host client's complete cancellation and phase-budget suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/host/quint/CloudSpeechConsentDeadline.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const file =
  "packages/host/src/voice/cloud-speech-relay-phase-deadline.test.ts";
const required = [
  "a cold six-second upgrade reaches ready without renewing its session",
  "consent retries one connection reset before its single paid admission",
  "repeated consent resets stop before any paid admission",
  "Stop cancels the consent reset delay before another request",
  "cold consent can finish just beyond ten seconds without a false startup failure",
  "Stop cancels a cold consent before any session is allocated",
  "three-second upgrade plus three-second ready succeeds within separate finite phase budgets",
  "abort during upgrade fences late open and ready without hello or retry",
  "ready deadline closes opening socket without invalid STOP and late ready cannot revive it",
];
const output = testOutputPath("quint-cloud-speech-consent-deadline");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    process.execPath,
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    "src/voice/cloud-speech-relay-phase-deadline.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "packages/host"),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
writeFileSync(
  path.join(directory, "vitest.log"),
  `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
);
if (child.error) throw child.error;
assert.equal(child.signal, null, "Host deadline conformance interrupted");
assert.equal(
  child.status,
  0,
  `Host deadline conformance failed; see ${directory}`,
);
const identities = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, file),
  required,
);
const sources = Object.fromEntries(
  [
    ...new Set([model, model.replace(".qnt", ".cases.json"), ...cases.sources]),
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, identities, sources, bounds: cases.bounds }, null, 2)}\n`,
);
console.log(
  `Host consent deadline conformance passed ${identities.length} actual client checks: ${directory}`,
);
