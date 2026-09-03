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
appendFileSync(process.env.FAKE_GH_COMMAND_LOG, JSON.stringify(args) + "\n");
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

const reply = (value) => process.stdout.write(JSON.stringify(value));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const payload = inputIndex === -1
  ? null
  : JSON.parse(
      inputSource === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(inputSource, "utf8"),
    );
appendFileSync(
  logPath,
  JSON.stringify({ method, endpoint, inputSource, payload }) + "\n",
);

function materializeRuleset(value) {
  const materialized = structuredClone(value);
  for (const rule of materialized.rules || []) {
    if (rule.type !== "pull_request" || !rule.parameters) continue;
    rule.parameters.dismissal_restriction ??= {
      allowed_actors: [],
      enabled: false,
    };
    rule.parameters.ignore_approvals_from_contributors ??= false;
    rule.parameters.require_extra_approval_for_unattributed_changes ??= true;
    rule.parameters.required_reviewers ??= [];
  }
  return materialized;
}

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
  state.details[String(id)] = { id, ...materializeRuleset(payload) };
  publishRuleset(id, payload);
  if (state.injectPostOverlap) {
    const overlapRef = payload.conditions.ref_name.include[0];
    const overlapBranch = overlapRef.slice("refs/heads/".length);
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
      conditions: { ref_name: { include: [overlapRef], exclude: [] } },
      rules: [{ type: "deletion" }],
    };
    state.effective[overlapBranch] ||= [];
    state.effective[overlapBranch].push({
      type: "deletion",
      ruleset_source_type: "Organization",
      ruleset_source: "test-org",
      ruleset_id: 9002,
    });
  }
  save();
  reply(state.details[String(id)]);
} else if (method === "PUT" && endpoint.includes("/rulesets/")) {
  const id = endpoint.split("/").at(-1);
  state.details[id] = { id: Number(id), ...materializeRuleset(payload) };
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
  if (manifest.enforcement !== "active") return {};
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

function materializedDetail(
  manifest: Record<string, any>,
  id: number,
): Record<string, any> {
  const detail = { id, ...structuredClone(manifest) };
  for (const rule of detail.rules) {
    if (rule.type !== "pull_request" || !rule.parameters) continue;
    rule.parameters.dismissal_restriction ??= {
      allowed_actors: [],
      enabled: false,
    };
    rule.parameters.ignore_approvals_from_contributors ??= false;
    rule.parameters.require_extra_approval_for_unattributed_changes ??= true;
    rule.parameters.required_reviewers ??= [];
  }
  return detail;
}

function stateWithManifests(): FakeState {
  return {
    list: [listEntry(mainManifest, 101), listEntry(developManifest, 102)],
    details: {
      "101": materializedDetail(mainManifest, 101),
      "102": materializedDetail(developManifest, 102),
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
  commands: string[][];
  exitCode: number;
  requests: Array<{
    endpoint: string;
    inputSource: string | null;
    method: string;
    payload: Record<string, any> | null;
  }>;
  stderr: string;
  stdout: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ruleset-helper-"));
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  const logPath = join(root, "requests.jsonl");
  const commandLogPath = join(root, "commands.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), fakeGhSource);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, "");
  writeFileSync(commandLogPath, "");
  try {
    const result = Bun.spawnSync({
      cmd: [HELPER, ...args],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FAKE_GH_COMMAND_LOG: commandLogPath,
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
    const commands = readFileSync(commandLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      commands,
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

function runManifestCheck(
  manifest: Record<string, any>,
  actual: Record<string, any>,
): ReturnType<typeof runHelper> {
  const root = mkdtempSync(join(tmpdir(), "ruleset-manifest-"));
  const path = join(root, "manifest.json");
  const id = 701;
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
  try {
    return runHelper(
      {
        list: [listEntry(manifest, id)],
        details: { [String(id)]: actual },
        effective: effectiveEntries(manifest, id),
      },
      ["--manifest", path, "--check", "--repo", "test/repo"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

  test("keeps main active and the disjoint develop candidate disabled", () => {
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
    expect(mainManifest.enforcement).toBe("active");
    expect(developManifest.enforcement).toBe("disabled");
    for (const manifest of [mainManifest, developManifest]) {
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
    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([]);
  });

  test("prints a validated dry-run without invoking GitHub", () => {
    const result = runHelper(stateWithManifests(), [
      "--manifest",
      manifestPath("main"),
      "--dry-run",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(mainManifest);
    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([]);
  });

  test("refuses every non-active apply before invoking GitHub", () => {
    const root = mkdtempSync(join(tmpdir(), "ruleset-non-active-"));
    try {
      for (const enforcement of ["disabled", "evaluate"] as const) {
        const path = join(root, `${enforcement}.json`);
        writeFileSync(
          path,
          `${JSON.stringify({ ...developManifest, enforcement })}\n`,
        );
        const result = runHelper(stateWithManifests(), [
          "--manifest",
          path,
          "--apply",
          "--repo",
          "test/repo",
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          `cannot be applied while enforcement is '${enforcement}'`,
        );
        expect(result.stderr).toContain(
          "a reviewed source change to active is required first",
        );
        expect(result.commands).toEqual([]);
        expect(result.requests).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(result.commands[0]).toEqual(["auth", "status"]);
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
          name: "organization-wide-main",
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
          name: "organization-wide-main",
          rules: [{ type: "deletion" }],
          target: "branch",
        },
      },
      effective: {
        main: [
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
      manifestPath("main"),
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
      list: [listEntry(mainManifest, 301), listEntry(mainManifest, 302)],
      details: {},
    };
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
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
      ["--manifest", manifestPath("main"), "--apply", "--repo", "test/repo"],
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
      details: { "401": materializedDetail(actual, 401) },
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

  test("detects a live App pin omitted from the main manifest", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    const status = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    status.parameters.required_status_checks[0].integration_id = 15368;
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain("required_status_checks[0].integration_id");
    expect(result.stderr).not.toContain("15368");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("treats an absent and null App pin as the same unpinned policy", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    const status = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    status.parameters.required_status_checks[0].integration_id = null;
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ruleset readback passed: required-main");
    expect(result.stderr).toBe("");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("accepts GitHub-materialized pull-request defaults", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    Object.assign(pullRequest.parameters, {
      dismissal_restriction: { allowed_actors: [], enabled: false },
      ignore_approvals_from_contributors: false,
      require_extra_approval_for_unattributed_changes: true,
      required_reviewers: [],
    });
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ruleset readback passed: required-main");
    expect(result.stderr).toBe("");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("treats known set-like policy arrays as order-independent", () => {
    const manifest = structuredClone(mainManifest);
    manifest.conditions.ref_name.include.push("refs/heads/release-candidate");
    manifest.bypass_actors = [
      { actor_id: 2, actor_type: "Team", bypass_mode: "pull_request" },
      { actor_id: 1, actor_type: "Team", bypass_mode: "pull_request" },
    ];
    const expectedPullRequest = manifest.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    expectedPullRequest.parameters.dismissal_restriction = {
      allowed_actors: [
        { actor_id: 4, actor_type: "Team" },
        { actor_id: 3, actor_type: "Team" },
      ],
      enabled: true,
    };
    expectedPullRequest.parameters.required_reviewers = [
      {
        file_patterns: ["packages/**", "scripts/**"],
        minimum_approvals: 1,
        reviewer: { id: 6, type: "Team" },
      },
      {
        file_patterns: ["docs/**", ".github/**"],
        minimum_approvals: 1,
        reviewer: { id: 5, type: "Team" },
      },
    ];
    const expectedStatusChecks = manifest.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    expectedStatusChecks.parameters.required_status_checks.push({
      context: "Typecheck",
      integration_id: 15368,
    });

    const actual = materializedDetail(manifest, 701);
    actual.conditions.ref_name.include.reverse();
    actual.bypass_actors.reverse();
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    pullRequest.parameters.allowed_merge_methods.reverse();
    pullRequest.parameters.dismissal_restriction.allowed_actors.reverse();
    pullRequest.parameters.required_reviewers.reverse();
    for (const reviewer of pullRequest.parameters.required_reviewers) {
      reviewer.file_patterns.reverse();
    }
    const statusChecks = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    statusChecks.parameters.required_status_checks.reverse();

    const result = runManifestCheck(manifest, actual);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ruleset readback passed: required-main");
    expect(result.stderr).toBe("");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("keeps unknown policy arrays order-sensitive", () => {
    const manifest = structuredClone(mainManifest);
    const expectedPullRequest = manifest.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    expectedPullRequest.parameters.future_ordered_policy = ["first", "second"];
    const actual = materializedDetail(manifest, 701);
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    pullRequest.parameters.future_ordered_policy.reverse();

    const result = runManifestCheck(manifest, actual);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain("future_ordered_policy[0]");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("still detects membership drift in a known set-like policy array", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    pullRequest.parameters.allowed_merge_methods.push("merge");
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain("allowed_merge_methods.length");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("fails closed when the observed extra-approval field is absent", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    delete pullRequest.parameters
      .require_extra_approval_for_unattributed_changes;
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain(
      "require_extra_approval_for_unattributed_changes",
    );
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("detects non-default live review policy without leaking its values", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    Object.assign(pullRequest.parameters, {
      dismissal_restriction: {
        allowed_actors: [{ id: 8675309, type: "Team" }],
        enabled: true,
      },
      ignore_approvals_from_contributors: true,
      require_extra_approval_for_unattributed_changes: false,
      required_reviewers: [
        {
          file_patterns: ["sensitive-pattern/**"],
          minimum_approvals: 1,
          reviewer: { id: 8675309, type: "Team" },
        },
      ],
    });
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("repository ruleset drift detected");
    expect(result.stderr).toContain("dismissal_restriction.enabled");
    expect(result.stderr).toContain("required_reviewers.length");
    expect(result.stderr).toContain(
      "require_extra_approval_for_unattributed_changes",
    );
    expect(result.stderr).toContain("ignore_approvals_from_contributors");
    expect(result.stderr).not.toContain("8675309");
    expect(result.stderr).not.toContain("sensitive-pattern");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("fails closed when the readback principal cannot see bypass actors", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["101"]);
    delete actual.bypass_actors;
    state.details["101"] = actual;
    const result = runHelper(state, [
      "--manifest",
      manifestPath("main"),
      "--check",
      "--repo",
      "test/repo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("omitted bypass_actors");
    expect(result.stderr).toContain("principal must have write access");
    expect(
      result.requests.some((request) => request.method !== "GET"),
    ).toBeFalse();
  });

  test("fails closed on an unknown live rule parameter", () => {
    const state = stateWithManifests();
    const actual = structuredClone(state.details["102"]);
    const pullRequest = actual.rules.find(
      (rule: Record<string, any>) => rule.type === "pull_request",
    );
    pullRequest.parameters.future_review_policy = {
      opaque_value: "sensitive-future-value",
    };
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
    expect(result.stderr).toContain("future_review_policy");
    expect(result.stderr).not.toContain("sensitive-future-value");
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
    const path = join(root, "main.json");
    const weakened = structuredClone(mainManifest);
    weakened.bypass_actors = [
      { actor_id: 1, actor_type: "Team", bypass_mode: "always" },
    ];
    weakened.conditions.ref_name.include = ["refs/heads/develop"];
    writeFileSync(path, JSON.stringify(mainManifest));
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
      expect(result.stdout).toContain("ruleset readback passed: required-main");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(weakened);
      const writes = result.requests.filter((request) =>
        ["POST", "PUT"].includes(request.method),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].inputSource).toBe("-");
      expect(writes[0].payload).toEqual(mainManifest);
      const writtenPullRequest = writes[0].payload?.rules.find(
        (rule: Record<string, any>) => rule.type === "pull_request",
      );
      for (const responseOnlyField of [
        "dismissal_restriction",
        "ignore_approvals_from_contributors",
        "require_extra_approval_for_unattributed_changes",
        "required_reviewers",
      ]) {
        expect(
          Object.hasOwn(writtenPullRequest.parameters, responseOnlyField),
        ).toBeFalse();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps external live readback pinned and limited to the active manifest", () => {
    expect(Object.keys(drift.on).sort()).toEqual(["repository_dispatch"]);
    expect(drift.on.repository_dispatch.types).toEqual([
      "repository_ruleset_drift",
    ]);
    expect(drift.permissions).toEqual({ contents: "read" });
    expect(drift.jobs.readback.if).toBeUndefined();
    expect(drift.jobs.readback.environment).toBeUndefined();
    expect(drift.jobs.readback.strategy.matrix.manifest).toEqual([
      ".github/rulesets/required-main.json",
    ]);
    expect(driftSource).not.toContain("github.token");
    expect(driftSource).not.toContain("--apply");
    expect(driftSource).not.toContain("workflow_dispatch");
    expect(driftSource).not.toContain("schedule:");
    const refGuard = drift.jobs.readback.steps.at(0);
    expect(refGuard.name).toBe("Require the exact develop event ref");
    expect(refGuard.if).toBeUndefined();
    expect(refGuard.run).toContain(
      'if [ "$GITHUB_REF" != "refs/heads/develop" ]',
    );
    expect(refGuard.run).toContain("exit 1");
    const checkout = drift.jobs.readback.steps.find(
      (step: Record<string, any>) =>
        step.uses ===
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(checkout.with).toEqual({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
      submodules: false,
    });
    const setupNode = drift.jobs.readback.steps.find(
      (step: Record<string, any>) =>
        step.uses ===
        "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(setupNode.with).toEqual({ "node-version": "24.15.0" });
    const credential = drift.jobs.readback.steps.find(
      (step: Record<string, any>) =>
        step.name === "Require the ruleset-visible read credential",
    );
    expect(credential.env.GH_TOKEN).toBe(
      "${{ secrets.REPOSITORY_RULESET_READ_TOKEN }}",
    );
    expect(credential.run).toContain('if [ -z "${GH_TOKEN:-}" ]');
    expect(credential.run).toContain("principal has write access");
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
