/** Runs the real SQLite/ethers signing and audit scenario conformance suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = process.argv[2];
assert(model, "The shared checker must provide the model path");
assert(
  ["AuditOutbox.qnt", "services-signing.qnt"].includes(path.basename(model)),
);
const testFile = "packages/agent/test/sandbox-audit-durability.test.ts";
const output = testOutputPath("quint-signing-audit");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const resultPath = path.join(directory, "tests.json");
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-vitest.ts",
    "run",
    "--config",
    "packages/agent/vitest.config.ts",
    testFile,
    "--reporter=json",
    `--outputFile=${resultPath}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(
  result.signal,
  null,
  `Integration tests terminated by ${result.signal}`,
);
assert.equal(
  result.status,
  0,
  `Real signing/audit integration failed. See ${directory}/tests.log`,
);
const report = JSON.parse(await readFile(resultPath, "utf8"));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.equal(path.resolve(file.name), path.join(root, testFile));
assert(file.assertionResults.length > 0, "Conformance suite executed no cases");
assert(file.assertionResults.every((test) => test.status === "passed"));
const inputs = [
  model,
  testFile,
  "packages/agent/src/security/audit-log.ts",
  "packages/agent/src/services/remote-signing-service.ts",
  "packages/agent/src/services/signing-policy.ts",
];
const hashes = {};
for (const input of inputs) {
  hashes[input] = createHash("sha256")
    .update(await readFile(path.resolve(root, input)))
    .digest("hex");
}
const evidence = {
  model,
  inputs: hashes,
  tests: file.assertionResults.map((test) => ({
    name: test.fullName,
    status: test.status,
  })),
  limitations:
    "Scenario conformance through actual file-backed SQLite and ethers signatures. Does not prove every abstract interleaving or external signer failure semantics.",
};
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `Signing/audit scenario conformance passed ${file.assertionResults.length} real SQLite/ethers tests.`,
);
console.log(`Evidence: ${path.join(directory, "evidence.json")}`);
