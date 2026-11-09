/** Checks refresh orchestration through actual HTTP adapters and encrypted files. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/auth/quint/AccessTokenResolution.qnt";
const testFile = "packages/auth/src/auth/credential-refresh-outcomes.test.ts";
const providers = ["openai-codex", "anthropic-subscription"];
const httpFailures = [
  [400, "invalid_grant"],
  [400, "invalid_request"],
  [400, "invalid_client"],
  [400, "invalid_token"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [429, "rate_limit_exceeded"],
  [503, "server_error"],
  [429, "invalid_grant"],
  [503, "invalid_grant"],
];
const requiredTests = providers.flatMap((provider) => [
  ...httpFailures.map(
    ([status, error]) =>
      `${provider} preserves the ${status}/${error} refresh outcome`,
  ),
  `${provider} reports transport failure without replacing the stored grant`,
  `${provider} queues a caller behind the stored refresh result`,
  `${provider} stores a rotated short-lived grant before returning insufficient lifetime`,
  `${provider} lets deletion win over a provider response`,
  `${provider} returns a fresh replacement without overwriting its generation`,
  `${provider} rejects a response whose explicit policy predates reset`,
  `${provider} keeps a current refresh token when a valid response omits rotation`,
  `${provider} exposes an uncertain malformed response without claiming the spent grant persisted`,
]);
requiredTests.push(
  "requires a storage policy before spending an expired OAuth grant",
  "normalizes invalid lifetime requests without spending a fresh OAuth grant",
  ...["openai-api", "zai-coding", "gemini-cli", "deepseek-coding"].map(
    (provider) =>
      `${provider} preserves its non-refreshable admission contract`,
  ),
  "releases the refresh queue after an uncertain published write failure",
  "keeps identical account keys isolated across explicit policy roots",
  "preserves the winning stored rotation when separate processes race one remote grant",
  "does not fabricate persistence when a rotated grant fails before file publication",
  "returns a fresh legacy token without requiring mutation authority",
  "preserves typed and legacy absence without attempting a provider request",
  "aborts a stalled Codex HTTP400 body and releases the next account refresh",
);
assert.equal(requiredTests.length, 49);
const directoryRoot = testOutputPath("quint-access-token-resolution");
await mkdir(directoryRoot, { recursive: true });
const directory = await mkdtemp(path.join(directoryRoot, "run-"));
const reportPath = path.join(directory, "tests.json");
const run = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    "src/auth/credential-refresh-outcomes.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  {
    cwd: path.join(root, "packages/auth"),
    env: process.env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
);
if (run.error) throw run.error;
assert.equal(
  run.signal,
  null,
  `Refresh conformance terminated by ${run.signal}`,
);
assert.equal(
  run.status,
  0,
  `Refresh conformance failed. See ${directory}/tests.log`,
);
const tests = requireVitestConformance(
  JSON.parse(await readFile(reportPath, "utf8")),
  path.join(root, testFile),
  requiredTests,
);
const manifest = JSON.parse(
  await readFile(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const inputs = {};
for (const source of [
  model,
  model.replace(".qnt", ".cases.json"),
  ...manifest.sources,
  "packages/scripts/lib/vitest-conformance.ts",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(
    {
      inputs,
      tests,
      report: reportPath,
      limitations: [
        "Actual vendor adapters use loopback HTTP responses and private encrypted files. No real vendor account is contacted.",
        "Named scenario conformance covers observable boundaries and controlled races, not every internal schedule in the finite model.",
        "Cryptography and external vendor grant semantics remain explicit assumptions. A malformed or lost response can consume a grant without a recoverable credential.",
      ],
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Access-token conformance passed all ${tests.length} required HTTP/filesystem/process cases. Evidence ${directory}`,
);
