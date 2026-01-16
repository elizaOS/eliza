import { v4 as uuidv4 } from "uuid";
import { describe, expect, test } from "vitest";
import type { PlanningService } from "../advanced-planning";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, State, UUID } from "../types";
import { ModelType } from "../types";

const asTestUuid = (id: string): UUID => id as UUID;

function makeMemory(text: string): Memory {
  return {
    id: asTestUuid(uuidv4()),
    entityId: asTestUuid(uuidv4()),
    agentId: asTestUuid(uuidv4()),
    roomId: asTestUuid(uuidv4()),
    content: { text },
    createdAt: Date.now(),
  };
}

function makeState(): State {
  return { values: {}, data: {}, text: "" };
}

describe("advanced planning (built-in)", () => {
  test("auto-loads provider + planning service when enabled", async () => {
    const character: Character = {
      name: "AdvPlanning",
      bio: "Test",
      advancedPlanning: true,
      plugins: [],
    };

    const runtime = new AgentRuntime({ character });

    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async () =>
        [
          "COMPLEXITY: medium",
          "PLANNING: sequential_planning",
          "CAPABILITIES: analysis",
          "STAKEHOLDERS: engineering",
          "CONSTRAINTS: time",
          "DEPENDENCIES: none",
          "CONFIDENCE: 0.9",
        ].join("\n"),
      "test",
      10,
    );

    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () =>
        [
          "<plan>",
          "<goal>Do thing</goal>",
          "<execution_model>sequential</execution_model>",
          "<steps>",
          "<step>",
          "<id>step_1</id>",
          "<action>ANALYZE_INPUT</action>",
          '<parameters>{"goal":"Do thing"}</parameters>',
          "<dependencies>[]</dependencies>",
          "</step>",
          "</steps>",
          "<estimated_duration>12345</estimated_duration>",
          "</plan>",
        ].join("\n"),
      "test",
      10,
    );

    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    // Provider registered
    expect(runtime.providers.some((p) => p.name === "messageClassifier")).toBe(
      true,
    );

    // Service registered
    const svc = (await runtime.getServiceLoadPromise(
      "planning",
    )) as PlanningService;
    expect(runtime.hasService("planning")).toBe(true);

    // Actions registered
    expect(runtime.actions.some((a) => a.name === "ANALYZE_INPUT")).toBe(true);

    // Provider behavior (parses planningRequired)
    const provider = runtime.providers.find(
      (p) => p.name === "messageClassifier",
    );
    if (!provider) throw new Error("Expected messageClassifier provider");
    const msg = makeMemory("Please plan a small project");
    const providerResult = await provider.get(runtime, msg, makeState());
    expect(providerResult.data?.planningRequired).toBe(true);

    // Service behavior (simple plan)
    const simplePlan = await svc.createSimplePlan(
      runtime,
      makeMemory("email the team"),
      makeState(),
    );
    expect(simplePlan?.steps.length).toBeGreaterThan(0);

    // Service behavior (comprehensive plan)
    const plan = await svc.createComprehensivePlan(runtime, {
      goal: "Do thing",
      constraints: [],
      availableActions: ["ANALYZE_INPUT"],
      preferences: { executionModel: "sequential", maxSteps: 3 },
    });
    expect(plan.steps.length).toBe(1);
    // Note: planning may degrade unknown actions to REPLY as a safety fallback.
    expect(["ANALYZE_INPUT", "REPLY"]).toContain(plan.steps[0]?.actionName);
  });

  test("does not load when disabled", async () => {
    const character: Character = {
      name: "AdvPlanningOff",
      bio: "Test",
      advancedPlanning: false,
      plugins: [],
    };

    const runtime = new AgentRuntime({ character });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    expect(runtime.hasService("planning")).toBe(false);
    expect(runtime.providers.some((p) => p.name === "messageClassifier")).toBe(
      false,
    );
  });
});
