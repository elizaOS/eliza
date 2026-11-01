/** Source fixtures for the admission transfer audit; no Cloudflare or Wrangler. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ADMISSION_BUNDLE_SOURCES,
  API_CONFIG,
  applyPatch,
  auditChain,
  configView,
  effectiveDrift,
  mainMergeProblems,
  reverseChain,
  runbookPhases,
  steadyMergeProblems,
  TARGET_CONFIG,
  VALIDATOR_INPUTS,
} from "./production-admission-phase-audit.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
const steady = Object.fromEntries(
  VALIDATOR_INPUTS.map((path) => [path, read(path)]),
);
const reverseDirectory = "packages/cloud/admission-worker/reverse-transfer";
const patches = readdirSync(resolve(repoRoot, reverseDirectory)).map(
  (name): [string, string] => [name, read(`${reverseDirectory}/${name}`)],
);
// The names Root's effective-variable receipts cover, valued as committed now.
const committed = configView(steady[API_CONFIG]).production?.vars;
const effective = new Map(
  [
    "ENVIRONMENT",
    "INFERENCE_AUTH_CACHE_ENABLED",
    "INFERENCE_DEFERRED_ADMISSION",
    "INFERENCE_HOT_PATH_CACHES",
    "INFERENCE_SNAPSHOT_ADMISSION_ENABLED",
    "INFERENCE_STRONG_REVOCATION_ENABLED",
    "VOICE_SPEECH_END_TIMEOUT_MS",
    "VOICE_SPEECH_RELAY_ENABLED",
  ].map((name) => [name, committed[name]]),
);
const gateExport = "production.exports.InferenceAdmissionGate";
const gateBinding =
  "production.durable_objects.bindings.INFERENCE_ADMISSION_GATES";

describe("transfer phase sources", () => {
  test("the runbook pins each forward phase to one full commit, in order", () => {
    const rows = runbookPhases(
      read("packages/cloud/admission-worker/PRODUCTION-TRANSFER.md"),
    );
    expect(rows.map((row) => row.phase)).toEqual([
      "source-owned",
      "target-pending",
      "source-commit",
      "adopted",
    ]);
    for (const row of rows) expect(row.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("each reverse step validates as its phase and changes only admission", () => {
    const report = auditChain(
      [
        { phase: "adopted", commit: "steady", files: steady },
        ...reverseChain(steady, patches),
      ],
      effective,
    );
    expect(report.map((entry) => [entry.phase, entry.problems])).toEqual([
      ["adopted", []],
      ["reverse-pending", []],
      ["reverse-commit", []],
      ["reverse-adopted", []],
    ]);
    expect(report.map((entry) => entry.validator?.[0])).toEqual([
      expect.stringContaining("production steady-state source contract passed"),
      expect.stringContaining("production reverse-pending phase"),
      expect.stringContaining("production reverse-commit phase"),
      expect.stringContaining("production reverse-adopted phase"),
    ]);
    expect(report.slice(1).map((entry) => entry.changes)).toEqual([
      {
        api: [
          `${gateExport}.state`,
          `${gateExport}.storage`,
          `${gateExport}.transfer_from`,
          `${gateExport}.transferred_to`,
        ],
        target: [],
      },
      {
        api: [],
        target: [
          gateBinding,
          `${gateExport}.state`,
          `${gateExport}.storage`,
          `${gateExport}.transferred_to`,
        ],
      },
      {
        api: [
          `${gateBinding}.script_name`,
          `${gateExport}.state`,
          `${gateExport}.transfer_from`,
        ],
        target: [],
      },
    ]);
    expect(report[0].apiOnlyEffective).toEqual(["VOICE_SPEECH_END_TIMEOUT_MS"]);
  });

  test("a reverse step applies only on top of its predecessor", () => {
    const [, r2, r3] = patches.toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    expect(() => applyPatch(steady, r3[1])).toThrow("does not apply");
    const twice = applyPatch(steady, r2[1]);
    expect(() => applyPatch(twice, r2[1])).toThrow("does not apply");
  });

  test("an unrelated change or the wrong phase is reported", () => {
    const [pending] = reverseChain(steady, patches);
    const widened = {
      ...pending.files,
      [API_CONFIG]: pending.files[API_CONFIG].replace(
        "[env.production.vars]\n",
        '[env.production.vars]\nUNRELATED_FLAG = "1"\n',
      ),
    };
    const [, changed] = auditChain(
      [
        { phase: "adopted", commit: "steady", files: steady },
        { ...pending, files: widened },
      ],
      effective,
    );
    expect(changed.problems).toEqual([
      "api changes outside admission: production.vars.UNRELATED_FLAG",
    ]);
    const [mislabelled] = auditChain(
      [{ phase: "reverse-commit", commit: "steady", files: steady }],
      effective,
    );
    expect(mislabelled.problems).toEqual([
      "validator: error: Expected production admission phase reverse-commit, found adopted",
    ]);
  });
});

describe("effective variables", () => {
  const api = configView(steady[API_CONFIG]).production;
  const target = configView(steady[TARGET_CONFIG]).production;

  test("the committed steady state keeps every effective variable", () => {
    expect(effectiveDrift(api, target, effective)).toEqual([]);
  });

  test("a changed API or target value, or a set gate policy flag, is drift", () => {
    const drifted = new Map(effective).set(
      "INFERENCE_STRONG_REVOCATION_ENABLED",
      "true",
    );
    expect(effectiveDrift(api, target, drifted)).toEqual([
      "API INFERENCE_STRONG_REVOCATION_ENABLED is false, effective true",
      "target INFERENCE_STRONG_REVOCATION_ENABLED is false, effective true",
    ]);
    const funded = {
      ...target,
      vars: { ...target?.vars, INFERENCE_FUNDED_BUDGET_ADMISSION: "true" },
    };
    expect(effectiveDrift(api, funded, effective)).toEqual([
      "target sets INFERENCE_FUNDED_BUDGET_ADMISSION, which production leaves unset",
    ]);
    // The gate's Maps allowance controller reads these from its environment.
    const maps = {
      ...api,
      vars: { ...api?.vars, ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES: "{}" },
    };
    expect(effectiveDrift(maps, target, effective)).toEqual([
      "API sets ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES, which production leaves unset",
    ]);
    const deployCommit = new Map(effective).set(
      "ELIZA_DEPLOY_COMMIT",
      "a".repeat(40),
    );
    expect(effectiveDrift(api, target, deployCommit)).toEqual([]);
  });
});

describe("gate 2: the phase 2 main commit", () => {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout;
  const rows = Object.fromEntries(
    runbookPhases(
      read("packages/cloud/admission-worker/PRODUCTION-TRANSFER.md"),
    ).map((row) => [row.phase, row.commit]),
  );
  const changed = (from: string, to: string, paths: string[] = []) =>
    git("diff", "--name-only", from, to, "--", ...paths)
      .split("\n")
      .filter(Boolean);
  const live = rows["source-owned"];
  const phasePaths = changed(live, rows["source-commit"]);
  const facts = {
    firstParent: live,
    liveMain: live,
    live: { phase: "target-pending", api: { commit: live } },
    mergePaths: phasePaths,
    phasePaths,
    phaseContentPaths: changed(
      rows["source-commit"],
      rows["source-commit"],
      phasePaths,
    ),
    bundlePaths: changed(
      rows["target-pending"],
      rows["source-commit"],
      ADMISSION_BUNDLE_SOURCES,
    ),
  };

  test("the frozen phase 2 change builds the target's admission bundle", () => {
    expect(phasePaths).toEqual([
      ".github/workflows/cloud-tests.yml",
      "packages/cloud/admission-worker/verify-staging-contract.ts",
      "packages/cloud/admission-worker/wrangler.toml",
      "packages/cloud/api/wrangler.toml",
      "packages/cloud/scripts/production-deploy-admission-lock.test.ts",
    ]);
    expect(facts.bundlePaths).toEqual([]);
    expect(facts.phaseContentPaths).toEqual([]);
    expect(mainMergeProblems(facts)).toEqual([]);
    // Every bundle source exists in the frozen target tree.
    for (const path of ADMISSION_BUNDLE_SOURCES)
      expect(
        git("ls-tree", "--name-only", rows["target-pending"], "--", path),
      ).not.toBe("");
  });

  test("a moved main, a wider merge or other gate code is refused", () => {
    const moved = "e".repeat(40);
    expect(
      mainMergeProblems({
        ...facts,
        firstParent: moved,
        live: { phase: "source-commit", api: { commit: moved } },
        mergePaths: [...phasePaths, "packages/core/src/index.ts"],
        bundlePaths: ["packages/cloud/api/src/inference-admission-gate.ts"],
      }),
    ).toEqual([
      "live receipt is source-commit, not target-pending",
      `the API serves ${moved}, not live main ${live}`,
      `first parent ${moved} is not live main ${live}`,
      "merge changes packages/core/src/index.ts outside the phase 2 change",
      "admission bundle source differs from the target: packages/cloud/api/src/inference-admission-gate.ts",
    ]);
  });

  test("the phase 2 paths must carry the frozen content, not only the frozen names", () => {
    // Phase 1's tree touches the same paths with other content.
    const content = changed(
      rows["source-commit"],
      rows["target-pending"],
      phasePaths,
    );
    expect(content).not.toEqual([]);
    expect(mainMergeProblems({ ...facts, phaseContentPaths: content })).toEqual(
      content.map((path) => `${path} differs from the frozen phase 2 change`),
    );
  });
});

describe("gate 3: the steady state on main", () => {
  const phaseTwoMain = "a".repeat(40);
  const facts = {
    firstParent: phaseTwoMain,
    phaseTwoMain,
    tree: "b".repeat(40),
    mergedTree: "b".repeat(40),
  };

  test("the reviewed tip merged cleanly onto the phase 2 main commit passes", () => {
    expect(steadyMergeProblems(facts)).toEqual([]);
  });

  test("another parent or any change beyond the reviewed tip is refused", () => {
    expect(
      steadyMergeProblems({
        ...facts,
        firstParent: "c".repeat(40),
        tree: "d".repeat(40),
      }),
    ).toEqual([
      `first parent ${"c".repeat(40)} is not the phase 2 main commit`,
      "the steady tree differs from the reviewed tip merged onto the phase 2 main commit",
    ]);
  });
});
