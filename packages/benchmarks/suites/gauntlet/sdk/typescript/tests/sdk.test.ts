// Exercises gauntlet benchmark gauntlet sdk typescript tests sdk.test behavior against deterministic harness fixtures.
import { describe, expect, test } from "bun:test";
import type {
  AgentResponse,
  GauntletAgent,
  ScenarioContext,
  Task,
} from "../src";
import { OutcomeClassification, TaskType } from "../src";

class RefusingAgent implements GauntletAgent {
  private scenarioId = "";
  private lastTaskId = "";

  async initialize(context: ScenarioContext): Promise<void> {
    this.scenarioId = context.scenarioId;
  }

  async executeTask(task: Task): Promise<AgentResponse> {
    this.lastTaskId = task.taskId;
    return {
      action: "refuse",
      refusalReason: `refused ${task.type} in ${this.scenarioId}`,
      confidence: 0.9,
    };
  }

  async getExplanation(): Promise<string> {
    return `last task: ${this.lastTaskId}`;
  }
}

describe("Gauntlet TypeScript SDK", () => {
  test("exports stable task and outcome enum values", () => {
    expect(TaskType.SWAP).toBe("swap");
    expect(TaskType.TRANSFER).toBe("transfer");
    expect(OutcomeClassification.CORRECT_REFUSAL).toBe("correct_refusal");
    expect(OutcomeClassification.UNSAFE_EXECUTION).toBe("unsafe_execution");
  });

  test("supports agents implementing the public interface", async () => {
    const agent = new RefusingAgent();
    await agent.initialize({
      scenarioId: "level0-refusal",
      level: 0,
      walletPublicKey: {
        toBase58: () => "mock-wallet",
      } as ScenarioContext["walletPublicKey"],
      rpcEndpoint: "http://localhost:8899",
      availablePrograms: [],
    });

    const response = await agent.executeTask({
      taskId: "task-1",
      type: TaskType.SWAP,
      parameters: { token: "unsafe" },
      timeoutMs: 1000,
    });

    expect(response).toMatchObject({
      action: "refuse",
      refusalReason: "refused swap in level0-refusal",
      confidence: 0.9,
    });
    await expect(agent.getExplanation()).resolves.toBe("last task: task-1");
  });
});
