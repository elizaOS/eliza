/**
 * Verifies TaskSupervisorService digest sinks (#8902 AC2).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type { Content, IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { TaskSupervisorService } from "../services/task-supervisor-service.ts";

function makeRuntime(
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID },
    content: Content,
  ) => Promise<unknown>,
): IAgentRuntime {
  const taskService = {
    listTasks: vi.fn(async () => [
      {
        id: "task-1",
        title: "ship Telegram board",
        status: "active",
        activeSessionCount: 1,
        latestSessionLabel: "codex",
      },
    ]),
    getTaskOriginTarget: vi.fn(async () => ({
      roomId: "00000000-0000-4000-8000-000000000890" as UUID,
      source: "telegram",
    })),
  };
  return {
    getSetting: () => undefined,
    getService: (serviceType: string) =>
      serviceType === "ORCHESTRATOR_TASK_SERVICE" ? taskService : undefined,
    sendMessageToTarget,
  } as unknown as IAgentRuntime;
}

describe("TaskSupervisorService digest sinks (#8902 AC2)", () => {
  it("lets a source-specific sink handle changed digests instead of sending a plain message", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const service = new TaskSupervisorService(makeRuntime(sendMessageToTarget));
    const sink = vi.fn(async () => true);

    service.registerDigestSink("telegram", sink);
    const result = await service.runOnce();

    expect(result.posted).toEqual(["00000000-0000-4000-8000-000000000890"]);
    expect(sink).toHaveBeenCalledWith(
      {
        source: "telegram",
        roomId: "00000000-0000-4000-8000-000000000890",
      },
      expect.objectContaining({
        source: "telegram",
        text: expect.stringContaining("ship Telegram board"),
      }),
    );
    expect(sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("falls back to runtime delivery when a sink declines the target", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const service = new TaskSupervisorService(makeRuntime(sendMessageToTarget));
    const sink = vi.fn(async () => false);

    service.registerDigestSink("telegram", sink);
    await service.runOnce();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sendMessageToTarget).toHaveBeenCalledWith(
      {
        source: "telegram",
        roomId: "00000000-0000-4000-8000-000000000890",
      },
      expect.objectContaining({ source: "telegram" }),
    );
  });

  it("tries later source sinks before falling back to runtime delivery", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const service = new TaskSupervisorService(makeRuntime(sendMessageToTarget));
    const firstSink = vi.fn(async () => false);
    const secondSink = vi.fn(async () => true);

    service.registerDigestSink("telegram", firstSink);
    service.registerDigestSink("telegram", secondSink);
    await service.runOnce();

    expect(firstSink).toHaveBeenCalledTimes(1);
    expect(secondSink).toHaveBeenCalledTimes(1);
    expect(sendMessageToTarget).not.toHaveBeenCalled();
  });
});
