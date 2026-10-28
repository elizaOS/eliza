/**
 * TASKS stop_agent / cancel without an explicit session id must act on the
 * sub-agent that is still running, not on a finished session that merely has
 * newer activity. Drives the real TASKS handler over the real AcpService and a
 * fake acpx CLI whose prompt turns hang until killed.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hardenIncomingUserMessage,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
  validateToolArgs,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskOperationSchemaOverrides } from "../actions/task-operation-schemas.ts";
import { tasksAction } from "../actions/tasks.ts";
import { AcpService } from "../services/acp-service.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import { CodingWorkspaceService } from "../services/workspace-service.ts";

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

describe("TASKS control / share default target", () => {
  it("control stop without a session id ends the running sub-agent", async () => {
    await withRunningAndFinished("control-stop", async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "control",
        controlAction: "stop",
      });

      expect(result?.success).toBe(true);
      expect((await ctx.service.getSession(ctx.runningId))?.status).toBe(
        "stopped",
      );
    });
  }, 20_000);

  it("share without a session id reports the running sub-agent", async () => {
    await withRunningAndFinished("share", async (ctx) => {
      const result = await runTasks(ctx.runtime, { action: "share" });

      expect(result?.success).toBe(true);
      expect(
        (result?.data as { sessionId?: string } | undefined)?.sessionId,
      ).toBe(ctx.runningId);
    });
  }, 20_000);
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

describe("TASKS session-only operations refuse a task id", () => {
  for (const selector of ["taskId", "threadId"] as const) {
    it(`stop_agent with ${selector} stops nothing`, async () => {
      await withTaskAndNewerSession(async (ctx) => {
        const result = await runTasks(ctx.runtime, {
          action: "stop_agent",
          [selector]: ctx.taskId,
        });

        expect(result).toMatchObject({
          success: false,
          error: "SESSION_ID_REQUIRED",
        });
        expect((await ctx.service.getSession(ctx.taskSessionId))?.status).toBe(
          "busy",
        );
        expect((await ctx.service.getSession(ctx.newerSessionId))?.status).toBe(
          "busy",
        );
      });
    }, 20_000);
  }

  it("send with taskId sends nothing to the newest session", async () => {
    await withTaskAndNewerSession(async (ctx) => {
      const sent: string[] = [];
      const sendToSession = ctx.service.sendToSession.bind(ctx.service);
      ctx.service.sendToSession = async (sessionId, input) => {
        sent.push(sessionId);
        return sendToSession(sessionId, input);
      };
      const result = await runTasks(ctx.runtime, {
        action: "send",
        taskId: ctx.taskId,
        input: "also add tests",
      });

      expect(result).toMatchObject({
        success: false,
        error: "SESSION_ID_REQUIRED",
      });
      expect(sent).toEqual([]);
    });
  }, 20_000);

  it("stop_agent with sessionId and taskId still stops that session", async () => {
    await withTaskAndNewerSession(async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "stop_agent",
        sessionId: ctx.taskSessionId,
        taskId: ctx.taskId,
      });

      expect(result?.success).toBe(true);
      expect((await ctx.service.getSession(ctx.taskSessionId))?.status).toBe(
        "stopped",
      );
      expect((await ctx.service.getSession(ctx.newerSessionId))?.status).toBe(
        "busy",
      );
    });
  }, 20_000);
});

describe("TASKS control resume with an instruction and no running session", () => {
  it("reports that the instruction was not delivered", async () => {
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
    try {
      const task = await store.createTask({
        title: "Paused task",
        goal: "finish the long build",
        acceptanceCriteria: [],
        roomId: "target-room",
        worldId: "target-world",
      });
      await tasks.pauseTask(task.task.id);

      const result = await runTasks(runtime, {
        action: "control",
        controlAction: "resume",
        taskId: task.task.id,
        instruction: "also add tests",
      });

      expect(result?.success).toBe(true);
      expect(result?.text).toContain("NOT delivered");
      expect(result?.userFacingText).toContain("was not delivered");
      expect(result?.data).toMatchObject({
        taskId: task.task.id,
        instruction: "also add tests",
        instructionDelivered: false,
      });

      // Without an explicit instruction the plain resume reply is unchanged.
      await tasks.pauseTask(task.task.id);
      const plain = await runTasks(runtime, {
        action: "control",
        controlAction: "resume",
        taskId: task.task.id,
      });
      expect(plain?.text).toBe(`Resumed coding task ${task.task.id}`);
    } finally {
      await service.stop();
    }
  }, 20_000);
});

describe("resumeTask after a failed re-engage spawn", () => {
  it("keeps the re-engage for the next resume", async () => {
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
    const live = async (taskId: string) =>
      (await store.getTask(taskId))?.sessions.filter(
        (s) => s.status !== "stopped",
      ) ?? [];
    try {
      const task = await store.createTask({
        title: "Interrupted task",
        goal: "finish the long build",
        acceptanceCriteria: [],
        roomId: "target-room",
        worldId: "target-world",
      });
      const taskId = task.task.id;
      await tasks.spawnAgentForTask(taskId);
      await tasks.pauseTask(taskId);
      expect(await live(taskId)).toEqual([]);

      // The coding CLI cannot start a session (for example, it lost its login).
      await writeFile(
        cliPath,
        '#!/usr/bin/env node\nprocess.stderr.write("not authenticated\\n");\nprocess.exit(1);\n',
      );
      await expect(tasks.resumeTask(taskId)).rejects.toThrow();
      expect(await live(taskId)).toEqual([]);

      // After the CLI works again, resume must start the interrupted work.
      await writeFile(cliPath, FAKE_ACPX);
      await tasks.resumeTask(taskId);
      expect(await live(taskId)).toHaveLength(1);
      expect(
        (await store.getTask(taskId))?.task.metadata?.pausedWithActiveWork,
      ).toBeUndefined();

      // A completed re-engage is not repeated by another resume.
      await tasks.resumeTask(taskId);
      expect(await live(taskId)).toHaveLength(1);
    } finally {
      await service.stop();
    }
  }, 30_000);
});

describe("postUserMessage to a paused task", () => {
  it("records the message without starting a worker before resume", async () => {
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
    const live = async (taskId: string) =>
      (await store.getTask(taskId))?.sessions.filter(
        (s) => s.status !== "stopped",
      ) ?? [];
    try {
      const task = await store.createTask({
        title: "Paused with a message",
        goal: "finish the long build",
        acceptanceCriteria: [],
        roomId: "target-room",
        worldId: "target-world",
      });
      const taskId = task.task.id;
      await tasks.spawnAgentForTask(taskId);
      await tasks.pauseTask(taskId);

      const result = await tasks.postUserMessage(
        taskId,
        "also update the README",
      );
      expect(result?.recorded).toBe(true);
      expect(result?.forwardedTo).toEqual([]);
      expect(result?.failedTo.map((failure) => failure.sessionId)).toEqual([
        "(paused)",
      ]);
      expect(await live(taskId)).toEqual([]);

      // Resume starts exactly one worker for the interrupted work.
      await tasks.resumeTask(taskId);
      expect(await live(taskId)).toHaveLength(1);
    } finally {
      await service.stop();
    }
  }, 30_000);
});

describe("resumeTask after a repeated pause", () => {
  it("still starts the interrupted work", async () => {
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
    const live = async (taskId: string) =>
      (await store.getTask(taskId))?.sessions.filter(
        (s) => s.status !== "stopped",
      ) ?? [];
    try {
      const task = await store.createTask({
        title: "Paused twice",
        goal: "finish the long build",
        acceptanceCriteria: [],
        roomId: "target-room",
        worldId: "target-world",
      });
      const taskId = task.task.id;
      await tasks.spawnAgentForTask(taskId);
      await tasks.pauseTask(taskId);
      // "pause it" again: every session is already stopped.
      await tasks.pauseTask(taskId);
      expect(await live(taskId)).toEqual([]);

      await tasks.resumeTask(taskId);
      expect(await live(taskId)).toHaveLength(1);
    } finally {
      await service.stop();
    }
  }, 30_000);
});

describe("TASKS history with a task id", () => {
  async function withTwoTasks(
    body: (ctx: {
      runtime: IAgentRuntime;
      olderId: string;
      newerId: string;
    }) => Promise<void>,
  ): Promise<void> {
    let tasks: OrchestratorTaskService | undefined;
    const runtime = runtimeWith(
      () => undefined,
      () => tasks,
    );
    const store = new OrchestratorTaskStore({ backend: "memory" });
    tasks = new OrchestratorTaskService(runtime, { store });
    const base = {
      goal: "finish the build",
      acceptanceCriteria: [],
      roomId: "target-room",
      worldId: "target-world",
    };
    const older = await store.createTask({ ...base, title: "Older task" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await store.createTask({ ...base, title: "Newest task" });
    await body({ runtime, olderId: older.task.id, newerId: newer.task.id });
  }

  for (const selector of ["taskId", "threadId"] as const) {
    it(`detail with ${selector} describes that task, not the newest one`, async () => {
      await withTwoTasks(async (ctx) => {
        const args = {
          action: "history",
          metric: "detail",
          [selector]: ctx.olderId,
        };
        expect(validateToolArgs(tasksAction, args).errors).toEqual([]);

        const result = await runTasks(ctx.runtime, args);

        expect(result?.success).toBe(true);
        expect(result?.text).toContain('"Older task"');
        expect(result?.text).not.toContain("Newest task");
        expect(result?.data).toMatchObject({
          count: 1,
          taskIds: [ctx.olderId],
          filters: { taskId: ctx.olderId },
        });
      });
    });
  }

  it("an unknown taskId is an error, not the full list", async () => {
    await withTwoTasks(async (ctx) => {
      const result = await runTasks(ctx.runtime, {
        action: "history",
        taskId: "no-such-task",
      });

      expect(result).toMatchObject({ success: false, error: "TASK_NOT_FOUND" });
      expect(result?.text).not.toContain("Newest task");
    });
  });
});

describe("TASKS history with the archived status", () => {
  async function withArchivedTask(
    body: (ctx: {
      runtime: IAgentRuntime;
      archivedId: string;
    }) => Promise<void>,
  ): Promise<void> {
    let tasks: OrchestratorTaskService | undefined;
    const runtime = runtimeWith(
      () => undefined,
      () => tasks,
    );
    const store = new OrchestratorTaskStore({ backend: "memory" });
    tasks = new OrchestratorTaskService(runtime, { store });
    const base = {
      goal: "finish the build",
      acceptanceCriteria: [],
      roomId: "target-room",
      worldId: "target-world",
    };
    const archived = await store.createTask({ ...base, title: "Shelved task" });
    await store.createTask({ ...base, title: "Live task" });
    await tasks.archiveTask(archived.task.id);
    await body({ runtime, archivedId: archived.task.id });
  }

  for (const extra of [{}, { includeArchived: false }]) {
    it(`statuses=[archived] with ${JSON.stringify(extra)} lists the archived task`, async () => {
      await withArchivedTask(async (ctx) => {
        const args = { action: "history", statuses: ["archived"], ...extra };
        expect(validateToolArgs(tasksAction, args).errors).toEqual([]);

        const result = await runTasks(ctx.runtime, args);

        expect(result?.success).toBe(true);
        expect(result?.text).toContain("Shelved task");
        expect(result?.data).toMatchObject({
          count: 1,
          taskIds: [ctx.archivedId],
        });
      });
    });
  }

  it("history without the archived status still hides archived tasks", async () => {
    await withArchivedTask(async (ctx) => {
      const result = await runTasks(ctx.runtime, { action: "history" });

      expect(result?.success).toBe(true);
      expect(result?.text).toContain("Live task");
      expect(result?.text).not.toContain("Shelved task");
    });
  });
});

describe("TASKS history day windows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("today and yesterday follow the asker's calendar, not the host's", async () => {
    let tasks: OrchestratorTaskService | undefined;
    const base = runtimeWith(
      () => undefined,
      () => tasks,
    );
    const runtime = {
      ...base,
      getSetting: (key: string) =>
        key === "TIMEZONE" ? "America/Los_Angeles" : base.getSetting(key),
    } as IAgentRuntime;
    const store = new OrchestratorTaskStore({ backend: "memory" });
    tasks = new OrchestratorTaskService(runtime, { store });
    vi.useFakeTimers({ toFake: ["Date"] });
    // 10:00 in Los Angeles on 2026-10-24.
    vi.setSystemTime(new Date("2026-10-24T17:00:00.000Z"));
    const created = await store.createTask({
      goal: "finish the build",
      acceptanceCriteria: [],
      roomId: "target-room",
      worldId: "target-world",
      title: "Morning task",
    });
    // 18:00 in Los Angeles on the same day; already 2026-10-25 in UTC.
    vi.setSystemTime(new Date("2026-10-25T01:00:00.000Z"));

    const today = await runTasks(runtime, {
      action: "history",
      window: "today",
    });
    expect(today?.success).toBe(true);
    expect(today?.data).toMatchObject({
      count: 1,
      taskIds: [created.task.id],
    });
    expect(today?.text).toContain("2026-10-24 through 2026-10-24");

    const yesterday = await runTasks(runtime, {
      action: "history",
      window: "yesterday",
    });
    expect(yesterday?.success).toBe(true);
    expect(yesterday?.data).toMatchObject({ count: 0 });
    expect(yesterday?.text).toContain("2026-10-23 through 2026-10-23");
  });
});

describe("TASKS create with lane ordering and no lane planner", () => {
  async function createWith(extra: Record<string, unknown>) {
    let service: AcpService | undefined;
    const runtime = runtimeWith(() => service);
    service = new AcpService(runtime);
    await service.start();
    try {
      const parameters = {
        action: "create",
        agents:
          "build the REST API in src/api | write integration tests against the API in test/api",
        workdir,
        ...extra,
      };
      expect(validateToolArgs(tasksAction, parameters).errors).toEqual([]);
      const result = await tasksAction.handler(
        runtime,
        {
          content: {
            text: "Build the REST API in src/api, then write integration tests against it in test/api.",
            source: "chat",
          },
        } as unknown as Memory,
        undefined,
        { parameters },
        async () => [],
      );
      return { result, sessions: await service.listSessions() };
    } finally {
      await service.stop();
    }
  }

  it.each([[{ dependencies: { "lane-2": ["lane-1"] } }], [{ maxParallel: 1 }]])(
    "%o starts nothing and says why",
    async (extra) => {
      const { result, sessions } = await createWith(extra);

      expect(result).toMatchObject({
        success: false,
        error: "LANE_PLANNER_UNAVAILABLE",
      });
      expect(sessions).toEqual([]);
    },
  );
});

describe("TASKS manage_issues bulk create on an external message", () => {
  it("creates one issue per user list item and none from the security envelope", async () => {
    let workspace: CodingWorkspaceService | undefined;
    const base = runtimeWith(() => undefined);
    const runtime = {
      ...base,
      // Operator policy that lets a Discord sender use task agents.
      getSetting: (key: string) =>
        key === "TASK_AGENT_ROLE_POLICY"
          ? JSON.stringify({ connectors: { discord: "GUEST" } })
          : base.getSetting(key),
      getService: (type: string) =>
        type === "CODING_WORKSPACE_SERVICE" ? (workspace ?? null) : null,
    } as unknown as IAgentRuntime;
    workspace = new CodingWorkspaceService(runtime, { baseDir: workdir });
    const titles: string[] = [];
    workspace.createIssue = async (_repo, options) => {
      titles.push(options.title);
      return {
        number: titles.length,
        title: options.title,
        body: options.body ?? "",
        state: "open",
        labels: [],
        url: `https://github.com/acme/api/issues/${titles.length}`,
      } as Awaited<ReturnType<CodingWorkspaceService["createIssue"]>>;
    };
    const message = {
      content: {
        text: "File these on acme/api:\n1. Login button is broken\n2. Add dark mode",
        source: "discord",
      },
    } as unknown as Memory;
    hardenIncomingUserMessage(message);
    expect(message.content.text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    const parameters = {
      action: "manage_issues",
      issueAction: "create",
      repo: "acme/api",
    };
    expect(validateToolArgs(tasksAction, parameters).errors).toEqual([]);

    const result = await tasksAction.handler(
      runtime,
      message,
      undefined,
      { parameters },
      async () => [],
    );

    expect(result?.success).toBe(true);
    expect(titles).toEqual(["Login button is broken", "Add dark mode"]);
  });
});

describe("TASKS object parameters accept the shapes the handler reads", () => {
  const children = promoteSubactionsToActions(tasksAction, {
    overrides: taskOperationSchemaOverrides(tasksAction),
  });
  const child = (name: string) => {
    const action = children.find((candidate) => candidate.name === name);
    if (!action) throw new Error(`missing promoted action ${name}`);
    return action;
  };

  it("TASKS accepts a lane dependency graph", () => {
    expect(
      validateToolArgs(tasksAction, {
        action: "create",
        task: "x",
        agents: "a | b",
        dependencies: { "lane-2": ["lane-1"] },
      }).errors,
    ).toEqual([]);
    expect(
      validateToolArgs(tasksAction, {
        action: "create",
        task: "x",
        dependencies: { "lane-2": "lane-1" },
      }).valid,
    ).toBe(false);
  });

  it("TASKS_CREATE accepts a verifier and metadata", () => {
    expect(
      validateToolArgs(child("TASKS_CREATE"), {
        task: "x",
        validator: {
          service: "app-verification",
          method: "verifyApp",
          params: { workdir: "/w" },
        },
        maxRetries: 2,
        onVerificationFail: "retry",
        metadata: { source: "y" },
      }).errors,
    ).toEqual([]);
  });

  it("TASKS_SPAWN_AGENT accepts metadata and TASKS_SEND does not declare it", () => {
    expect(
      validateToolArgs(child("TASKS_SPAWN_AGENT"), {
        task: "x",
        metadata: { source: "y" },
      }).errors,
    ).toEqual([]);
    expect(
      child("TASKS_SEND").parameters?.map((parameter) => parameter.name),
    ).not.toContain("metadata");
  });
});

// Native ACP agent whose prompt turns hang until session/cancel.
const HANG_NATIVE_AGENT = `import { createInterface } from "node:readline";
const pending = new Map();
let n = 0;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ id: msg.id, result: { sessionId: "s" + ++n } });
  if (msg.method === "session/prompt") return void pending.set(msg.params.sessionId, msg.id);
  if (msg.method === "session/cancel") {
    const id = pending.get(msg.params.sessionId);
    pending.delete(msg.params.sessionId);
    if (id !== undefined) send({ id, result: { stopReason: "cancelled" } });
    return;
  }
  if (msg.id !== undefined && msg.method) send({ id: msg.id, result: {} });
});
`;

describe("TASKS cancel on the native transport", () => {
  it("cancels every task when one sub-agent is waiting between turns", async () => {
    const agentPath = path.join(workdir, "hang-acp-agent.mjs");
    await writeFile(agentPath, HANG_NATIVE_AGENT);
    let service: AcpService | undefined;
    const values: Record<string, string> = {
      ELIZA_ACP_TRANSPORT: "native",
      ELIZA_ACP_NO_TERMINAL: "true",
      ELIZA_ELIZAOS_ACP_COMMAND: `node ${agentPath}`,
    };
    const runtime = {
      ...runtimeWith(() => service),
      getSetting: (key: string) => values[key],
    } as IAgentRuntime;
    service = new AcpService(runtime);
    await service.start();
    try {
      const idle = await service.spawnSession({
        agentType: "elizaos",
        workdir,
        approvalPreset: "permissive",
      });
      const busy = await service.spawnSession({
        agentType: "elizaos",
        workdir,
        approvalPreset: "permissive",
      });
      const turn = service.sendPrompt(busy.sessionId, "long build");
      await waitForStatus(service, busy.sessionId, "busy");

      const result = await tasksAction.handler(
        runtime,
        {
          id: "00000000-0000-4000-8000-0000000000aa",
          entityId: "00000000-0000-4000-8000-0000000000bb",
          roomId: "00000000-0000-4000-8000-0000000000cc",
          content: { text: "cancel all tasks" },
        } as unknown as Memory,
        undefined,
        { parameters: { action: "cancel", all: true } },
        async () => [],
      );
      turn.catch(() => undefined);

      expect({
        success: result?.success,
        idle: (await service.getSession(idle.sessionId))?.status,
        busy: (await service.getSession(busy.sessionId))?.status,
      }).toEqual({ success: true, idle: "stopped", busy: "cancelled" });
    } finally {
      await service.stop();
    }
  });
});
