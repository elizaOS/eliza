import { AgentRuntime, type Character } from "@elizaos/core";
import {
  type AgentProvider,
  agentOrchestratorPlugin,
  configureAgentOrchestratorPlugin,
  type OrchestratedTask,
  type ProviderTaskExecutionContext,
  type TaskResult,
} from "../index.js";

/**
 * Example: Spin up a small "agent team" with zero external deps.
 *
 * Run from repo root (after installing deps):
 *   bun plugins/plugin-agent-orchestrator/typescript/examples/agent-team.ts
 */

const character: Character = {
  name: "OrchestratorDemo",
  bio: "A demo orchestrator that delegates tasks to tiny local providers.",
};

function makeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeToyProvider(id: string, label: string): AgentProvider {
  return {
    id,
    label,
    executeTask: async (
      task: OrchestratedTask,
      ctx: ProviderTaskExecutionContext,
    ): Promise<TaskResult> => {
      await ctx.appendOutput(`[${label}] received task: ${task.name}`);

      const steps = task.metadata.steps;
      if (steps.length === 0) {
        await ctx.appendOutput(`[${label}] no steps; doing a quick simulated run`);
      }

      for (let i = 0; i < Math.max(1, steps.length); i += 1) {
        while (ctx.isPaused()) {
          await ctx.appendOutput(`[${label}] paused…`);
          await makeSleep(250);
        }
        if (ctx.isCancelled()) {
          return {
            success: false,
            summary: "cancelled",
            filesCreated: [],
            filesModified: [],
            error: "cancelled",
          };
        }
        await makeSleep(150);
        await ctx.updateProgress(((i + 1) / Math.max(1, steps.length)) * 100);
      }

      return {
        success: true,
        summary: `[${label}] done (simulated)`,
        filesCreated: [],
        filesModified: [],
      };
    },
  };
}

async function main(): Promise<void> {
  const providers: AgentProvider[] = [
    makeToyProvider("planner", "Planner"),
    makeToyProvider("executor", "Executor"),
    makeToyProvider("reviewer", "Reviewer"),
  ];

  configureAgentOrchestratorPlugin({
    providers,
    defaultProviderId: "planner",
    getWorkingDirectory: () => process.cwd(),
    activeProviderEnvVar: "ORCHESTRATOR_ACTIVE_PROVIDER",
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [agentOrchestratorPlugin],
    logLevel: "info",
  });

  await runtime.initialize();

  const svc = runtime.getService("CODE_TASK");
  if (!svc) throw new Error("CODE_TASK service missing");

  const service = svc as {
    createTask: (name: string, desc: string) => Promise<{ id?: string }>;
    addStep: (taskId: string, description: string) => Promise<void>;
    startTaskExecution: (taskId: string) => Promise<void>;
    on: (event: string, handler: (e: { type: string; taskId: string }) => void) => void;
  };

  service.on("task", (e) => {
    process.stdout.write(`[event] ${e.type} ${e.taskId.slice(0, 8)}\n`);
  });

  const t = await service.createTask("Demo task", "Demonstrate orchestration");
  const id = t.id ?? "";
  await service.addStep(id, "Step 1: plan");
  await service.addStep(id, "Step 2: execute");
  await service.addStep(id, "Step 3: review");

  await service.startTaskExecution(id);
  await runtime.stop();
}

await main();
