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
 * Example: "Star Trek bridge crew" orchestration simulation.
 *
 * No external deps; the "crew" is modeled as tiny providers that can all:
 * - acknowledge
 * - report status
 * - execute a simple command ("raise shields", "set course", etc.)
 *
 * Run:
 *   bun plugins/plugin-agent-orchestrator/typescript/examples/star-trek-bridge.ts
 */

const character: Character = {
  name: "BridgeOrchestrator",
  bio: "A demo orchestrator managing a starship bridge crew.",
};

type CrewRole =
  | "captain"
  | "first-officer"
  | "helm"
  | "ops"
  | "tactical"
  | "engineering"
  | "medical";

type CrewMember = { role: CrewRole; name: string };

const CREW: readonly CrewMember[] = [
  { role: "captain", name: "Captain" },
  { role: "first-officer", name: "First Officer" },
  { role: "helm", name: "Helm" },
  { role: "ops", name: "Ops" },
  { role: "tactical", name: "Tactical" },
  { role: "engineering", name: "Engineering" },
  { role: "medical", name: "Medical" },
];

function pickRoleFromText(text: string): CrewRole {
  const t = text.toLowerCase();
  for (const c of CREW) {
    if (t.includes(c.role.replace("-", " "))) return c.role;
  }
  return "captain";
}

function basicActions(role: CrewRole, intent: string): string[] {
  const lines: string[] = [];
  lines.push(`${role.toUpperCase()}: Acknowledged.`);
  lines.push(`${role.toUpperCase()}: Status green.`);
  if (intent.trim().length > 0) {
    lines.push(`${role.toUpperCase()}: Executing: ${intent.trim()}`);
  }
  return lines;
}

function makeCrewProvider(member: CrewMember): AgentProvider {
  return {
    id: member.role,
    label: member.name,
    executeTask: async (
      task: OrchestratedTask,
      ctx: ProviderTaskExecutionContext,
    ): Promise<TaskResult> => {
      const intent = task.description ?? task.name;
      const lines = basicActions(member.role, intent);
      for (const line of lines) {
        if (ctx.isCancelled()) {
          return {
            success: false,
            summary: "cancelled",
            filesCreated: [],
            filesModified: [],
            error: "cancelled",
          };
        }
        while (ctx.isPaused()) {
          await ctx.appendOutput(`${member.name}: Paused, standing by…`);
          await new Promise<void>((r) => setTimeout(r, 200));
        }
        await ctx.appendOutput(line);
        await new Promise<void>((r) => setTimeout(r, 120));
      }

      await ctx.updateProgress(100);
      return {
        success: true,
        summary: `${member.name} completed the simulated action.`,
        filesCreated: [],
        filesModified: [],
      };
    },
  };
}

async function main(): Promise<void> {
  const providers: AgentProvider[] = CREW.map(makeCrewProvider);

  // Choose a crew member to execute tasks by setting:
  //   ORCHESTRATOR_ACTIVE_PROVIDER=engineering (or helm, tactical, etc.)
  configureAgentOrchestratorPlugin({
    providers,
    defaultProviderId: "captain",
    getWorkingDirectory: () => "USS-D/bridge",
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
    startTaskExecution: (taskId: string) => Promise<void>;
    on: (event: string, handler: (e: { type: string; taskId: string }) => void) => void;
  };

  service.on("task", (e) => {
    process.stdout.write(`[event] ${e.type} ${e.taskId.slice(0, 8)}\n`);
  });

  const role = pickRoleFromText(process.env.ORCHESTRATOR_ACTIVE_PROVIDER ?? "");
  const task = await service.createTask(
    "Bridge command",
    `Crew=${role}. Run a basic ship action: raise shields, scan, set course, or report status.`,
  );

  await service.startTaskExecution(task.id ?? "");
  await runtime.stop();
}

await main();
