/**
 * Cancellation semantics for TASKS reads and spawn commit ownership.
 * Deterministic unit tests only: no subprocess, provider, or network access.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TASKS turn cancellation", () => {
  it("releases a pending read without emitting a late visible callback", async () => {
    const sessions = deferred<never[]>();
    const service = serviceMock({
      listSessions: vi.fn(() => sessions.promise),
    });
    const cb = callback();
    const controller = new AbortController();
    const reason = new Error("voice read superseded");

    const pending = tasksAction.handler(
      runtimeWith(service),
      memory({ text: "Which task agents are running?" }),
      state,
      {
        parameters: { action: "list_agents" },
        abortSignal: controller.signal,
      },
      cb,
    );
    await vi.waitFor(() => expect(service.listSessions).toHaveBeenCalledOnce());

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cb).not.toHaveBeenCalled();

    // The service has no cancellable read API. Its detached completion remains
    // observed and harmless after the caller has already been released.
    sessions.resolve([]);
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });

  it("aborts during spawn admission with no room or session mutation", async () => {
    const occupied = {
      id: "occupied-session",
      agentType: "codex",
      workdir: "/tmp/occupied",
      status: "running",
      approvalPreset: "standard",
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
    };
    const service = serviceMock({ listSessions: vi.fn(() => [occupied]) });
    const runtime = runtimeWith(service) as IAgentRuntime & {
      createRoom?: ReturnType<typeof vi.fn>;
    };
    runtime.getSetting = vi.fn((key: string) =>
      key === "ELIZA_MAX_CONCURRENT_SPAWNS" ? "1" : undefined,
    );
    runtime.createRoom = vi.fn();
    const controller = new AbortController();
    const reason = new Error("voice turn cancelled before task commit");

    const pending = tasksAction.handler(
      runtime,
      memory({ text: "Inspect the authentication regression" }),
      state,
      {
        parameters: {
          action: "spawn_agent",
          task: "Inspect the authentication regression",
        },
        abortSignal: controller.signal,
      },
      callback(),
    );
    await vi.waitFor(() => expect(service.listSessions).toHaveBeenCalled());

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(runtime.createRoom).not.toHaveBeenCalled();
    expect(service.spawnSession).not.toHaveBeenCalled();
  });

  it("settles one authoritative receipt when interruption follows spawn commit", async () => {
    const spawn = deferred<{
      sessionId: string;
      id: string;
      name: string;
      agentType: "codex";
      workdir: string;
      status: "ready";
      metadata: Record<string, unknown>;
    }>();
    const service = serviceMock({ spawnSession: vi.fn(() => spawn.promise) });
    const controller = new AbortController();
    const originalTask = "Inspect the first user's authentication regression";

    const pending = tasksAction.handler(
      runtimeWith(service),
      memory({ text: originalTask }),
      state,
      {
        parameters: { action: "spawn_agent", task: originalTask },
        abortSignal: controller.signal,
      },
      callback(),
    );
    await vi.waitFor(() => expect(service.spawnSession).toHaveBeenCalledOnce());
    const spawnOptions = vi.mocked(service.spawnSession).mock.calls[0]?.[0];
    expect(spawnOptions?.initialTask).toContain(originalTask);

    controller.abort(new Error("voice turn interrupted after provider commit"));
    spawn.resolve({
      sessionId: "committed-session",
      id: "committed-session",
      name: "auth-audit",
      agentType: "codex",
      workdir: process.cwd(),
      status: "ready",
      metadata: (spawnOptions?.metadata ?? {}) as Record<string, unknown>,
    });

    const result = await pending;
    expect(service.spawnSession).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      continueChain: false,
      data: { sessionId: "committed-session", status: "ready" },
      effectReceipts: [
        {
          operation: "agent-orchestrator.tasks.spawn_agent",
          outcome: "applied",
          resource: { kind: "acp.session", id: "committed-session" },
          commit: {
            kind: "provider_accepted",
            id: "committed-session",
          },
        },
      ],
    });
    expect(result?.effectReceipts).toHaveLength(1);
  });
});
