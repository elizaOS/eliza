import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  canary,
  classify,
  evaluate,
  waitForRequiredChecks,
} from "./security-advisory-gate.mjs";

describe("base-trusted workflow contract", () => {
  it("grants the read-only Actions authority required by the production query", () => {
    const workflow = readFileSync(
      new URL(
        "../../.github/workflows/security-advisory-gate.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const permissions = workflow.match(
      /^permissions:\r?\n((?:^ {2}[a-z-]+: [^\r\n]+\r?\n)+)/m,
    )?.[1];

    assert(permissions, "workflow must declare an explicit permissions block");
    assert.match(permissions, /^ {2}actions: read$/m);
    assert.doesNotMatch(permissions, /:\s*write\s*$/m);
    assert.match(
      workflow,
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/,
    );
    // Without this pin, import.meta.main can silently evaluate falsy on an
    // unsupported runner Node - removing the setup-node step left the 18/18
    // suite green (#19372 review), so the pin needs its own assertion here.
    assert.match(
      workflow,
      /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
    );
    assert.match(workflow, /node-version: "24\.15\.0"/);
  });
});

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

  it("runs when invoked through a symlink in a path containing spaces", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "security advisory gate "));
    const linkedScript = path.join(tempDir, "security advisory gate.mjs");
    symlinkSync(
      new URL("./security-advisory-gate.mjs", import.meta.url),
      linkedScript,
    );

    try {
      // Pinned to "node", not process.execPath: this required lane runs under
      // Bun (run-script-tests.mjs hands every discovered test to Bun), so
      // process.execPath resolves to the Bun binary. The production
      // entrypoint (.github/workflows/security-advisory-gate.yml) always runs
      // under Node - pinning here is what makes this test actually exercise
      // the import.meta.main guard on the runtime it needs to work on.
      const result = spawnSync("node", [linkedScript], {
        encoding: "utf8",
        env: { ...process.env, CANARY_SCENARIO: "bypass" },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /canary passed: bypass/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("deterministic security check outcomes", () => {
  it("requires only a real successful PR Static Smoke outcome", () => {
    assert.equal(evaluate([]).passed, false);
    assert.deepEqual(
      evaluate([
        {
          name: "All Tests Passed",
          conclusion: "success",
          status: "completed",
        },
        { name: "claude-review", conclusion: "failure", status: "completed" },
        { name: "security", conclusion: "failure", status: "completed" },
      ]),
      { waiting: [], failed: [], active: [], passed: true },
    );
  });

  it("fails every non-success terminal conclusion for PR Static Smoke only", () => {
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
        { name: "All Tests Passed", conclusion, status: "completed" },
      ]);
      assert.deepEqual(state.failed, ["All Tests Passed"], conclusion);
      assert.equal(state.passed, false);
    }
  });

  it("waits for missing and nonterminal checks", () => {
    assert.deepEqual(evaluate([]).waiting, ["All Tests Passed"]);
    assert.deepEqual(
      evaluate([
        { name: "All Tests Passed", conclusion: null, status: "in_progress" },
      ]).waiting,
      ["All Tests Passed"],
    );
    assert.deepEqual(
      evaluate([
        { name: "All Tests Passed", conclusion: null, status: "in_progress" },
      ]).active,
      ["All Tests Passed"],
    );
  });

  it("uses the newest check run for a repeated context", () => {
    const state = evaluate([
      { name: "All Tests Passed", conclusion: null, status: "in_progress" },
      { name: "All Tests Passed", conclusion: "success", status: "completed" },
    ]);
    assert.deepEqual(state.waiting, ["All Tests Passed"]);
    assert.equal(state.passed, false);
  });
});

describe("delayed fork-workflow approval", () => {
  const start = Date.parse("2026-07-28T00:00:00.000Z");

  function timestamp(offsetMs) {
    return new Date(start + offsetMs).toISOString();
  }

  function fakeClock() {
    let value = start;
    return {
      now: () => value,
      advance: (delayMs) => {
        value += delayMs;
      },
      sleep: async (delayMs) => {
        value += delayMs;
      },
    };
  }

  it("allows a bounded completion grace when PR Static Smoke starts by the deadline", async () => {
    const clock = fakeClock();
    const states = [
      [],
      [
        {
          name: "All Tests Passed",
          conclusion: null,
          status: "in_progress",
          started_at: timestamp(5),
        },
      ],
      [
        {
          name: "All Tests Passed",
          conclusion: "success",
          status: "completed",
          started_at: timestamp(5),
          completed_at: timestamp(15),
        },
      ],
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

  it("fails immediately with the held workflow path when approval is required", async () => {
    const clock = fakeClock();
    let checkLoads = 0;
    let sleeps = 0;

    await assert.rejects(
      waitForRequiredChecks({
        loadChecks: async () => {
          checkLoads += 1;
          return [];
        },
        loadActionRequiredPaths: async () => [
          ".github/workflows/pr-static-smoke.yml",
        ],
        timeoutMs: 1_200_000,
        completionGraceMs: 240_000,
        intervalMs: 30_000,
        now: clock.now,
        sleep: async () => {
          sleeps += 1;
        },
      }),
      /required workflows awaiting maintainer approval: \.github\/workflows\/pr-static-smoke\.yml; approve the listed workflows, then rerun this gate/,
    );

    assert.equal(checkLoads, 0);
    assert.equal(sleeps, 0);
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
          {
            name: "All Tests Passed",
            conclusion: null,
            status: "in_progress",
            started_at: timestamp(0),
          },
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

  it("does not grant grace to a check that starts after the approval deadline", async () => {
    const clock = fakeClock();
    let loadCount = 0;
    await assert.rejects(
      waitForRequiredChecks({
        loadChecks: async () => {
          loadCount += 1;
          if (loadCount === 1) return [];
          clock.advance(1);
          return [
            {
              name: "All Tests Passed",
              conclusion: null,
              status: "in_progress",
              started_at: timestamp(11),
            },
          ];
        },
        timeoutMs: 10,
        completionGraceMs: 10,
        intervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      }),
      /timed out waiting for security advisory checks/,
    );
  });

  it("does not accept a check that completes after the bounded grace", async () => {
    const clock = fakeClock();
    const states = [
      [],
      [
        {
          name: "All Tests Passed",
          conclusion: null,
          status: "in_progress",
          started_at: timestamp(5),
        },
      ],
      [
        {
          name: "All Tests Passed",
          conclusion: "success",
          status: "completed",
          started_at: timestamp(5),
          completed_at: timestamp(21),
        },
      ],
    ];

    await assert.rejects(
      waitForRequiredChecks({
        loadChecks: async () => {
          const state = states.shift() ?? [];
          if (states.length === 0) clock.advance(1);
          return state;
        },
        timeoutMs: 10,
        completionGraceMs: 10,
        intervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      }),
      /timed out waiting for security advisory checks/,
    );
  });

  it("accepts an on-time completion observed after a slow API response", async () => {
    const clock = fakeClock();
    let loadCount = 0;

    await waitForRequiredChecks({
      loadChecks: async () => {
        loadCount += 1;
        if (loadCount === 1) return [];
        if (loadCount === 2) {
          return [
            {
              name: "All Tests Passed",
              conclusion: null,
              status: "in_progress",
              started_at: timestamp(5),
            },
          ];
        }
        clock.advance(5);
        return [
          {
            name: "All Tests Passed",
            conclusion: "success",
            status: "completed",
            started_at: timestamp(5),
            completed_at: timestamp(19),
          },
        ];
      },
      timeoutMs: 10,
      completionGraceMs: 10,
      intervalMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });
  });
});
