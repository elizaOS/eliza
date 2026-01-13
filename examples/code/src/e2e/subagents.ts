import { initializeAgent, shutdownAgent } from "../lib/agent.js";
import type { CodeTaskService } from "../plugin/services/code-task.js";
import type { SubAgentType } from "../types.js";

type RunResult = {
  type: SubAgentType;
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function logLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function runOne(service: CodeTaskService, type: SubAgentType): Promise<RunResult> {
  const task = await service.createCodeTask(
    `E2E: ${type}`,
    [
      `E2E sanity check for sub-agent "${type}".`,
      "",
      "Requirements:",
      "- Run a simple, safe command to confirm the environment (e.g. `pwd` and `git status --porcelain`).",
      "- Do NOT modify files.",
      "- Return DONE with a short summary of what you verified.",
    ].join("\n"),
    undefined,
    type,
  );

  const taskId = task.id ?? "";
  if (!taskId) {
    throw new Error(`Failed to create task for ${type}`);
  }

  logLine(`[${nowIso()}] starting ${type} task ${taskId}`);
  await service.startTaskExecution(taskId);

  const finished = await service.getTask(taskId);
  const status = finished?.metadata.status;
  const result = finished?.metadata.result;

  if (!finished || !status || !result) {
    return {
      type,
      taskId,
      status: "failed",
      summary: "Missing task metadata after execution",
    };
  }

  if (status === "completed") {
    return { type, taskId, status, summary: result.summary };
  }
  if (status === "cancelled") {
    return { type, taskId, status, summary: result.summary };
  }

  return {
    type,
    taskId,
    status: "failed",
    summary: result.error ?? result.summary,
  };
}

function getRunnableTypes(): SubAgentType[] {
  // SDK workers require provider-specific API keys; still include them, but skip
  // when keys are missing so this script can run in a local environment without
  // configuring every provider.
  const types: SubAgentType[] = [
    "eliza",
    "elizaos-native",
    "opencode",
    "sweagent",
    "codex",
    "claude-code",
  ];

  const openai = process.env.OPENAI_API_KEY?.trim();
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  const provider = (process.env.ELIZA_CODE_PROVIDER ?? "").trim().toLowerCase();

  return types.filter((t) => {
    if (t === "codex") return Boolean(openai);
    if (t === "claude-code") return Boolean(anthropic);

    // If a provider is explicitly selected, require that key for runtime-based workers too.
    if (provider === "openai") return Boolean(openai);
    if (provider === "anthropic") return Boolean(anthropic);

    // Otherwise, allow if either key is present (runtime will choose).
    return Boolean(openai || anthropic);
  });
}

async function main(): Promise<void> {
  const runtime = await initializeAgent();
  try {
    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
    if (!service) {
      throw new Error("CodeTaskService not available");
    }

    const runnable = getRunnableTypes();
    if (runnable.length === 0) {
      throw new Error(
        "No runnable sub-agents (set OPENAI_API_KEY and/or ANTHROPIC_API_KEY).",
      );
    }

    logLine(`[${nowIso()}] running e2e sub-agent checks: ${runnable.join(", ")}`);

    const results: RunResult[] = [];
    for (const type of runnable) {
      results.push(await runOne(service, type));
    }

    logLine("");
    logLine("=== Results ===");
    for (const r of results) {
      logLine(`- ${r.type}: ${r.status} (${r.taskId}) — ${r.summary}`);
    }

    const failed = results.filter((r) => r.status !== "completed");
    if (failed.length > 0) {
      process.exitCode = 1;
      logLine("");
      logLine(`FAILED: ${failed.length} sub-agent(s) did not complete`);
    } else {
      logLine("");
      logLine("OK: all sub-agents completed");
    }
  } finally {
    await shutdownAgent(runtime);
  }
}

await main();

