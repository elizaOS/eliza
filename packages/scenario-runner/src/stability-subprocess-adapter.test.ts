/**
 * Exercises the production stability process-group adapter with real child
 * processes and an injected deterministic control-session boundary. No child
 * process or environment transport is mocked.
 */

import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SyntheticControlSession } from "@elizaos/shared/synthetic-control";
import { afterEach, describe, expect, it } from "vitest";
import { createScenarioStabilityPlan } from "./stability.ts";
import { executeScenarioStability } from "./stability-executor.ts";
import { ScenarioStabilitySubprocessAdapter } from "./stability-subprocess-adapter.ts";

const CHILD_SCRIPT = `
if (process.env.ELIZA_STABILITY_MODEL_MODE === "deterministic-mock" && process.env.OPENAI_API_KEY) {
  process.exit(91);
}
if (process.env.ELIZA_REQUIRE_MOCK_SERVICES !== "1") process.exit(92);
if (process.env.ELIZA_TEST_PRINT_SECRETS === "1") {
  process.stderr.write(String(process.env.ELIZA_SYNTHETIC_CONTROL_TOKEN) + " " + String(process.env.OPENAI_API_KEY || ""));
}
const hash = process.env.ELIZA_STABILITY_AUTHORITY_INITIAL_STATE_HASH;
process.stdout.write(JSON.stringify({
  passed: true,
  initialStateHash: hash,
  finalStateHash: "b".repeat(64),
  inputTokens: 4,
  outputTokens: 2,
  toolCalls: 1,
  evidence: {
    trajectory: [{ model: process.env.ELIZA_STABILITY_MODEL }],
    toolReceipts: [{ name: "SEND_MESSAGE" }],
    stateTransitions: [{ status: "sent" }],
    providerReceipts: process.env.ELIZA_STABILITY_MODEL_MODE === "deterministic-mock" ? [{
      fixtureMode: "strict-fixtures",
      fixtureManifestFingerprint: process.env.ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT,
      unmatchedCalls: 0,
      ambiguousCalls: 0,
      unusedRequiredFixtures: 0,
      overconsumedFixtures: 0
    }, ...(process.env.ELIZA_TEST_DUPLICATE_FIXTURE === "1" ? [{
      fixtureMode: "strict-fixtures",
      fixtureManifestFingerprint: process.env.ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT,
      unmatchedCalls: 0,
      ambiguousCalls: 0,
      unusedRequiredFixtures: 0,
      overconsumedFixtures: 1
    }] : [])] : [{
      receiptType: "eliza.stability.real-llm.v1",
      provider: process.env.ELIZA_TEST_WRONG_REAL === "1" ? "wrong-provider" : process.env.ELIZA_STABILITY_PROVIDER,
      model: process.env.ELIZA_STABILITY_MODEL,
      liveModelInvoked: true,
      namespace: process.env.ELIZA_SYNTHETIC_NAMESPACE,
      manifestId: process.env.ELIZA_SYNTHETIC_MANIFEST_ID,
      generation: Number(process.env.ELIZA_SYNTHETIC_GENERATION),
      unexpectedRealServiceCalls: 0,
      unexpectedNetworkCalls: 0
    }],
    judgeVerdicts: [{ passed: true }]
  },
  stateDiff: { sent: true }
}));
`;

describe("scenario stability subprocess adapter", () => {
  const roots: string[] = [];
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  function root(): string {
    const value = mkdtempSync(path.join(tmpdir(), "stability-subprocess-"));
    roots.push(value);
    return value;
  }

  it("runs exactly three isolated keyless process groups over one exact manifest", async () => {
    process.env.OPENAI_API_KEY = "ambient-credential-must-not-cross";
    const outputRoot = root();
    const manifest = {
      version: 1 as const,
      namespace: "stability-test",
      manifestId: "exact-manifest-v1",
      domains: { messages: [{ id: "seed-message" }] },
    };
    let generation = 0;
    let closed = 0;
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", CHILD_SCRIPT],
      cwd: outputRoot,
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "internal-control-token",
        manifest,
      },
      mockServiceUrls: {
        ELIZA_MOCK_MESSAGES_URL: "http://127.0.0.1:43192/messages",
      },
      env: { ELIZA_TEST_PRINT_SECRETS: "1" },
      openSession: async (options) => {
        expect(options.manifest).toBe(manifest);
        generation += 1;
        return {
          manifest,
          generation,
          async execute() {
            return { manifest, messages: [{ id: "seed-message" }] };
          },
          async close() {
            closed += 1;
          },
        } as unknown as SyntheticControlSession;
      },
    });

    const report = await executeScenarioStability({
      plan: createScenarioStabilityPlan({
        runId: "keyless-process-groups",
        outputRoot,
      }),
      targets: [
        {
          scenarioId: "send-seeded-message",
          model: { provider: "deterministic", model: "strict-fixtures" },
        },
      ],
      budgets: {
        timeoutMs: 5_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 2,
      },
      adapter,
    });

    expect(generation).toBe(3);
    expect(closed).toBe(3);
    expect(report).toMatchObject({
      status: "passed",
      attemptCount: 3,
      requiredTier: "3/3",
      cells: [
        {
          firstAttemptPassed: true,
          passedAttempts: 3,
          tier: "3/3",
          strictPassed: true,
          baselineInitialStateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    const receipts = report.cells[0]?.attempts.map((attempt) =>
      attempt.evidence.providerReceipts.at(-1),
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        isolation: "subprocess-process-group",
        generation: 1,
        modelMode: "deterministic-mock",
        manifestId: "exact-manifest-v1",
      }),
      expect.objectContaining({ generation: 2 }),
      expect.objectContaining({ generation: 3 }),
    ]);
    for (const attempt of report.cells[0]?.attempts ?? []) {
      const stderr = readFileSync(
        path.join(attempt.outputDir, "subprocess.stderr.log"),
        "utf8",
      );
      expect(stderr).not.toContain("internal-control-token");
      expect(stderr).toContain("[REDACTED_SECRET]");
    }
  });

  it("kills a SIGTERM-resistant descendant group before resetting every attempt", async () => {
    const outputRoot = root();
    const manifest = {
      version: 1 as const,
      namespace: "descendant-test",
      manifestId: "descendant-test-v1",
      domains: {},
    };
    let generation = 0;
    let closed = 0;
    const descendantScript = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.ELIZA_STABILITY_OUTPUT_DIR + "/grandchild.pid", String(child.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", descendantScript],
      cwd: outputRoot,
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "internal-control-token",
        manifest,
      },
      openSession: async () => {
        generation += 1;
        return {
          manifest,
          generation,
          async execute() {
            return { ready: true };
          },
          async close() {
            closed += 1;
          },
        } as unknown as SyntheticControlSession;
      },
    });
    const plan = createScenarioStabilityPlan({
      runId: "descendant-timeout",
      outputRoot,
    });
    const report = await executeScenarioStability({
      plan,
      targets: [
        {
          scenarioId: "hang",
          model: { provider: "deterministic", model: "strict" },
        },
      ],
      budgets: {
        timeoutMs: 1_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 1,
      },
      adapter,
    });

    expect(report.cells[0]).toMatchObject({ tier: "0/3", strictPassed: false });
    expect(
      closed,
      JSON.stringify(report.cells[0]?.attempts.map((attempt) => attempt.error)),
    ).toBe(3);
    for (const attempt of report.cells[0]?.attempts ?? []) {
      const pid = Number(
        readFileSync(path.join(attempt.outputDir, "grandchild.pid"), "utf8"),
      );
      const deadline = Date.now() + 2_000;
      let absent = false;
      while (!absent && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          // error-policy:J1 ESRCH is the process-boundary's expected absence proof.
          absent = true;
        }
        if (!absent) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(absent).toBe(true);
    }
  });

  it("rejects duplicate deterministic receipts and pre-existing output symlinks", async () => {
    const outputRoot = root();
    const outside = root();
    const plan = createScenarioStabilityPlan({
      runId: "symlink-and-duplicate",
      outputRoot,
    });
    symlinkSync(outside, plan.attempts[0].outputDir);
    const manifest = {
      version: 1 as const,
      namespace: "strict-test",
      manifestId: "strict-v1",
      domains: {},
    };
    let generation = 0;
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", CHILD_SCRIPT],
      cwd: outputRoot,
      env: { ELIZA_TEST_DUPLICATE_FIXTURE: "1" },
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "token",
        manifest,
      },
      openSession: async () =>
        ({
          manifest,
          generation: ++generation,
          async execute() {
            return { ready: true };
          },
          async close() {},
        }) as unknown as SyntheticControlSession,
    });
    const report = await executeScenarioStability({
      plan,
      targets: [
        {
          scenarioId: "strict",
          model: { provider: "deterministic", model: "strict" },
        },
      ],
      budgets: {
        timeoutMs: 2_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 2,
      },
      adapter,
    });
    expect(report.cells[0]).toMatchObject({ tier: "0/3", strictPassed: false });
    expect(report.cells[0]?.attempts[0]?.error).toContain("symlink");
    expect(report.cells[0]?.attempts[1]?.error).toContain("exactly one");
  });

  it("rejects real-service credentials in keyless mock configuration", () => {
    const outputRoot = root();
    expect(
      () =>
        new ScenarioStabilitySubprocessAdapter({
          command: process.execPath,
          args: () => ["-e", CHILD_SCRIPT],
          cwd: outputRoot,
          modelMode: {
            kind: "deterministic-mock",
            fixtureManifestFingerprint: "f".repeat(64),
          },
          syntheticControl: {
            controlUrl: "http://127.0.0.1:43191",
            controlToken: "internal-control-token",
            manifest: {
              version: 1,
              namespace: "credential-test",
              manifestId: "credential-test-v1",
              domains: {},
            },
          },
          env: { SLACK_BOT_TOKEN: "must-not-be-used" },
        }),
    ).toThrow("real credential seam");
  });

  it("accepts one exact real-LLM receipt and rejects a wrong provider binding", async () => {
    for (const wrong of [false, true]) {
      const outputRoot = root();
      const manifest = {
        version: 1 as const,
        namespace: `real-${wrong}`,
        manifestId: `real-${wrong}-v1`,
        domains: {},
      };
      let generation = 0;
      const adapter = new ScenarioStabilitySubprocessAdapter({
        command: process.execPath,
        args: () => ["-e", CHILD_SCRIPT],
        cwd: outputRoot,
        modelMode: {
          kind: "real-llm",
          credentialEnv: "OPENAI_API_KEY",
          credentialValue: "dummy-model-key",
        },
        syntheticControl: {
          controlUrl: "http://127.0.0.1:43191",
          controlToken: "control-secret",
          manifest,
        },
        mockServiceUrls: {
          ELIZA_MOCK_MESSAGES_URL: "http://127.0.0.1:43192/messages",
        },
        env: {
          ELIZA_TEST_PRINT_SECRETS: "1",
          ...(wrong ? { ELIZA_TEST_WRONG_REAL: "1" } : {}),
        },
        openSession: async () =>
          ({
            manifest,
            generation: ++generation,
            async execute() {
              return { ready: true };
            },
            async close() {},
          }) as unknown as SyntheticControlSession,
      });
      const report = await executeScenarioStability({
        plan: createScenarioStabilityPlan({
          runId: `real-${wrong}`,
          outputRoot,
        }),
        targets: [
          {
            scenarioId: "live",
            model: { provider: "openai", model: "gpt-test" },
          },
        ],
        budgets: {
          timeoutMs: 2_000,
          maxInputTokens: 10,
          maxOutputTokens: 10,
          maxToolCalls: 2,
        },
        adapter,
      });
      expect(report.cells[0]?.tier).toBe(wrong ? "0/3" : "3/3");
      if (!wrong) {
        for (const attempt of report.cells[0]?.attempts ?? []) {
          const stderr = readFileSync(
            path.join(attempt.outputDir, "subprocess.stderr.log"),
            "utf8",
          );
          expect(stderr).not.toContain("dummy-model-key");
          expect(stderr).not.toContain("control-secret");
        }
      } else {
        expect(report.cells[0]?.attempts[0]?.error).toContain(
          "exact mock-world invocation receipt",
        );
      }
    }
  });

  it("allows one explicit model credential only in real-llm mode", () => {
    const outputRoot = root();
    expect(
      () =>
        new ScenarioStabilitySubprocessAdapter({
          command: process.execPath,
          args: () => ["-e", CHILD_SCRIPT],
          cwd: outputRoot,
          modelMode: {
            kind: "real-llm",
            credentialEnv: "OPENAI_API_KEY",
            credentialValue: "model-key",
          },
          syntheticControl: {
            controlUrl: "http://127.0.0.1:43191",
            controlToken: "internal-control-token",
            manifest: {
              version: 1,
              namespace: "real-model-test",
              manifestId: "real-model-test-v1",
              domains: {},
            },
          },
          mockServiceUrls: {
            ELIZA_MOCK_MESSAGES_URL: "https://real-service.example/messages",
          },
        }),
    ).toThrow("credential-free loopback HTTP URL");
  });
});
