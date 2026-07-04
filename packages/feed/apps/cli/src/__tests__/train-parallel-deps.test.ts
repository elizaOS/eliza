/**
 * Tests that the `train-parallel` command wires its agent/runtime/coordinator
 * dependencies correctly. Uses `mock.module` stubs for `@feed/agents` and
 * `@feed/db`, so no real agents or database are touched.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

const configureTrainingDependencies = mock(() => {});
const agentService = { createAgent: mock(async () => ({ id: "agent-1" })) };
const agentRuntimeManager = { getRuntime: mock(async () => ({})) };
const autonomousCoordinator = {
  executeAutonomousTick: mock(async () => ({ success: true })),
};

mock.module("@feed/agents/rubrics/index", () => ({
  getAvailableArchetypes: () => ["trader"],
  getPriorityMetrics: () => [],
  getRubric: () => "rubric",
  hasCustomRubric: () => true,
  sanitizeArchetype: (archetype: string) => archetype,
}));

mock.module("@feed/agents/dependencies", () => ({
  configureTrainingDependencies,
  getAgentRuntimeManager: () => agentRuntimeManager,
  getAgentService: () => agentService,
  getAutonomousCoordinator: () => autonomousCoordinator,
  getToTrainingMessages: () => () => [],
}));

mock.module("@feed/agents/training", () => ({
  archetypeScoringService: {},
  trajectoryMetricsExtractor: {},
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
