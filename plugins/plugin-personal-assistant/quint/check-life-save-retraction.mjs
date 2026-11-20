/** Replay generated owner messages through the production recent-save retraction. */
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
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.resolve(import.meta.dirname, "..");
const model = path.resolve(process.argv[2] ?? "");
assert.equal(model, path.join(import.meta.dirname, "LifeSaveRetraction.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-life-save-retraction");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    `--main=${modelCase.main}`,
    `--init=${modelCase.init}`,
    `--step=${modelCase.step}`,
    "--backend=typescript",
    "--seed=20261115",
    `--max-samples=${modelCase.samples}`,
    `--n-traces=${modelCase.samples}`,
    `--max-steps=${modelCase.maxSteps}`,
    "--invariants",
    ...modelCase.invariants,
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const number = (value) => Number(value["#bigint"]);
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  // Every state where the handler has run is a case.
  for (const state of states) {
    if (state.handled !== true) continue;
    const item = {
      prefix: number(state.prefix),
      mark: number(state.mark),
      form: number(state.form),
      target: number(state.target),
      live: state.live,
      cached: state.cached,
      removed: state.removed,
    };
    cases.set(
      JSON.stringify([item.form, item.prefix, item.mark, item.target]),
      item,
    );
  }
}
// 3 prefixes, 3 apostrophe spellings, 3 forms and 2 planner targets.
assert.equal(cases.size, 54, "Every message must reach conformance");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "src/actions/life-save-retraction.pglite.integration.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "600000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.src-integration.config.ts",
    file,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: plugin,
    encoding: "utf8",
    env: { ...process.env, ELIZA_LIFE_SAVE_RETRACTION_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Life save retraction conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  ["save that one", "keep it", "forget to set it for 9"].map(
    (name) => `life save retraction model replays ${name}`,
  ),
);
console.log(
  `${cases.size} model-generated messages (all 54) match the OWNER_REMINDERS retraction in ${checks.length} message forms. Report ${report}`,
);
