/**
 * Pins the `failed` task-lifecycle producer and the legal-transition table
 * (#13771). Drives the real ACP→task event bridge on an in-memory store: an
 * unrecoverable session `error` must advance the durable task to terminal
 * `failed`, a resumable `session_state_lost` must NOT (the router re-spawns it),
 * and `advanceTaskStatus` must reject transitions the table forbids. The table
 * predicate itself is also unit-tested directly.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  isLegalTaskStatusTransition,
  type OrchestratorTaskStatus,
} from "../../src/services/orchestrator-task-types.js";

// The default-criteria contract would auto-populate acceptance criteria and
// change the validating/completion path; disable it so these tasks exercise the
// plain criteria-free lifecycle this suite targets.
beforeAll(() => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});

interface SpawnResult {
  sessionId: string;
  agentType: string;
  workdir: string;
  status: string;
}

/** Minimal AcpService stand-in that captures the orchestrator's session-event
 * subscription so a test can drive real events through the bridge. */
class FakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  private counter = 0;
  readonly stopped: string[] = [];

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handler = cb;
    return () => {
      this.handler = null;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }

  spawnSession(opts: Record<string, unknown>): Promise<SpawnResult> {
    this.counter += 1;
    return Promise.resolve({
      sessionId: `session-${this.counter}`,
      agentType: (opts.agentType as string | undefined) ?? "codex",
      workdir: (opts.workdir as string | undefined) ?? "/repo",
      status: "ready",
    });
  }

  sendToSession(): Promise<void> {
    return Promise.resolve();
  }

  stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
    return Promise.resolve();
  }
}

const warn = vi.fn();

function runtime(acp?: FakeAcp): IAgentRuntime {
  return {
    getService: () => acp ?? null,
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
  } as never;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function drive(
  acp: FakeAcp,
  sessionId: string,
  event: string,
  data: unknown = {},
): Promise<void> {
  acp.emit(sessionId, event, data);
  await flush();
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function withSpawnedSession(): Promise<{
  service: OrchestratorTaskService;
  store: OrchestratorTaskStore;
  acp: FakeAcp;
  taskId: string;
  sessionId: string;
}> {
  const acp = new FakeAcp();
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const service = new OrchestratorTaskService(runtime(acp), { store });
  await service.start();
  const task = await service.createTask({
    title: "Ship feature",
    goal: "Implement and verify",
  });
  const detail = must(
    await service.spawnAgentForTask(task.id),
    "expected spawn detail",
  );
  const sessionId = must(detail.sessions[0], "expected session").sessionId;
  return { service, store, acp, taskId: task.id, sessionId };
}

describe("orchestrator task `failed` producer (#13771)", () => {
  it("drives the durable task to terminal `failed` on an unrecoverable session error", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    expect((await service.getTask(taskId))?.status).toBe("active");

    await drive(acp, sessionId, "error", {
      failureKind: "crash",
      message: "sub-agent process exited with code 1",
    });

    const detail = must(await service.getTask(taskId), "detail");
    expect(detail.status).toBe("failed");
    expect(must(detail.sessions[0], "session").status).toBe("errored");
  });

  it("does NOT fail the task on a resumable `session_state_lost` — the router re-spawns it", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();

    await drive(acp, sessionId, "error", {
      failureKind: "session_state_lost",
      message: "session state lost mid-turn",
    });

    const detail = must(await service.getTask(taskId), "detail");
    // Session is marked errored/stopped, but the TASK stays non-terminal so the
    // router's deterministic respawn path can recover it.
    expect(detail.status).toBe("active");
    expect(must(detail.sessions[0], "session").status).toBe("errored");
  });

  it("marks failed even for an auth failure (no respawn producer exists for it)", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();

    await drive(acp, sessionId, "error", {
      failureKind: "auth",
      message: "401 unauthorized",
    });

    expect((await service.getTask(taskId))?.status).toBe("failed");
  });
});

describe("legal task-status transition table (#13771)", () => {
  it("permits `failed` from every non-terminal working state and `done` only from validating", () => {
    const nonTerminal: OrchestratorTaskStatus[] = [
      "open",
      "active",
      "waiting_on_user",
      "blocked",
      "validating",
      "interrupted",
    ];
    for (const from of nonTerminal) {
      expect(isLegalTaskStatusTransition(from, "failed")).toBe(true);
    }
    expect(isLegalTaskStatusTransition("validating", "done")).toBe(true);
    expect(isLegalTaskStatusTransition("active", "done")).toBe(false);
    expect(isLegalTaskStatusTransition("open", "done")).toBe(false);
  });

  it("forbids any transition out of a terminal status", () => {
    for (const from of ["done", "failed", "archived"] as const) {
      for (const to of ["active", "failed", "done", "open"] as const) {
        expect(isLegalTaskStatusTransition(from, to)).toBe(false);
      }
    }
  });

  it("advanceTaskStatus rejects an illegal transition, logs a warning, and leaves the task unchanged", async () => {
    const { service, taskId } = await withSpawnedSession();
    expect((await service.getTask(taskId))?.status).toBe("active");
    warn.mockClear();

    // `active → done` is not modeled (done is validating-only); the private
    // status funnel is the real enforcement point, so drive it directly.
    await (
      service as unknown as {
        advanceTaskStatus: (
          id: string,
          next: OrchestratorTaskStatus,
        ) => Promise<void>;
      }
    ).advanceTaskStatus(taskId, "done");

    expect((await service.getTask(taskId))?.status).toBe("active");
    expect(warn).toHaveBeenCalledWith(
      "[OrchestratorTaskService] rejected illegal task status transition",
      expect.objectContaining({ from: "active", to: "done" }),
    );
  });
});
