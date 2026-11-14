import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const owner = path.join(root, "packages/testing/scenario-runner");
const output = testOutputPath("quint-scenario-runtime");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const cases = new Map([
  [
    "src/runtime-factory.live-isolation.test.ts",
    [
      "live provider isolation from LLM mocks refuses a selected live provider whose OPENAI_BASE_URL still names its mock",
      "live provider isolation from LLM mocks refuses a selected live provider whose ANTHROPIC_BASE_URL still names its mock",
      "live provider isolation from LLM mocks refuses a selected live provider whose OPENAI_BASE_URL names the other LLM mock",
      "live provider isolation from LLM mocks refuses a selected live provider whose ANTHROPIC_BASE_URL names the other LLM mock",
      "live provider isolation from LLM mocks drops inherited OPENAI_BASE_URL that names the other LLM mock",
      "live provider isolation from LLM mocks drops inherited ANTHROPIC_BASE_URL that names the other LLM mock",
      "live provider isolation from LLM mocks keeps the world's mock LLM base URLs out of a live runtime's settings",
      "live provider isolation from LLM mocks refuses loopback aliases of known mock servers",
      "live provider isolation from LLM mocks restores the process's own base URL, drops a mock one, and lets the provider win",
      "live provider isolation from LLM mocks leaves the deterministic lane on the mocks",
      "redirectTwilioFetch redirects a Twilio Request over real loopback HTTP and restores ownership",
      "redirectTwilioFetch never lets a Twilio call reach api.twilio.com and restores fetch",
    ],
  ],
  [
    "src/runtime-lifecycle.test.ts",
    [
      "drains startup resources in reverse order, restores environment, and closes once",
      "retains each cleanup failure and quarantines the process",
    ],
  ],
]);
for (const [file, names] of cases) {
  const report = path.join(directory, `${path.basename(file)}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      "--config",
      path.join(owner, "vitest.config.ts"),
      file,
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: owner,
      env: process.env,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(directory, `${path.basename(file)}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(
    result.status,
    0,
    `Scenario runtime conformance failed: ${directory}`,
  );
  const summary = JSON.parse(readFileSync(report, "utf8"));
  requireVitestConformance(summary, path.join(owner, file), names);
}
console.log(
  `Scenario runtime conformance passed all required cases. Evidence ${directory}`,
);
