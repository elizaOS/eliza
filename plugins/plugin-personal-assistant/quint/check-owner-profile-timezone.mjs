import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2]);
const output = testOutputPath("quint-owner-profile-timezone");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
function generateCases(main, invariant, read, key, count) {
  const traces = path.join(directory, main);
  mkdirSync(traces);
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
      "run",
      model,
      `--main=${main}`,
      "--backend=typescript",
      "--seed=20261113",
      "--max-samples=100",
      "--n-traces=100",
      "--max-steps=8",
      `--invariant=${invariant}`,
      `--out-itf=${path.join(traces, "trace-{seq}.itf.json")}`,
      "--verbosity=0",
    ],
    { stdio: "inherit" },
  );
  const cases = new Map();
  for (const file of readdirSync(traces)) {
    for (const state of JSON.parse(
      readFileSync(path.join(traces, file), "utf8"),
    ).states) {
      if (integer(state, "phase") !== 2) continue;
      const item = read(state);
      cases.set(key(item), item);
    }
  }
  assert.equal(cases.size, count, `Missing completed ${main} scenarios`);
  const input = path.join(directory, `${main}.json`);
  writeFileSync(input, JSON.stringify([...cases.values()]));
  return input;
}

const integer = (state, key) => Number(state[key]["#bigint"]);
const timezoneInput = generateCases(
  "OwnerProfileTimezone",
  "CalendarReadsStoredZone",
  (state) =>
    Object.fromEntries(
      ["prior", "statement", "stored", "readZone"].map((key) => [
        key,
        integer(state, key),
      ]),
    ),
  (item) => `${item.prior}:${item.statement}`,
  8,
);
const travelInput = generateCases(
  "OwnerTravelReturn",
  "ScheduleSeesExpiry",
  (state) => ({
    statement: integer(state, "statement"),
    end: integer(state, "end"),
    activeAtTick: state.activeAtTick,
  }),
  (item) => item.statement,
  6,
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/owner/profile-extraction-evaluator.pglite.test.ts",
    "-t",
    "matches the generated owner (timezone|travel) outcome",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ELIZA_OWNER_PROFILE_TIMEZONE_MODEL_CASES: timezoneInput,
      ELIZA_OWNER_PROFILE_TRAVEL_MODEL_CASES: travelInput,
    },
    stdio: "inherit",
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Owner profile runtime conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 14);
assert.equal(summary.numFailedTests, 0);
console.log(
  `Eight timezone and six travel cases match the production evaluator: ${directory}`,
);
