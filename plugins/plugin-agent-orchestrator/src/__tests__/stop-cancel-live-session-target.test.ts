/**
 * TASKS stop_agent / cancel without an explicit session id must act on the
 * sub-agent that is still running, not on a finished session that merely has
 * newer activity. Drives the real TASKS handler over the real AcpService and a
 * fake acpx CLI whose prompt turns hang until killed.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";
import { AcpService } from "../services/acp-service.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";

const FAKE_ACPX = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("prompt")) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it" } } },
  }) + "\\n");
  setTimeout(() => {}, 600000);
} else {
  process.exit(0);
}
`;

let workdir: string;
let cliPath: string;

function runtimeWith(
  getAcp: () => AcpService | undefined,
  getTasks: () => OrchestratorTaskService | undefined = () => undefined,
): IAgentRuntime {
  const values: Record<string, string> = {
    ELIZA_ACP_TRANSPORT: "cli",
    ELIZA_ACP_CLI: cliPath,
    ELIZA_ELIZAOS_ACP_COMMAND: "eliza-code-acp",
  };
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (key: string) => values[key],
    getService: (type: string) =>
      type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
        ? (getAcp() ?? null)
        : type === OrchestratorTaskService.serviceType
          ? (getTasks() ?? null)
          : null,
    hasService: () => false,
    services: new Map(),
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

async function waitForStatus(
  service: AcpService,
  sessionId: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await service.getSession(sessionId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${sessionId} never reached ${status}`);
}

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "tasks-stop-target-"));
  cliPath = path.join(workdir, "fake-acpx.mjs");
  await writeFile(cliPath, FAKE_ACPX);
  await chmod(cliPath, 0o755);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function withRunningAndFinished(
  label: string,
  body: (ctx: {
    runtime: IAgentRuntime;
    service: AcpService;
    runningId: string;
    finishedId: string;
  }) => Promise<void>,
): Promise<void> {
  let service: AcpService | undefined;
  const runtime = runtimeWith(() => service);
  service = new AcpService(runtime);
  await service.start();
  let turn: Promise<unknown> | undefined;
  let runningId: string | undefined;
  try {
    const running = await service.spawnSession({
      name: `running-${label}`,
      agentType: "codex",
      workdir,
    });
    const finished = await service.spawnSession({
      name: `finished-${label}`,
      agentType: "codex",
      workdir,
    });
    runningId = running.sessionId;
    turn = service.sendPrompt(running.sessionId, "long build");
    await waitForStatus(service, running.sessionId, "busy");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.stopSession(finished.sessionId);
    await body({
      runtime,
      service,
      runningId: running.sessionId,
      finishedId: finished.sessionId,
    });
  } finally {
    if (runningId) await service.stopSession(runningId).catch(() => {});
    await turn;
    await service.stop();
  }
}

function runTasks(runtime: IAgentRuntime, parameters: Record<string, unknown>) {
  return tasksAction.handler(
    runtime,
    {
      content: { text: "stop the coding agent", source: "chat" },
    } as unknown as Memory,
    undefined,
    { parameters },
    async () => [],
  );
}

describe("TASKS stop_agent / cancel default target", () => {
  for (const op of ["stop_agent", "cancel"] as const) {
    const endedStatus = op === "cancel" ? "cancelled" : "stopped";

    it(`${op} without a session id ends the running sub-agent, not a finished one`, async () => {
      await withRunningAndFinished(op, async (ctx) => {
        const result = await runTasks(ctx.runtime, { action: op });

        expect(result?.success).toBe(true);
        expect(
          (result?.data as { sessionId?: string } | undefined)?.sessionId,
        ).toBe(ctx.runningId);
        expect((await ctx.service.getSession(ctx.runningId))?.status).toBe(
          endedStatus,
        );
        expect((await ctx.service.getSession(ctx.finishedId))?.status).toBe(
          "stopped",
        );
      });
    }, 20_000);

    it(`${op} all ends only the running sub-agents`, async () => {
      await withRunningAndFinished(`${op}-all`, async (ctx) => {
        const result = await runTasks(ctx.runtime, { action: op, all: true });

        expect(result?.success).toBe(true);
        expect(result?.data).toMatchObject(
          op === "cancel"
            ? { canceledCount: 1, stoppedSessions: [ctx.runningId] }
            : { stoppedCount: 1 },
        );
        expect((await ctx.service.getSession(ctx.runningId))?.status).toBe(
          endedStatus,
        );
        expect((await ctx.service.getSession(ctx.finishedId))?.status).toBe(
          "stopped",
        );
      });
    }, 20_000);
  }
});

/**
 * Two sub-agents run at once. The older one belongs to a durable task; the
 * newer one does not. A task id must select the older one.
 */
async function withTaskAndNewerSession(
  body: (ctx: {
    runtime: IAgentRuntime;
    service: AcpService;
    taskId: string;
    taskSessionId: string;
    newerSessionId: string;
  }) => Promise<void>,
): Promise<void> {
  let service: AcpService | undefined;
  let tasks: OrchestratorTaskService | undefined;
  const runtime = runtimeWith(
    () => service,
    () => tasks,
  );
  service = new AcpService(runtime);
  await service.start();
  const store = new OrchestratorTaskStore({ backend: "memory" });
  tasks = new OrchestratorTaskService(runtime, { store });
  const turns: Promise<unknown>[] = [];
  const ids: string[] = [];
  try {
    const owned = await service.spawnSession({
      name: "task-owned",
      agentType: "codex",
      workdir,
    });
    ids.push(owned.sessionId);
    turns.push(service.sendPrompt(owned.sessionId, "long build"));
    await waitForStatus(service, owned.sessionId, "busy");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newer = await service.spawnSession({
      name: "unrelated",
      agentType: "codex",
      workdir,
    });
    ids.push(newer.sessionId);
    turns.push(service.sendPrompt(newer.sessionId, "other work"));
    await waitForStatus(service, newer.sessionId, "busy");

    const task = await store.createTask({
      title: "Owned task",
      goal: "finish the long build",
      acceptanceCriteria: [],
      roomId: "target-room",
      worldId: "target-world",
    });
    await tasks.attachSession(task.task.id, {
      sessionId: owned.sessionId,
      agentType: "codex",
      workdir,
      status: "busy",
    });
    await body({
      runtime,
      service,
      taskId: task.task.id,
      taskSessionId: owned.sessionId,
      newerSessionId: newer.sessionId,
    });
  } finally {
    for (const id of ids) await service.stopSession(id).catch(() => {});
    await Promise.all(turns);
    await service.stop();
  }
}

describe("TASKS task id selects that task's session", () => {
  it("cancel with threadId ends the task's sub-agent, not the newest one", async () => {
    await withTaskAndNewerSession(async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "cancel",
        threadId: ctx.taskId,
      });

      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({
        threadId: ctx.taskId,
        stoppedSessions: [ctx.taskSessionId],
      });
      expect((await ctx.service.getSession(ctx.taskSessionId))?.status).toBe(
        "cancelled",
      );
      expect((await ctx.service.getSession(ctx.newerSessionId))?.status).toBe(
        "busy",
      );
    });
  }, 20_000);

  it("cancel with an unknown taskId cancels nothing", async () => {
    await withTaskAndNewerSession(async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "cancel",
        taskId: "no-such-task",
      });

      expect(result).toMatchObject({ success: false, error: "TASK_NOT_FOUND" });
      expect((await ctx.service.getSession(ctx.taskSessionId))?.status).toBe(
        "busy",
      );
      expect((await ctx.service.getSession(ctx.newerSessionId))?.status).toBe(
        "busy",
      );
    });
  }, 20_000);

  it("control stop with taskId stops the task's sub-agent, not the newest one", async () => {
    await withTaskAndNewerSession(async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "control",
        controlAction: "stop",
        taskId: ctx.taskId,
      });

      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({
        sessionId: ctx.taskSessionId,
        taskId: ctx.taskId,
      });
      expect((await ctx.service.getSession(ctx.taskSessionId))?.status).toBe(
        "stopped",
      );
      expect((await ctx.service.getSession(ctx.newerSessionId))?.status).toBe(
        "busy",
      );
    });
  }, 20_000);

  it("share with threadId reports the task's session", async () => {
    await withTaskAndNewerSession(async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "share",
        threadId: ctx.taskId,
      });

      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({ sessionId: ctx.taskSessionId });
    });
  }, 20_000);
});
