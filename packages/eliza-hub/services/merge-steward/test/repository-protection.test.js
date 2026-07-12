import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  branchPatternMatches,
  buildRepositoryProtectionAudit,
} from "../src/repository-protection.js";

describe("repository protection audit", () => {
  it("marks a repo protected when stored policy and live Forgejo rules match", () => {
    const audit = buildRepositoryProtectionAudit({
      repo: "elizaos/eliza",
      targetBranch: "develop",
      requireLive: true,
      now: "2026-07-06T00:10:00.000Z",
      policy: repoPolicy(),
      live: {
        available: true,
        checked: true,
        protections: [
          {
            branch_name: "develop",
            enable_status_check: true,
            status_check_contexts: ["test", "lint"],
            required_approvals: 1,
          },
        ],
      },
    });

    assert.equal(audit.status, "protected");
    assert.equal(audit.productionReady, true);
    assert.equal(audit.counts.missingRequiredChecks, 0);
    assert.ok(audit.labels.includes("repo-protection:protected"));
    assert.ok(audit.labels.includes("repo-protection:production-ready"));
    assert.equal(
      audit.checks.find(
        (check) => check.name === "live_branch_protection_verified",
      ).status,
      "pass",
    );
    assert.equal(
      audit.checks.find(
        (check) => check.name === "live_required_checks_verified",
      ).status,
      "pass",
    );
  });

  it("fails closed when live verification is required but unavailable", () => {
    const audit = buildRepositoryProtectionAudit({
      repo: "elizaos/eliza",
      targetBranch: "develop",
      requireLive: true,
      policy: repoPolicy(),
      live: {
        available: false,
        checked: true,
        source: "forgejo",
        error: "Forgejo API request failed with 403",
        protections: [],
      },
    });

    assert.equal(audit.status, "blocked");
    assert.equal(audit.productionReady, false);
    assert.ok(
      audit.requiredActions.includes(
        "configure_forgejo_token_and_verify_branch_protection",
      ),
    );
    assert.equal(
      audit.checks.find(
        (check) => check.name === "live_branch_protection_verified",
      ).status,
      "fail",
    );
    assert.equal(
      audit.checks.find(
        (check) => check.name === "live_required_checks_verified",
      ).status,
      "fail",
    );
  });

  it("uses Forgejo glob semantics for protected branch policies", () => {
    assert.equal(branchPatternMatches("release/**", "release/2026/07"), true);
    assert.equal(branchPatternMatches("precious*", "precious-fix"), true);
    assert.equal(branchPatternMatches("release/*", "release/2026/07"), false);

    const audit = buildRepositoryProtectionAudit({
      repo: "elizaos/eliza",
      targetBranch: "release/2026/07",
      requireLive: true,
      policy: repoPolicy({
        protectedBranches: ["main", "release/**"],
      }),
      live: {
        available: true,
        protections: [
          {
            branchName: "release/**",
            requiredStatusChecks: {
              contexts: [{ context: "test" }, { name: "lint" }],
            },
          },
        ],
      },
    });

    assert.equal(audit.status, "protected");
    assert.equal(audit.live.matchingProtections[0].pattern, "release/**");
  });

  it("blocks missing durable policy, target branch coverage, and required checks", () => {
    const audit = buildRepositoryProtectionAudit({
      repo: "elizaos/eliza",
      targetBranch: "develop",
      requireLive: false,
      policy: null,
      config: {
        protectedBranches: ["main"],
        requiredChecks: [],
      },
      live: {
        available: false,
        reason: "forgejo_client_unavailable",
        protections: [],
      },
    });

    assert.equal(audit.status, "blocked");
    assert.equal(audit.productionReady, false);
    assert.equal(
      audit.checks.find((check) => check.name === "repo_policy_present").status,
      "fail",
    );
    assert.equal(
      audit.checks.find(
        (check) => check.name === "protected_branches_configured",
      ).status,
      "fail",
    );
    assert.equal(
      audit.checks.find((check) => check.name === "required_checks_configured")
        .status,
      "fail",
    );
    assert.ok(audit.requiredActions.includes("create_repo_policy"));
    assert.ok(audit.requiredActions.includes("configure_required_checks"));
  });

  it("blocks when live branch protection is missing a required check", () => {
    const audit = buildRepositoryProtectionAudit({
      repo: "elizaos/eliza",
      targetBranch: "develop",
      policy: repoPolicy(),
      live: {
        available: true,
        protections: [
          {
            name: "develop",
            status_check_contexts: ["test"],
          },
        ],
      },
    });

    assert.equal(audit.status, "blocked");
    assert.deepEqual(audit.live.missingRequiredChecks, ["lint"]);
    assert.ok(audit.labels.includes("checks:missing"));
    assert.ok(
      audit.requiredActions.includes("add_missing_live_required_checks"),
    );
  });
});

function repoPolicy(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    queueMode: "serialized",
    protectedBranches: ["develop"],
    requiredChecks: ["test", "lint"],
    trustedActors: ["agent-one"],
    allowForks: false,
    ...overrides,
  };
}
