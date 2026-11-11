/** Run the real Hono and SDK adapter checks in separate processes (Bun module-mock isolation). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const directory = testOutputPath(
  "cloud-formal",
  "conformance",
  "responses-adaptation",
);
mkdirSync(directory, { recursive: true });
const sources = [
  "packages/cloud/api/v1/responses/compatibility.ts",
  "packages/cloud/api/v1/responses/route.ts",
  "packages/cloud/api/v1/chat/completions/route.ts",
  "packages/cloud/api/v1/chat/completions/provider-boundary.ts",
  "packages/cloud/shared/src/lib/services/native-application-inference.ts",
  "packages/cloud/api/v1/responses/route.test.ts",
  "packages/cloud/api/v1/responses/arguments.test.ts",
  "packages/cloud/api/v1/responses/provider-contract.test.ts",
  "packages/cloud/quint/ResponsesAdaptation.qnt",
  "packages/cloud/quint/ResponsesAdaptation.cases.json",
  "packages/cloud/quint/check-responses-adaptation.ts",
];
const tests = [
  { file: "v1/responses/route.test.ts", count: 48 },
  { file: "v1/responses/arguments.test.ts", count: 14 },
  { file: "v1/responses/provider-contract.test.ts", count: 10 },
];
const results = tests.map(({ file, count }, index) => {
  const junit = path.join(directory, `tests-${index}.xml`);
  const args = [
    "--conditions=eliza-source",
    "test",
    file,
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ];
  const result = spawnSync("bun", args, {
    cwd: path.join(root, "packages/cloud/api"),
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(directory, `tests-${index}.log`), log);
  process.stdout.write(log);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Responses conformance failed: ${file}`);
  assert.equal(result.signal, null);
  const summary = parseJunitSummary(readFileSync(junit, "utf8"));
  assert.equal(summary.tests, count);
  assert.equal(summary.executedTests, count);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  return { file, summary };
});
writeFileSync(
  path.join(directory, "result.json"),
  `${JSON.stringify(
    {
      scope:
        "Actual adapter and canonical chat/SDK with controlled auth, billing and provider transports; no live-provider or authority implementation proof",
      results,
      sourceSha256: Object.fromEntries(
        sources.map((file) => [
          file,
          createHash("sha256")
            .update(readFileSync(path.join(root, file)))
            .digest("hex"),
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);
