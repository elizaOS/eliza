import { afterEach, describe, expect, mock, test } from "bun:test";

const configureTrainingDependencies = mock(() => {});
const agentService = { createAgent: mock(async () => ({ id: "agent-1" })) };
const agentRuntimeManager = { getRuntime: mock(async () => ({})) };
const autonomousCoordinator = {
  executeAutonomousTick: mock(async () => ({ success: true })),
};

mock.module("@feed/training/rubrics/index", () => ({
  getAvailableArchetypes: () => ["trader"],
  getPriorityMetrics: () => [],
  getRubric: () => "rubric",
  hasCustomRubric: () => true,
}));

mock.module("@feed/training", () => ({
  configureTrainingDependencies,
}));

mock.module("@feed/agents", () => ({
  agentService,
  agentRuntimeManager,
  autonomousCoordinator,
}));

describe("configureAgentTrainingDependencies", () => {
  afterEach(() => {
    configureTrainingDependencies.mockClear();
  });

  test("registers live agent dependencies for parallel generation", async () => {
    const { configureAgentTrainingDependencies } = await import(
      "../commands/train.ts?train-parallel-deps"
    );

    await configureAgentTrainingDependencies();

    expect(configureTrainingDependencies).toHaveBeenCalledTimes(1);
    expect(configureTrainingDependencies).toHaveBeenCalledWith({
      agentService,
      agentRuntimeManager,
      autonomousCoordinator,
    });
  });
});
