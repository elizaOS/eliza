/** Source fixtures for the admission transfer audit; no Cloudflare or Wrangler. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  API_CONFIG,
  applyPatch,
  auditChain,
  configView,
  effectiveDrift,
  effectiveVariables,
  reverseChain,
  runbookPhases,
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
    const deployCommit = new Map(effective).set(
      "ELIZA_DEPLOY_COMMIT",
      "a".repeat(40),
    );
    expect(effectiveDrift(api, target, deployCommit)).toEqual([]);
  });

  test("Root's receipt shapes merge and must agree", () => {
    const current = JSON.stringify({
      version: "742e1bf0-5c05-41c1-9b1b-b957be25800b",
      flags: [
        { name: "ENVIRONMENT", type: "plain_text", text: "production" },
        {
          name: "INFERENCE_STRONG_REVOCATION_ENABLED",
          type: "plain_text",
          text: "false",
        },
      ],
    });
    const review = JSON.stringify({
      effectiveFlags: {
        "eliza-cloud-api-prod": {
          INFERENCE_STRONG_REVOCATION_ENABLED: "false",
        },
        "eliza-cloud-api-staging": {
          INFERENCE_STRONG_REVOCATION_ENABLED: "true",
        },
      },
    });
    const fundedRate = JSON.stringify({
      flags: { "eliza-cloud-api-prod": {}, "eliza-cloud-api-staging": {} },
    });
    expect(effectiveVariables([current, review, fundedRate])).toEqual(
      new Map([
        ["ENVIRONMENT", "production"],
        ["INFERENCE_STRONG_REVOCATION_ENABLED", "false"],
      ]),
    );
    const conflicting = JSON.stringify({
      effectiveFlags: {
        "eliza-cloud-api-prod": { INFERENCE_STRONG_REVOCATION_ENABLED: "true" },
      },
    });
    expect(() => effectiveVariables([current, conflicting])).toThrow(
      "disagree on INFERENCE_STRONG_REVOCATION_ENABLED",
    );
    expect(() =>
      effectiveVariables([
        JSON.stringify({ flags: [{ name: "SECRET", type: "secret_text" }] }),
      ]),
    ).toThrow("is not plain text");
    expect(() => effectiveVariables([JSON.stringify({ other: {} })])).toThrow(
      "Unrecognized effective-variable receipt",
    );
  });
});
