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

  /** Start with an invalid value and return the rejection. */
  async function startWith(raw: string): Promise<unknown> {
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    try {
      await TaskSupervisorService.start(
        makeRuntime(undefined, {
          ELIZA_ORCHESTRATOR_SUPERVISOR_INTERVAL_MS: raw,
        }),
      );
      return { armed: spy.mock.calls.length };
    } catch (err) {
      return { error: err, armed: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }

  it("uses the documented default when the setting is absent or blank", async () => {
    expect(await armedIntervalMs("")).toBe(45_000);
    expect(await armedIntervalMs("   ")).toBe(45_000);
  });

  it("rejects a trailing-garbage interval and arms no timer", async () => {
    // parseInt("12000junk") is 12000, which clears MIN_INTERVAL_MS, so a
    // typo silently swept every 12s instead of 45s — 3.75x the load.
    const outcome = (await startWith("12000junk")) as {
      error?: { code?: string };
      armed: number;
    };
    expect(outcome.error?.code).toBe(
      "ORCHESTRATOR_SUPERVISOR_INTERVAL_INVALID",
    );
    expect(outcome.armed).toBe(0);
  });

  it("rejects a value below the documented minimum", async () => {
    const outcome = (await startWith("1000")) as { error?: { code?: string } };
    expect(outcome.error?.code).toBe(
      "ORCHESTRATOR_SUPERVISOR_INTERVAL_INVALID",
    );
  });

  it("accepts the exact timer maximum and rejects one above it", async () => {
    // Node clamps a delay above the 32-bit signed max to 1ms, which would
    // sweep continuously instead of on a schedule.
    expect(await armedIntervalMs("2147483647")).toBe(2_147_483_647);
    const outcome = (await startWith("2147483648")) as {
      error?: { code?: string };
    };
    expect(outcome.error?.code).toBe(
      "ORCHESTRATOR_SUPERVISOR_INTERVAL_INVALID",
    );
  });

  it("rejects a fractional and an unsafe-range interval", async () => {
    for (const raw of ["12000.5", "9007199254740993"]) {
      const outcome = (await startWith(raw)) as { error?: { code?: string } };
      expect(outcome.error?.code).toBe(
        "ORCHESTRATOR_SUPERVISOR_INTERVAL_INVALID",
      );
    }
  });

  it("still honours a clean interval, including a signed one", async () => {
    expect(await armedIntervalMs("12000")).toBe(12_000);
    // `parseInt` accepted "+12000"; rejecting it would be a regression.
    expect(await armedIntervalMs("+12000")).toBe(12_000);
  });
});
