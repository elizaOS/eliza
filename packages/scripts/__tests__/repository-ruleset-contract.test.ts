/** Proves the disjoint no-bypass rulesets, read-only drift workflow, and explicit helper behavior with a deterministic fake GitHub CLI boundary. */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HELPER = join(REPO_ROOT, "scripts/security/apply-branch-protection.sh");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const admission = Bun.YAML.parse(
  read(".github/workflows/pr-static-smoke.yml"),
) as Record<string, any>;
const drift = Bun.YAML.parse(
  read(".github/workflows/repository-ruleset-drift.yml"),
) as Record<string, any>;
const mainManifest = JSON.parse(
  read(".github/rulesets/required-main.json"),
) as Record<string, any>;
const developManifest = JSON.parse(
  read(".github/rulesets/epic-25025-develop-admission.json"),
) as Record<string, any>;
const helperSource = read("scripts/security/apply-branch-protection.sh");
const codeowners = read(".github/CODEOWNERS");
const driftSource = read(".github/workflows/repository-ruleset-drift.yml");

type FakeState = {
  details: Record<string, Record<string, any>>;
  effective?: Record<string, Array<Record<string, any>>>;
  injectPostOverlap?: boolean;
  list: Array<Record<string, any>>;
  manifestReplaced?: boolean;
  replaceManifestOnList?: {
    path: string;
    value: Record<string, any>;
  };
};

const fakeGhSource = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] !== "api") {
  console.error("unsupported fake gh command");
  process.exit(2);
}

const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.effective ||= {};
let method = "GET";
const methodIndex = args.indexOf("-X");
if (methodIndex !== -1) method = args[methodIndex + 1];
const endpoint = args.find((value) => value.startsWith("repos/"));
const inputIndex = args.indexOf("--input");
const inputSource = inputIndex === -1 ? null : args[inputIndex + 1];
appendFileSync(logPath, JSON.stringify({ method, endpoint, inputSource }) + "\n");

const reply = (value) => process.stdout.write(JSON.stringify(value));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const payload = inputIndex === -1
  ? null
  : JSON.parse(
      inputSource === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(inputSource, "utf8"),
    );

function publishRuleset(id, value) {
  for (const [branch, rules] of Object.entries(state.effective)) {
    state.effective[branch] = rules.filter(
      (rule) => String(rule.ruleset_id) !== String(id),
    );
  }
  for (const ref of value.conditions.ref_name.include) {
    const branch = ref.slice("refs/heads/".length);
    state.effective[branch] ||= [];
    state.effective[branch].push(
      ...value.rules.map((rule) => ({
        type: rule.type,
        ruleset_source_type: "Repository",
        ruleset_source: "test/repo",
        ruleset_id: id,
        ...(rule.parameters ? { parameters: rule.parameters } : {}),
      })),
    );
  }
}

if (method === "GET" && endpoint.includes("/rulesets?")) {
  if (state.replaceManifestOnList && !state.manifestReplaced) {
    writeFileSync(
      state.replaceManifestOnList.path,
      JSON.stringify(state.replaceManifestOnList.value),
    );
    state.manifestReplaced = true;
    save();
  }
  reply([state.list]);
} else if (method === "GET" && endpoint.includes("/rules/branches/")) {
  const encodedBranch = endpoint.split("/rules/branches/")[1].split("?")[0];
  reply([state.effective[decodeURIComponent(encodedBranch)] || []]);
} else if (method === "GET" && endpoint.includes("/rulesets/")) {
  const id = endpoint.split("/").at(-1);
  if (!state.details[id]) process.exit(1);
  reply(state.details[id]);
} else if (method === "POST" && endpoint === "repos/test/repo/rulesets") {
  const id = 9001;
  state.list.push({
    id,
    name: payload.name,
    target: payload.target,
    enforcement: payload.enforcement,
    source_type: "Repository",
    source: "test/repo",
  });
  state.details[String(id)] = { id, ...payload };
  publishRuleset(id, payload);
  if (state.injectPostOverlap) {
    state.list.push({
      id: 9002,
      name: "inherited-overlap",
      target: "branch",
      enforcement: "active",
      source_type: "Organization",
      source: "test-org",
    });
    state.details["9002"] = {
      id: 9002,
      name: "inherited-overlap",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
      rules: [{ type: "deletion" }],
    };
    state.effective.develop ||= [];
    state.effective.develop.push({
      type: "deletion",
      ruleset_source_type: "Organization",
      ruleset_source: "test-org",
      ruleset_id: 9002,
    });
  }
  save();
  reply({ id, ...payload });
} else if (method === "PUT" && endpoint.includes("/rulesets/")) {
  const id = endpoint.split("/").at(-1);
  state.details[id] = { id: Number(id), ...payload };
  publishRuleset(id, payload);
  save();
  reply(state.details[id]);
} else {
  console.error("unsupported fake gh api request", method, endpoint);
  process.exit(2);
}
`;

function listEntry(
  manifest: Record<string, any>,
  id: number,
  sourceType = "Repository",
): Record<string, any> {
  return {
    id,
    name: manifest.name,
    target: manifest.target,
    enforcement: manifest.enforcement,
    source_type: sourceType,
    source: sourceType === "Repository" ? "test/repo" : "test-org",
  };
}

function effectiveEntries(
  manifest: Record<string, any>,
  id: number,
  sourceType = "Repository",
): Record<string, Array<Record<string, any>>> {
  return Object.fromEntries(
    manifest.conditions.ref_name.include.map((ref: string) => [
      ref.slice("refs/heads/".length),
      manifest.rules.map((rule: Record<string, any>) => ({
        type: rule.type,
        ruleset_source_type: sourceType,
        ruleset_source: sourceType === "Repository" ? "test/repo" : "test-org",
        ruleset_id: id,
        ...(rule.parameters ? { parameters: rule.parameters } : {}),
      })),
    ]),
  );
}

function stateWithManifests(): FakeState {
  return {
    list: [listEntry(mainManifest, 101), listEntry(developManifest, 102)],
    details: {
      "101": { id: 101, ...structuredClone(mainManifest) },
      "102": { id: 102, ...structuredClone(developManifest) },
    },
    effective: {
      ...effectiveEntries(mainManifest, 101),
      ...effectiveEntries(developManifest, 102),
    },
  };
}

function runHelper(
  state: FakeState,
  args: string[],
): {
  exitCode: number;
  requests: Array<{
    endpoint: string;
    inputSource: string | null;
    method: string;
  }>;
  stderr: string;
  stdout: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ruleset-helper-"));
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  const logPath = join(root, "requests.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), fakeGhSource);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, "");
  try {
    const result = Bun.spawnSync({
      cmd: [HELPER, ...args],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FAKE_GH_LOG: logPath,
        FAKE_GH_STATE: statePath,
        GH_TOKEN: "deterministic-test-token",
        GITHUB_REPOSITORY: "test/repo",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const requests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      exitCode: result.exitCode,
      requests,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manifestPath(name: "develop" | "main"): string {
  return join(
    REPO_ROOT,
    ".github/rulesets",
    name === "develop"
      ? "epic-25025-develop-admission.json"
      : "required-main.json",
  );
}

describe("repository ruleset contract", () => {
  test("publishes one stable fail-closed aggregate for PR and merge candidates", () => {
    expect(admission.on.pull_request).toEqual({
      branches: ["develop", "main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    });
    expect(admission.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(admission.jobs["static-smoke"].name).toBe("All Tests Passed");
    expect(Object.keys(admission.jobs)).toEqual([
      "source-smoke",
      "billing-payment-replay-e2e",
      "subscription-authority-postgres",
      "browser-bridge-windows-security",
      "static-smoke",
    ]);
    expect(admission.jobs["static-smoke"].needs).toEqual([
      "source-smoke",
      "browser-bridge-windows-security",
      "billing-payment-replay-e2e",
      "subscription-authority-postgres",
    ]);
    expect(admission.jobs["billing-payment-replay-e2e"].needs).toBeUndefined();
    expect(admission.jobs["browser-bridge-windows-security"].uses).toBe(
      "./.github/workflows/browser-bridge-windows-security.yml",
    );
    expect(admission.jobs["subscription-authority-postgres"].name).toBe(
      "Subscription authority PostgreSQL",
    );
    expect(admission.concurrency["cancel-in-progress"]).toBeTrue();
  });

  test("keeps main semantics unchanged and gives each manifest one exact disjoint ref", () => {
    expect(mainManifest.name).toBe("required-main");
    expect(mainManifest.conditions.ref_name).toEqual({
      include: ["refs/heads/main"],
      exclude: [],
    });
    expect(developManifest.name).toBe("epic-25025-develop-admission");
    expect(developManifest.conditions.ref_name).toEqual({
      include: ["refs/heads/develop"],
      exclude: [],
    });
    expect(
      mainManifest.conditions.ref_name.include.filter((ref: string) =>
        developManifest.conditions.ref_name.include.includes(ref),
      ),
    ).toEqual([]);
    for (const manifest of [mainManifest, developManifest]) {
      expect(manifest.enforcement).toBe("active");
      expect(manifest.target).toBe("branch");
      expect(manifest.bypass_actors).toEqual([]);
    }

    const mainPullRequest = mainManifest.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    expect(codeowners).toContain("are PLACEHOLDERS");
    expect(mainPullRequest.parameters).toMatchObject({
      allowed_merge_methods: ["squash", "rebase"],
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true,
    });
    expect(
      mainManifest.rules.map((rule: Record<string, any>) => rule.type).sort(),
    ).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_linear_history",
      "required_status_checks",
    ]);
  });

  test("pins develop admission to the GitHub Actions All Tests Passed check", () => {
    const pullRequest = developManifest.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    expect(pullRequest.parameters).toMatchObject({
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true,
    });
    const status = developManifest.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    expect(status.parameters).toEqual({
      do_not_enforce_on_create: true,
      required_status_checks: [
        { context: "All Tests Passed", integration_id: 15368 },
      ],
      strict_required_status_checks_policy: true,
    });
    expect(
      developManifest.rules
        .map((rule: Record<string, any>) => rule.type)
        .sort(),
    ).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);
  });

  test("requires an explicit manifest even in dry-run mode", () => {
    const result = runHelper(stateWithManifests(), ["--dry-run"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--manifest is required in every mode");
    expect(result.requests).toEqual([]);
  });

  test("performs a successful check without a mutating GitHub request", () => {
    const result = runHelper(stateWithManifests(), [
      "--manifest",
      manifestPath("develop"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "ruleset readback passed: epic-25025-develop-admission",
    );
    expect(result.requests.length).toBeGreaterThan(0);
    expect(
      result.requests.every((request) => request.method === "GET"),
    ).toBeTrue();
  });

  test("refuses an overlapping inherited ruleset before apply without mutation", () => {
    const state: FakeState = {
      list: [
        {
          id: 201,
          name: "organization-wide-develop",
          target: "branch",
          enforcement: "active",
          source_type: "Organization",
          source: "test-org",
        },
      ],
      details: {
        "201": {
          id: 201,
          conditions: {
            ref_name: {
              include: ["~ALL"],
              exclude: ["refs/heads/[release]"],
            },
          },
          enforcement: "active",
          name: "organization-wide-develop",
          rules: [{ type: "deletion" }],
          target: "branch",
        },
      },
      effective: {
        develop: [
          {
            type: "deletion",
            ruleset_source_type: "Organization",
            ruleset_source: "test-org",
            ruleset_id: 201,
          },
        ],
      },
    };
    const result = runHelper(state, [
      "--manifest",
      manifestPath("develop"),
      "--apply",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("foreign effective rule");
    expect(result.stderr).toContain("preflight");
    expect(
      result.requests.some((request) =>
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method),
      ),
    ).toBeFalse();
  });

  test("refuses duplicate same-name rulesets before apply without mutation", () => {
    const state: FakeState = {
      list: [listEntry(developManifest, 301), listEntry(developManifest, 302)],
      details: {},
    };
    const result = runHelper(state, [
      "--manifest",
      manifestPath("develop"),
      "--apply",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("multiple rulesets are named");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("fails postflight when overlap appears across the apply race", () => {
    const result = runHelper(
      { details: {}, injectPostOverlap: true, list: [] },
      ["--manifest", manifestPath("develop"), "--apply", "--repo", "test/repo"],
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("postflight");
    expect(result.stderr).toContain("foreign effective rule");
    expect(
      result.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  test("detects a mismatched GitHub Actions App pin without mutation", () => {
    const actual = structuredClone(developManifest);
    const status = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    status.parameters.required_status_checks[0].integration_id = 999;
    const state: FakeState = {
      list: [listEntry(developManifest, 401)],
      details: { "401": { id: 401, ...actual } },
      effective: effectiveEntries(developManifest, 401),
    };
    const result = runHelper(state, [
      "--manifest",
      manifestPath("develop"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain("required_status_checks[0].integration_id");
    expect(result.stderr).not.toContain("999");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("detects extra live array entries instead of truncating them", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["102"]);
    actual.bypass_actors = [
      { actor_id: 8675309, actor_type: "Team", bypass_mode: "always" },
    ];
    actual.conditions.ref_name.include.push("refs/heads/private-fixture-name");
    state.details["102"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("develop"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain("ruleset.bypass_actors.length");
    expect(result.stderr).toContain(
      "ruleset.conditions.ref_name.include.length",
    );
    expect(result.stderr).not.toContain("8675309");
    expect(result.stderr).not.toContain("private-fixture-name");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("fails closed when an effective rule omits source attribution", () => {
    const state = stateWithManifests();
    state.effective = {
      ...state.effective,
      develop: [{ type: "deletion", ruleset_source_type: "Repository" }],
    };
    const result = runHelper(state, [
      "--manifest",
      manifestPath("develop"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("omitted ruleset attribution");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("applies the validated in-memory payload if the manifest path is replaced", () => {
    const root = mkdtempSync(join(tmpdir(), "ruleset-manifest-race-"));
    const path = join(root, "develop.json");
    const weakened = structuredClone(developManifest);
    weakened.bypass_actors = [
      { actor_id: 1, actor_type: "Team", bypass_mode: "always" },
    ];
    weakened.conditions.ref_name.include = ["refs/heads/main"];
    writeFileSync(path, JSON.stringify(developManifest));
    try {
      const result = runHelper(
        {
          details: {},
          effective: {},
          list: [],
          replaceManifestOnList: { path, value: weakened },
        },
        ["--manifest", path, "--apply", "--repo", "test/repo"],
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "ruleset readback passed: epic-25025-develop-admission",
      );
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(weakened);
      const writes = result.requests.filter((request) =>
        ["POST", "PUT"].includes(request.method),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].inputSource).toBe("-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the scheduled two-manifest workflow strictly read-only", () => {
    expect(Object.keys(drift.on).sort()).toEqual([
      "repository_dispatch",
      "schedule",
      "workflow_dispatch",
    ]);
    expect(drift.on.schedule).toEqual([{ cron: "17 */6 * * *" }]);
    expect(drift.on.repository_dispatch.types).toEqual([
      "repository_ruleset_drift",
    ]);
    expect(drift.permissions).toEqual({ contents: "read" });
    expect(drift.jobs.readback.strategy.matrix.manifest).toEqual([
      ".github/rulesets/required-main.json",
      ".github/rulesets/epic-25025-develop-admission.json",
    ]);
    expect(driftSource).not.toContain("github.token");
    expect(driftSource).not.toContain("--apply");
    const setupNode = drift.jobs.readback.steps.find(
      (step: Record<string, any>) =>
        step.uses ===
        "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(setupNode.with).toEqual({ "node-version": "24.15.0" });
    const credential = drift.jobs.readback.steps.find(
      (step: Record<string, any>) =>
        step.name === "Require the Administration-read credential",
    );
    expect(credential.env.GH_TOKEN).toBe(
      "${{ secrets.REPOSITORY_RULESET_READ_TOKEN }}",
    );
    expect(credential.run).toContain('if [ -z "${GH_TOKEN:-}" ]');
    const readback = drift.jobs.readback.steps.at(-1);
    expect(readback.env.GH_TOKEN).toBe(
      "${{ secrets.REPOSITORY_RULESET_READ_TOKEN }}",
    );
    expect(readback.run).toContain("--manifest");
    expect(readback.run).toContain("--check");
    expect(readback.run).not.toContain("--apply");
    expect(helperSource).toContain('MANIFEST=""');
    expect(helperSource).toContain('--apply) MODE="apply"');
  });
});
