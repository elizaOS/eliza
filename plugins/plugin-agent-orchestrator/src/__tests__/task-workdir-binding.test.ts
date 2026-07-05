/**
 * Proves the durable task→workdir binding (#13776 item 3): the workdir resolved
 * at a task's FIRST spawn is pinned on the task record and every follow-up spawn
 * of that task reuses it deterministically — even when routing env changes
 * between spawns — while an explicit caller workdir still wins and re-pins the
 * binding. Drives the REAL `OrchestratorTaskService.spawnAgentForTask` over an
 * in-memory store with a workdir-capturing ACP (no coding-agent subprocess).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type { SpawnOptions, SpawnResult } from "../services/types.js";

/** ACP stand-in that records the workdir each spawn was handed and echoes it
 * back as the session's landed workdir (what AcpService does when the caller
 * passes a concrete, non-isolated workdir). */
function makeWorkdirCapturingAcp() {
  let counter = 0;
  const spawns: Array<{ sessionId: string; workdir: string | undefined }> = [];
  const service = {
    onSessionEvent() {
      return () => undefined;
    },
    sendToSession: async () => ({ stopReason: "end_turn", finalText: "ok" }),
    stopSession: async () => undefined,
    getChangedPaths: () => [],
    getSession: async () => undefined,
    updateSessionMetadata: async () => undefined,
    spawnSession: async (opts: SpawnOptions): Promise<SpawnResult> => {
      counter += 1;
      const sessionId = `binding-spawn-${counter}`;
      spawns.push({ sessionId, workdir: opts.workdir });
      return {
        sessionId,
        id: sessionId,
        name: opts.name ?? `binding-${counter}`,
        agentType: opts.agentType ?? "opencode",
        // Echo the requested workdir back as the landed workdir; the default
        // stands in for AcpService's own fallback when none was supplied.
        workdir: opts.workdir ?? "/acp/default/dir",
        status: "ready",
        metadata: { ...(opts.metadata ?? {}) },
      };
    },
  };
  return { service, spawns };
}

function makeRuntime(acpService: unknown): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000abc",
    character: { name: "Binder" },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === AcpService.serviceType ? acpService : undefined,
    useModel: async () => "{}",
  } as never;
}

let tmpRoot: string;
let firstDir: string;
let overrideDir: string;
let savedWorkspaceRoot: string | undefined;

beforeEach(() => {
  // realpath the root so expected paths match resolveAllowedWorkdir's
  // canonicalized output (macOS resolves /var → /private/var).
  tmpRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "task-workdir-binding-")),
  );
  firstDir = path.join(tmpRoot, "repo-a");
  overrideDir = path.join(tmpRoot, "repo-b");
  mkdirSync(firstDir, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  // resolveAllowedWorkdir only accepts dirs under a configured workspace root
  // (or ~/.eliza/workspaces / cwd); point it at our tmp root so the explicit
  // workdirs below pass the allow-list probe.
  savedWorkspaceRoot = process.env.ELIZA_ACP_WORKSPACE_ROOT;
  process.env.ELIZA_ACP_WORKSPACE_ROOT = tmpRoot;
});

afterEach(() => {
  if (savedWorkspaceRoot === undefined)
    delete process.env.ELIZA_ACP_WORKSPACE_ROOT;
  else process.env.ELIZA_ACP_WORKSPACE_ROOT = savedWorkspaceRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function seedTask(store: OrchestratorTaskStore): Promise<string> {
  const detail = await store.createTask({
    title: "Bindable task",
    goal: "do the work in one stable place",
    acceptanceCriteria: [],
    roomId: "binding-room",
    worldId: "binding-world",
  });
  return detail.task.id;
}

describe("durable task→workdir binding (#13776)", () => {
  it("pins the first spawn's workdir and reuses it for a no-workdir follow-up even after routing env changes", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const acp = makeWorkdirCapturingAcp();
    const service = new OrchestratorTaskService(makeRuntime(acp.service), {
      store,
    });
    await service.start();
    try {
      const taskId = await seedTask(store);

      // First spawn lands in firstDir and pins the binding.
      await service.spawnAgentForTask(taskId, { workdir: firstDir });
      expect(acp.spawns.at(0)?.workdir).toBe(firstDir);
      const afterFirst = await store.getTask(taskId);
      expect(afterFirst?.task.boundWorkdir).toBe(firstDir);

      // Routing env changes between sessions — a stateless re-resolution would
      // now drift the follow-up elsewhere. Point the (unrelated) default root at
      // overrideDir to make any drift visible.
      process.env.ELIZA_ACP_WORKSPACE_ROOT = overrideDir;

      // Follow-up spawn with NO explicit workdir must reuse the pinned binding.
      await service.spawnAgentForTask(taskId, { task: "keep going" });
      expect(acp.spawns.at(1)?.workdir).toBe(firstDir);
      const afterFollowUp = await store.getTask(taskId);
      expect(afterFollowUp?.task.boundWorkdir).toBe(firstDir);
      process.env.ELIZA_ACP_WORKSPACE_ROOT = tmpRoot;
    } finally {
      await service.stop().catch(() => undefined);
    }
  });

  it("does not let a stale first-spawn binding overwrite an earlier successful binding", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const acp = makeWorkdirCapturingAcp();
    const service = new OrchestratorTaskService(makeRuntime(acp.service), {
      store,
    });
    await service.start();
    try {
      const taskId = await seedTask(store);
      const stale = (await store.getTask(taskId))?.task;
      expect(stale).toBeTruthy();
      if (!stale) throw new Error("seeded task was not persisted");
      const bindTaskWorkdir = (
        service as unknown as {
          bindTaskWorkdir: (
            taskId: string,
            current: typeof stale,
            workdir: string,
            repo: string | undefined,
          ) => Promise<void>;
        }
      ).bindTaskWorkdir.bind(service);

      await bindTaskWorkdir(taskId, stale, overrideDir, undefined);
      await bindTaskWorkdir(taskId, stale, firstDir, undefined);

      expect((await store.getTask(taskId))?.task.boundWorkdir).toBe(
        overrideDir,
      );
    } finally {
      await service.stop().catch(() => undefined);
    }
  });

  it("lets an explicit override win and re-pins the binding (surfaced on the task DTO)", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const acp = makeWorkdirCapturingAcp();
    const service = new OrchestratorTaskService(makeRuntime(acp.service), {
      store,
    });
    await service.start();
    try {
      const taskId = await seedTask(store);

      await service.spawnAgentForTask(taskId, { workdir: firstDir });
      const boundFirst = await service.getTask(taskId);
      expect(boundFirst?.latestWorkdir).toBe(firstDir);

      // Explicit override on a later spawn wins and re-pins.
      const detail = await service.spawnAgentForTask(taskId, {
        workdir: overrideDir,
        repo: "https://example.com/repo-b.git",
      });
      expect(acp.spawns.at(1)?.workdir).toBe(overrideDir);
      expect(detail?.latestWorkdir).toBe(overrideDir);
      expect(detail?.latestRepo).toBe("https://example.com/repo-b.git");

      const record = await store.getTask(taskId);
      expect(record?.task.boundWorkdir).toBe(overrideDir);
      expect(record?.task.boundRepo).toBe("https://example.com/repo-b.git");
    } finally {
      await service.stop().catch(() => undefined);
    }
  });

  it("clears the old repo binding when an explicit workdir override omits repo", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const acp = makeWorkdirCapturingAcp();
    const service = new OrchestratorTaskService(makeRuntime(acp.service), {
      store,
    });
    await service.start();
    try {
      const taskId = await seedTask(store);

      await service.spawnAgentForTask(taskId, {
        workdir: firstDir,
        repo: "https://example.com/repo-a.git",
      });
      expect((await service.getTask(taskId))?.latestRepo).toBe(
        "https://example.com/repo-a.git",
      );

      const detail = await service.spawnAgentForTask(taskId, {
        workdir: overrideDir,
      });

      expect(acp.spawns.at(1)?.workdir).toBe(overrideDir);
      expect(detail?.latestWorkdir).toBe(overrideDir);
      expect(detail?.latestRepo).toBeNull();

      const record = await store.getTask(taskId);
      expect(record?.task.boundWorkdir).toBe(overrideDir);
      expect(record?.task.boundRepo).toBeNull();
    } finally {
      await service.stop().catch(() => undefined);
    }
  });

  it("binds from attachSession for chat-action-spawned first sessions", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const acp = makeWorkdirCapturingAcp();
    const service = new OrchestratorTaskService(makeRuntime(acp.service), {
      store,
    });
    await service.start();
    try {
      const taskId = await seedTask(store);

      // The TASKS:create action spawns directly via AcpService then binds the
      // session through attachSession — that first attach must pin the binding.
      await service.attachSession(taskId, {
        sessionId: "chat-action-session",
        agentType: "codex",
        workdir: firstDir,
        status: "stopped",
      });
      const record = await store.getTask(taskId);
      expect(record?.task.boundWorkdir).toBe(firstDir);

      // A follow-up spawn with no workdir reuses the attach-pinned binding.
      await service.spawnAgentForTask(taskId, { task: "continue" });
      expect(acp.spawns.at(0)?.workdir).toBe(firstDir);
    } finally {
      await service.stop().catch(() => undefined);
    }
  });
});
