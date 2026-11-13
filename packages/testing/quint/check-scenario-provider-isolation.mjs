import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/testing/quint/ScenarioProviderIsolation.qnt"),
);
const output = testOutputPath("quint-scenario-provider-isolation");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "tests.json");
const file =
  "packages/testing/scenario-runner/src/runtime-factory.live-isolation.test.ts";
const result = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    "--config",
    "scenario-runner/vitest.config.ts",
    "scenario-runner/src/runtime-factory.live-isolation.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "packages/testing"),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
writeFileSync(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(
  result.signal,
  null,
  "Scenario isolation conformance was interrupted",
);
assert.equal(
  result.status,
  0,
  `Scenario isolation conformance failed: ${directory}`,
);
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, file),
  [
    "live provider isolation from LLM mocks refuses a selected live provider whose OPENAI_BASE_URL still names its mock",
    "live provider isolation from LLM mocks refuses a selected live provider whose ANTHROPIC_BASE_URL still names its mock",
    "live provider isolation from LLM mocks refuses a selected live provider whose OPENAI_BASE_URL names the other LLM mock",
    "live provider isolation from LLM mocks refuses a selected live provider whose ANTHROPIC_BASE_URL names the other LLM mock",
    "live provider isolation from LLM mocks drops inherited OPENAI_BASE_URL that names the other LLM mock",
    "live provider isolation from LLM mocks drops inherited ANTHROPIC_BASE_URL that names the other LLM mock",
    "live provider isolation from LLM mocks keeps the world's mock LLM base URLs out of a live runtime's settings",
    "live provider isolation from LLM mocks restores the process's own base URL, drops a mock one, and lets the provider win",
    "live provider isolation from LLM mocks leaves the deterministic lane on the mocks",
    "redirectTwilioFetch redirects a Twilio Request over real loopback HTTP and restores ownership",
    "redirectTwilioFetch never lets a Twilio call reach api.twilio.com and restores fetch",
  ],
);
