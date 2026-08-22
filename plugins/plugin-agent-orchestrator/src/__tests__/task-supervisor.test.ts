/**
 * Verifies TaskSupervisorService digest sinks (#8902 AC2).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type {
  Content,
  IAgentRuntime,
  SendHandlerResult,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { TaskSupervisorService } from "../services/task-supervisor-service.ts";

function makeRuntime(
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID },
    content: Content,
  ) => SendHandlerResult,
  settings: Record<string, string> = {},
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
    getSetting: (key: string) => settings[key],
    getService: (serviceType: string) =>
      serviceType === "ORCHESTRATOR_TASK_SERVICE" ? taskService : undefined,
    sendMessageToTarget,
  } as unknown as IAgentRuntime;
}

describe("TaskSupervisorService digest sinks (#8902 AC2)", () => {
  const confirmedSend = () => ({
    kind: "delivered" as const,
    receipt: {
      providerMessageIds: ["supervisor-message-1"] as [string],
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted" as const, memoryIds: [] },
    },
    memories: [],
  });

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
    const sendMessageToTarget = vi.fn(async () => confirmedSend());
    const service = new TaskSupervisorService(makeRuntime(sendMessageToTarget));
    const sink = vi.fn(async () => false);

    service.registerDigestSink("telegram", sink);
    const result = await service.runOnce();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(result.posted).toEqual(["00000000-0000-4000-8000-000000000890"]);
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

  it("does not mark a digest posted when runtime delivery is unconfirmed", async () => {
    const service = new TaskSupervisorService(
      makeRuntime(vi.fn(async () => undefined)),
    );

    await expect(service.runOnce()).resolves.toEqual({
      posted: [],
      skipped: [],
    });
  });
});

describe("TaskSupervisorService sweep interval parsing", () => {
  /** Capture the delay the supervisor arms its sweep timer with. */
  async function armedIntervalMs(raw: string): Promise<number> {
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    try {
      const service = await TaskSupervisorService.start(
        makeRuntime(undefined, {
          ELIZA_ORCHESTRATOR_SUPERVISOR_INTERVAL_MS: raw,
        }),
      );
      await service.stop();
      return spy.mock.calls[0]?.[1] as number;
    } finally {
      spy.mockRestore();
    }
  }

  it("ignores a trailing-garbage interval instead of sweeping on its prefix", async () => {
    // parseInt("12000junk") is 12000, which clears MIN_INTERVAL_MS, so a typo
    // silently swept every 12s instead of the 45s default — 3.75x the load.
    expect(await armedIntervalMs("12000junk")).toBe(45_000);
  });

  it("still honours a clean interval with an explicit leading plus", async () => {
    expect(await armedIntervalMs("12000")).toBe(12_000);
    // `parseInt` accepted "+12000"; rejecting it would be a regression.
    expect(await armedIntervalMs("+12000")).toBe(12_000);
  });

  it("falls back for an interval beyond the safe integer range", async () => {
    expect(await armedIntervalMs("9007199254740993")).toBe(45_000);
  });

  it("enforces the timer runtime's minimum and maximum delays", async () => {
    expect(await armedIntervalMs("4999")).toBe(45_000);
    expect(await armedIntervalMs("5000")).toBe(5_000);
    expect(await armedIntervalMs("2147483647")).toBe(2_147_483_647);
    expect(await armedIntervalMs("2147483648")).toBe(45_000);
  });
});
