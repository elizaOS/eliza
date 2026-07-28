import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canary,
  classify,
  evaluate,
  waitForRequiredChecks,
} from "./security-advisory-gate.mjs";

describe("security advisory classification", () => {
  it("protects a sensitive previous_filename on rename", () => {
    const result = classify({
      files: [
        {
          filename: "packages/core/src/ordinary.ts",
          previous_filename: "packages/core/src/auth/token.ts",
        },
      ],
    });
    assert.equal(result.protected, true);
  });

  it("protects every sensitive label case-insensitively", () => {
    for (const label of [
      "security",
      "Security Issue",
      "AUTH",
      "money-path",
      "payment integration",
    ]) {
      assert.equal(classify({ labels: [label] }).protected, true);
    }
  });

  it("protects sensitive executable and configuration paths", () => {
    for (const file of [
      "scripts/security/check.mjs",
      "scripts/auth/check.cjs",
      "packages/wallet/src/index.ts",
      ".github/workflows/release.yml",
      "packages/db/migrations/001.sql",
      "services/payment/Dockerfile",
      "services/oauth/.env.example",
    ]) {
      assert.equal(classify({ files: [file] }).protected, true, file);
    }
  });

  it("does not treat irrelevant paths or the former exemption label as authorization", () => {
    assert.deepEqual(
      classify({
        labels: ["security-gate-exempt"],
        files: ["packages/core/src/ordinary.ts", "docs/auth/readme.md"],
      }),
      { protected: false, reason: "no security label or path" },
    );
    assert.equal(classify({}).protected, false);
  });
});

describe("deterministic canaries", () => {
  it("passes every documented canary and rejects unknown scenarios", async () => {
    for (const scenario of [
      "bypass",
      "protected",
      "waiting",
      "success",
      "failure",
    ]) {
      await canary(scenario);
    }
    await assert.rejects(canary("unknown"), /canary failed: unknown/);
  });
});

describe("deterministic security check outcomes", () => {
  it("requires only a real successful gitleaks outcome", () => {
    assert.equal(evaluate([]).passed, false);
    assert.deepEqual(
      evaluate([
        { name: "gitleaks", conclusion: "success", status: "completed" },
        { name: "claude-review", conclusion: "failure", status: "completed" },
        { name: "security", conclusion: "failure", status: "completed" },
      ]),
      { waiting: [], failed: [], active: [], passed: true },
    );
  });

  it("fails every non-success terminal conclusion for gitleaks only", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "neutral",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
    ]) {
      const state = evaluate([
        { name: "gitleaks", conclusion, status: "completed" },
      ]);
      assert.deepEqual(state.failed, ["gitleaks"], conclusion);
      assert.equal(state.passed, false);
    }
  });

  it("waits for missing and nonterminal checks", () => {
    assert.deepEqual(evaluate([]).waiting, ["gitleaks"]);
    assert.deepEqual(
      evaluate([{ name: "gitleaks", conclusion: null, status: "in_progress" }])
        .waiting,
      ["gitleaks"],
    );
    assert.deepEqual(
      evaluate([{ name: "gitleaks", conclusion: null, status: "in_progress" }])
        .active,
      ["gitleaks"],
    );
  });

  it("uses the newest check run for a repeated context", () => {
    const state = evaluate([
      { name: "gitleaks", conclusion: null, status: "in_progress" },
      { name: "gitleaks", conclusion: "success", status: "completed" },
    ]);
    assert.deepEqual(state.waiting, ["gitleaks"]);
    assert.equal(state.passed, false);
  });
});

describe("delayed fork-workflow approval", () => {
  function fakeClock() {
    let value = 0;
    return {
      now: () => value,
      sleep: async (delayMs) => {
        value += delayMs;
      },
    };
  }

  it("allows a bounded completion grace when gitleaks starts by the deadline", async () => {
    const clock = fakeClock();
    const states = [
      [],
      [{ name: "gitleaks", conclusion: null, status: "in_progress" }],
      [{ name: "gitleaks", conclusion: "success", status: "completed" }],
    ];

    await waitForRequiredChecks({
      loadChecks: async () => states.shift() ?? states.at(-1),
      timeoutMs: 10,
      completionGraceMs: 10,
      intervalMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });
  });

  it("does not extend the deadline for a missing or unapproved check", async () => {
    const clock = fakeClock();
    await assert.rejects(
      waitForRequiredChecks({
        loadChecks: async () => [],
        timeoutMs: 10,
        completionGraceMs: 10,
        intervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      }),
      /timed out waiting for security advisory checks/,
    );
  });

  it("still fails when an active check does not pass during the grace", async () => {
    const clock = fakeClock();
    await assert.rejects(
      waitForRequiredChecks({
        loadChecks: async () => [
          { name: "gitleaks", conclusion: null, status: "in_progress" },
        ],
        timeoutMs: 10,
        completionGraceMs: 10,
        intervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      }),
      /timed out waiting for security advisory checks/,
    );
  });
});
