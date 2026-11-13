/** Runs the real SQLite/ethers signing and audit scenario conformance suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

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
const requiredTests = [
  "holds entries until a durable sink commits them and keeps them across restart",
  "rejects sink attachment and every queued record when storage is unavailable",
  "rejects a record when durable storage cannot commit it (sink required: true)",
  "rejects a record when durable storage cannot commit it (sink required: false)",
  "accepts a durable fallback after an optional storage sink fails",
  "keeps a pending signature bound to its admitted transaction despite caller or listing mutation",
  "revokes pending approvals when a signing policy changes",
  "rejects admission overtaken by a policy change while its durable audit is waiting",
  "retains recorded audit facts when callers and observers mutate snapshots",
];
const tests = requireVitestConformance(
  JSON.parse(await readFile(resultPath, "utf8")),
  path.join(root, testFile),
  requiredTests,
);
const inputs = [
  model,
  testFile,
  "packages/scripts/lib/vitest-conformance.ts",
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
  tests,
  report: resultPath,
  limitations:
    "Scenario conformance through actual file-backed SQLite and ethers signatures. Does not prove every abstract interleaving or external signer failure semantics.",
};
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `Signing/audit scenario conformance passed ${tests.length} real SQLite/ethers tests.`,
);
console.log(`Evidence: ${path.join(directory, "evidence.json")}`);
