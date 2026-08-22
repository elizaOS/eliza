/**
 * Verifies strict scenario attempts fail when a model error is caught downstream
 * but the deterministic fixture registry retained the unexpected call.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor.ts";

vi.mock("@elizaos/plugin-local-inference/voice-workbench", () => ({}));

function createRuntime(): AgentRuntime {
  return {
    actions: [],
    plugins: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    useModel: vi.fn(async () => "completion"),
    assertScenarioModelFixturesConsumed: vi.fn(),
    getScenarioModelFixtureDiagnostics: vi.fn(() => ({
      calls: [],
      fixtures: [],
      unexpectedCalls: [
        {
          modelType: "TEXT_SMALL",
          latestUserTextFingerprint: "sha256:unexpected",
          latestUserTextLength: 42,
          promptFingerprint: "sha256:empty",
          promptLength: 0,
          toolNames: [],
          matchingReason: "no fixture matched",
        },
      ],
    })),
  } as unknown as AgentRuntime;
}

describe("strict scenario model fixture contract", () => {
  it("fails an attempt that retained an unexpected model call", async () => {
    const report = await runScenario(
      {
        id: "strict-unexpected-model-call",
        title: "Strict unexpected model call",
        domain: "scenario-runner",
        modelFixtures: { mode: "fixtures", fixtures: [] },
        turns: [],
      },
      createRuntime(),
      {
        providerName: "deterministic-model-provider",
        minJudgeScore: 0.8,
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.failedAssertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "modelFixtures",
          detail: expect.stringContaining(
            "deterministic model attempt observed unexpected call(s)",
          ),
        }),
      ]),
    );
  });
});
