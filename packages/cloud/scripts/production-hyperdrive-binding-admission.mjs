#!/usr/bin/env bun

/**
 * Fail-closed admission for the one production-only Hyperdrive recovery seam.
 *
 * This does not replace staging certification. It permits a candidate only
 * when the currently served base has an immutable staging certificate and the
 * complete source delta is limited to the production Hyperdrive id plus the
 * reviewed, non-runtime policy/workflow files needed to perform this check.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";

export const WRANGLER_PATH = "packages/cloud/api/wrangler.toml";

export const ALLOWED_NON_RUNTIME_CHANGES = new Map([
  [".github/workflows/cloud-cf-deploy.yml", new Set(["M"])],
  [".github/workflows/cloud-cf-release.yml", new Set(["M"])],
  [".github/workflows/deploy-eliza-provisioning-worker.yml", new Set(["M"])],
  [
    "packages/cloud/scripts/production-hyperdrive-binding-admission.mjs",
    new Set(["A", "M"]),
  ],
  [
    "packages/cloud/scripts/production-hyperdrive-binding-admission.test.mjs",
    new Set(["A", "M"]),
  ],
  [
    "packages/cloud/scripts/staging-release-certification.test.mjs",
    new Set(["M"]),
  ],
  [
    "packages/scripts/__tests__/provisioning-worker-deploy-workflow.test.ts",
    new Set(["M"]),
  ],
]);

export const TRUSTED_POLICY_PATHS = [
  ".github/workflows/cloud-cf-deploy.yml",
  ".github/workflows/cloud-cf-release.yml",
  "packages/cloud/scripts/production-hyperdrive-binding-admission.mjs",
  "packages/cloud/scripts/production-hyperdrive-binding-admission.test.mjs",
  "packages/cloud/scripts/staging-release-certification.test.mjs",
];

export const PINNED_EXISTING_MAIN_TRANSITIONS = new Map([
  [
    ".github/workflows/deploy-eliza-provisioning-worker.yml",
    [
      "ca21ddcc79058357594872fc60cbf4bc64adbd3a",
      "9e8ecb1f91fdb6db79b8e6c6a5588509804c12c5",
    ],
  ],
  [
    "packages/scripts/__tests__/provisioning-worker-deploy-workflow.test.ts",
    [
      "2cfd3cf834dae09bb285b9292928f906602181fc",
      "f0f54a609f8e918a59b9adfbcc24c6e2cebd18e7",
    ],
  ],
]);

const HEX_32 = /^[0-9a-f]{32}$/;
const SHA_40 = /^[0-9a-f]{40}$/;

function fail(code) {
  throw new Error(`production_hyperdrive_binding_admission:${code}`);
}

function parseConfig(source, label) {
  let parsed;
  try {
    parsed = Bun.TOML.parse(source);
  } catch {
    fail(`${label}_toml_invalid`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label}_toml_invalid`);
  }
  return parsed;
}

function productionBinding(config, label) {
  const bindings = config?.env?.production?.hyperdrive;
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    fail(`${label}_production_binding_ambiguous`);
  }
  const binding = bindings[0];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail(`${label}_production_binding_invalid`);
  }
  if (
    Object.keys(binding).sort().join(",") !== "binding,id" ||
    binding.binding !== "HYPERDRIVE" ||
    typeof binding.id !== "string" ||
    !HEX_32.test(binding.id)
  ) {
    fail(`${label}_production_binding_invalid`);
  }
  return binding;
}

function normalizePostgresScheme(value) {
  return value === "postgres" || value === "postgresql" ? "postgresql" : value;
}

export function validateProductionHyperdriveAuthority(input) {
  const response = input.response;
  const result = response?.result;
  if (
    response?.success !== true ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.id !== input.expectedConfigId
  ) {
    fail("hyperdrive_response_invalid");
  }
  const origin = result.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
    fail("hyperdrive_origin_invalid");
  }

  let database;
  try {
    database = new URL(input.databaseUrl);
  } catch {
    fail("database_url_invalid");
  }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  const databaseUser = decodeURIComponent(database.username);
  const databasePort = Number(database.port || "5432");
  const databaseScheme = normalizePostgresScheme(
    database.protocol.replace(/:$/, ""),
  );
  const originScheme = normalizePostgresScheme(origin.scheme);
  if (
    typeof origin.host !== "string" ||
    origin.host !== database.hostname ||
    !Number.isSafeInteger(origin.port) ||
    origin.port !== databasePort ||
    typeof origin.database !== "string" ||
    origin.database !== databaseName ||
    typeof origin.user !== "string" ||
    origin.user !== databaseUser ||
    originScheme !== databaseScheme ||
    databaseScheme !== "postgresql"
  ) {
    fail("hyperdrive_authority_mismatch");
  }
  const authorityReceipt = createHash("sha256")
    .update(
      [origin.host, String(origin.port), origin.database, origin.user].join(
        "\u0000",
      ),
    )
    .digest("hex");
  return { schemaVersion: 1, verdict: "pass", authorityReceipt };
}

export function validateProductionHyperdriveBindingDelta(input) {
  if (input.force === true) fail("force_forbidden");
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    fail("changes_missing");
  }

  let wranglerChanges = 0;
  const seenPaths = new Set();
  for (const change of input.changes) {
    if (
      !change ||
      typeof change.path !== "string" ||
      typeof change.status !== "string"
    ) {
      fail("change_invalid");
    }
    if (seenPaths.has(change.path)) fail("change_ambiguous");
    seenPaths.add(change.path);
    if (change.path === WRANGLER_PATH) {
      if (change.status !== "M") fail("wrangler_status_invalid");
      wranglerChanges += 1;
      continue;
    }
    const statuses = ALLOWED_NON_RUNTIME_CHANGES.get(change.path);
    if (!statuses?.has(change.status)) fail("path_not_allowlisted");
  }
  if (wranglerChanges !== 1) fail("wrangler_change_ambiguous");

  const base = parseConfig(input.baseWranglerSource, "base");
  const candidate = parseConfig(input.candidateWranglerSource, "candidate");
  const baseBinding = productionBinding(base, "base");
  const candidateBinding = productionBinding(candidate, "candidate");
  if (baseBinding.id === candidateBinding.id) fail("binding_unchanged");

  // Structural equality is necessary but not sufficient because TOML comments
  // and whitespace do not survive parsing. Require byte equality after one
  // and only one exact id-token substitution so no textual Wrangler drift can
  // hide beside the admitted binding update.
  if (input.candidateWranglerSource.split(candidateBinding.id).length !== 2) {
    fail("candidate_binding_token_ambiguous");
  }
  if (
    input.candidateWranglerSource.replace(
      candidateBinding.id,
      baseBinding.id,
    ) !== input.baseWranglerSource
  ) {
    fail("wrangler_text_delta_not_bounded");
  }

  // Mask only the candidate production id. Deep equality after this point
  // rejects every other Wrangler mutation, including staging, vars, routes,
  // migrations, extra bindings, and parse-shape ambiguity.
  candidateBinding.id = baseBinding.id;
  if (!isDeepStrictEqual(candidate, base)) fail("wrangler_delta_not_bounded");

  return {
    schemaVersion: 1,
    verdict: "pass",
    changedPathCount: input.changes.length,
  };
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_40.test(value))
    fail(`${label}_invalid`);
  return value;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function readChanges(root, baseSha, candidateSha) {
  const output = git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    `${baseSha}..${candidateSha}`,
  ]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [status, path, extra] = line.split("\t");
    if (extra !== undefined || !status || !path) fail("change_invalid");
    return { status, path };
  });
}

export function validateTrustedPolicyIdentityFromGit(input) {
  const policySha = requireSha(input.policySha, "policy_sha");
  const candidateSha = requireSha(input.candidateSha, "candidate_sha");
  for (const path of TRUSTED_POLICY_PATHS) {
    let policyBlob;
    let candidateBlob;
    try {
      policyBlob = git(input.repoRoot, ["rev-parse", `${policySha}:${path}`]);
      candidateBlob = git(input.repoRoot, [
        "rev-parse",
        `${candidateSha}:${path}`,
      ]);
    } catch {
      fail("trusted_policy_path_missing");
    }
    if (policyBlob !== candidateBlob) fail("trusted_policy_identity_mismatch");
  }
  return {
    schemaVersion: 1,
    verdict: "pass",
    policyPathCount: TRUSTED_POLICY_PATHS.length,
  };
}

export function admitProductionHyperdriveBindingFromGit(input) {
  const baseSha = requireSha(input.baseSha, "base_sha");
  const candidateSha = requireSha(input.candidateSha, "candidate_sha");
  if (input.force === true) fail("force_forbidden");
  try {
    git(input.repoRoot, ["merge-base", "--is-ancestor", baseSha, candidateSha]);
  } catch {
    fail("base_not_ancestor");
  }
  const baseWranglerSource = git(input.repoRoot, [
    "show",
    `${baseSha}:${WRANGLER_PATH}`,
  ]);
  const candidateWranglerSource = git(input.repoRoot, [
    "show",
    `${candidateSha}:${WRANGLER_PATH}`,
  ]);
  const changes = readChanges(input.repoRoot, baseSha, candidateSha);
  for (const [path, expected] of PINNED_EXISTING_MAIN_TRANSITIONS) {
    if (!changes.some((change) => change.path === path)) continue;
    const observed = [
      git(input.repoRoot, ["rev-parse", `${baseSha}:${path}`]),
      git(input.repoRoot, ["rev-parse", `${candidateSha}:${path}`]),
    ];
    if (!isDeepStrictEqual(observed, expected)) {
      fail("existing_main_transition_mismatch");
    }
  }
  return validateProductionHyperdriveBindingDelta({
    baseWranglerSource,
    candidateWranglerSource,
    changes,
    force: input.force,
  });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      "repo-root": { type: "string" },
      "base-sha": { type: "string" },
      "candidate-sha": { type: "string" },
      "policy-sha": { type: "string" },
      force: { type: "boolean", default: false },
      "hyperdrive-json": { type: "string" },
    },
  });
  if (values["hyperdrive-json"]) {
    if (
      values.force ||
      values["base-sha"] ||
      values["candidate-sha"] ||
      values["policy-sha"]
    ) {
      fail("authority_mode_ambiguous");
    }
    const config = parseConfig(
      readFileSync(
        `${values["repo-root"] || process.cwd()}/${WRANGLER_PATH}`,
        "utf8",
      ),
      "candidate",
    );
    const expectedConfigId = productionBinding(config, "candidate").id;
    const result = validateProductionHyperdriveAuthority({
      response: JSON.parse(readFileSync(values["hyperdrive-json"], "utf8")),
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub environment injects this standalone admission input outside Turbo caching.
      databaseUrl: process.env.DATABASE_URL,
      expectedConfigId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  validateTrustedPolicyIdentityFromGit({
    repoRoot: values["repo-root"] || process.cwd(),
    policySha: values["policy-sha"],
    candidateSha: values["candidate-sha"],
  });
  const result = admitProductionHyperdriveBindingFromGit({
    repoRoot: values["repo-root"] || process.cwd(),
    baseSha: values["base-sha"],
    candidateSha: values["candidate-sha"],
    force: values.force,
  });
  // Config ids are not emitted. The workflow publishes only bounded verdicts.
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: result.schemaVersion, verdict: result.verdict, changedPathCount: result.changedPathCount })}\n`,
  );
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write("production Hyperdrive binding admission rejected\n");
    process.exitCode = 1;
  });
}
