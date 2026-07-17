import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildValidationPlan } from "../src/validation-plan.js";

describe("validation plan", () => {
  it("blocks broad Turbo validation and recommends package-scoped commands", () => {
    const plan = buildValidationPlan({
      now: "2026-07-06T00:00:00.000Z",
      repo: "elizaos/eliza",
      ownerAgentId: "agent-ci",
      changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
      affectedPackages: ["plugin-capacitor-bridge"],
      commands: ["turbo run typecheck", "bun build"],
    });

    assert.equal(plan.computedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(plan.decision.allowed, false);
    assert.equal(plan.decision.state, "blocked");
    assert.ok(plan.decision.blockers.includes("broad_validation_commands"));
    assert.ok(plan.decision.blockers.includes("validation_cost_over_budget"));
    assert.equal(plan.summary.broadCommandCount, 2);
    assert.equal(
      plan.summary.recommendedStrategy,
      "replace_broad_commands_with_package_filters",
    );
    assert.deepEqual(plan.affectedPackages, ["plugin-capacitor-bridge"]);
    assert.ok(
      plan.commands[0].reasons.includes("turbo_without_package_filter"),
    );
    assert.ok(
      plan.commands[1].reasons.includes("bun_build_without_entry_scope"),
    );
    assert.deepEqual(plan.labels, ["validation:broad-blocked", "ci:budget"]);
    assert.deepEqual(
      plan.recommendedCommands.map((command) => command.command),
      [
        "turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge",
        "turbo run build --filter=@elizaos/plugin-capacitor-bridge",
      ],
    );
  });

  it("allows scoped package validation commands", () => {
    const plan = buildValidationPlan({
      repo: "elizaos/eliza",
      changedFiles: ["packages/core/src/runtime.ts"],
      commands: [
        "turbo run typecheck --filter=@elizaos/core",
        "tsc -p packages/core/tsconfig.json",
      ],
    });

    assert.equal(plan.decision.allowed, true);
    assert.equal(plan.decision.state, "scoped");
    assert.equal(plan.summary.scopedCommandCount, 2);
    assert.equal(plan.summary.broadCommandCount, 0);
    assert.deepEqual(
      plan.commands.map((command) => command.scope),
      ["scoped", "scoped"],
    );
    assert.deepEqual(plan.labels, ["validation:scoped"]);
  });

  it("requires a validation command but still suggests a safe plan", () => {
    const plan = buildValidationPlan({
      changedFiles: ["packages/client/src/chat.ts"],
    });

    assert.equal(plan.decision.allowed, false);
    assert.equal(plan.decision.state, "needs_validation_plan");
    assert.deepEqual(plan.decision.blockers, ["missing_validation_commands"]);
    assert.deepEqual(plan.decision.requiredActions, [
      "choose_scoped_validation_command",
    ]);
    assert.deepEqual(
      plan.recommendedCommands.map((command) => command.command),
      ["turbo run typecheck --filter=@elizaos/client"],
    );
    assert.deepEqual(plan.labels, ["validation:plan-needed"]);
  });

  it("falls back to lightweight changed-file checks when no package is inferred", () => {
    const plan = buildValidationPlan({
      changedFiles: ["README.md", "docs/readiness.md"],
      commands: ["git diff --check"],
    });

    assert.equal(plan.decision.allowed, true);
    assert.equal(
      plan.summary.recommendedStrategy,
      "run_changed_file_sanity_checks",
    );
    assert.deepEqual(plan.affectedPackages, []);
    assert.deepEqual(plan.recommendedCommands, [
      {
        command: "git diff --check",
        intent: "format",
        scope: "changed_files",
        package: null,
        reason:
          "No package was inferred; start with a lightweight changed-file sanity check.",
      },
    ]);
  });
});
