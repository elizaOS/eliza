/**
 * Exercises the production stability process-group adapter with real child
 * processes and an injected deterministic control-session boundary. No child
 * process or environment transport is mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
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
const hash = "a".repeat(64);
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
    }] : [],
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
      openSession: async (options) => {
        expect(options.manifest).toBe(manifest);
        generation += 1;
        return {
          manifest,
          generation,
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
          baselineInitialStateHash: "a".repeat(64),
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
