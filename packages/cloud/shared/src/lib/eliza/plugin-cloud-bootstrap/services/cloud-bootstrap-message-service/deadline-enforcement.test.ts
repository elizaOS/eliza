// Regression coverage for the CloudBootstrapMessageService deadline (#25109):
// the configured timeout must settle handleMessage even when the RUN_TIMEOUT
// lifecycle emission never settles or rejects. The service runs real; only the
// runtime surface is stubbed; composeState stalls before any model call.
import { describe, expect, it } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { drainPostDeliveryTasks, EventType } from "@elizaos/core";
import { CloudBootstrapMessageService } from "./service";

function message(): Memory {
  return {
    id: "00000000-0000-4000-8000-00000000a001",
    entityId: "00000000-0000-4000-8000-00000000a002",
    roomId: "00000000-0000-4000-8000-00000000a003",
    agentId: "00000000-0000-4000-8000-00000000a004",
    content: { text: "hello" },
  } as unknown as Memory;
}

type EmitLog = Array<{ event: string; settle: "pending" | "reject" | "resolve" }>;

function stubRuntime(emitLog: EmitLog, mode: "pending" | "reject"): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-00000000a004",
    character: { name: "Agent" },
    getSetting: () => null,
    getMemoryById: async () => null,
    createMemory: async () => "00000000-0000-4000-8000-00000000a010",
    queueEmbeddingGeneration: async () => undefined,
    getParticipantUserState: async () => null,
    // A DM room keeps shouldRespond on the synchronous fast path; the turn
    // then stalls inside composeState, exactly the in-flight shape #25109
    // describes when the deadline must fire.
    getRoom: async () => ({
      id: "00000000-0000-4000-8000-00000000a003",
      type: "DM",
      source: "client_chat",
    }),
    composeState: async () =>
      new Promise(() => {
        // The stalled processing continuation — never settles.
      }),
    startRun: () => "00000000-0000-4000-8000-00000000a0f0",
    emitEvent: async (event: string) => {
      emitLog.push({ event, settle: mode });
      if (event === EventType.RUN_TIMEOUT) {
        if (mode === "reject") {
          throw new Error("emission listener exploded");
        }
        // Pending forever: exactly the stalled-listener shape from #25109.
        return new Promise<void>(() => {});
      }
      // All other lifecycle emissions behave like a healthy runtime.
    },
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

async function expectTimeoutSettles(mode: "pending" | "reject"): Promise<EmitLog> {
  const emitLog: EmitLog = [];
  const service = new CloudBootstrapMessageService();
  const runtime = stubRuntime(emitLog, mode);

  let settled: "timeout" | "other" | "none" = "none";
  const run = service.handleMessage(runtime, message(), undefined, { timeoutDuration: 30 }).then(
    (result) => ((settled = "other"), result),
    (error) => ((settled = "timeout"), error),
  );
  await run;
  expect(settled).toBe("timeout");
  return emitLog;
}

describe("CloudBootstrapMessageService deadline enforcement", () => {
  it("enforces the deadline when RUN_TIMEOUT emission stays pending", async () => {
    const emitLog = await expectTimeoutSettles("pending");
    expect(emitLog.some(({ event }) => event === EventType.RUN_TIMEOUT)).toBe(true);
    expect(emitLog.some(({ event }) => event === EventType.RUN_ENDED)).toBe(true);
  }, 10_000);

  it("enforces the deadline when RUN_TIMEOUT emission rejects", async () => {
    const emitLog = await expectTimeoutSettles("reject");
    expect(emitLog.some(({ event }) => event === EventType.RUN_TIMEOUT)).toBe(true);
  }, 10_000);
  it("does not resume inference or deliver after a timed-out compose settles", async () => {
    const events: EmitLog = [];
    const runtime = stubRuntime(events, "pending");
    let resume!: (state: { values: {}; data: {}; text: string }) => void;
    runtime.composeState = () =>
      new Promise((resolve) => {
        resume = resolve;
      });
    let models = 0;
    runtime.useModel = async () => {
      models++;
      throw new Error("late inference");
    };
    let replies = 0;
    const service = new CloudBootstrapMessageService();
    await expect(
      service.handleMessage(
        runtime,
        message(),
        async () => {
          replies++;
          return [];
        },
        { timeoutDuration: 10 },
      ),
    ).rejects.toThrow("Run exceeded timeout");
    resume({ values: {}, data: {}, text: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await drainPostDeliveryTasks(runtime);
    expect(models).toBe(0);
    expect(replies).toBe(0);
    expect(events.filter(({ event }) => event === EventType.RUN_ENDED)).toHaveLength(1);
  });

  it("honors caller cancellation while composeState is pending", async () => {
    const events: EmitLog = [];
    const runtime = stubRuntime(events, "pending");
    const controller = new AbortController();
    const run = new CloudBootstrapMessageService().handleMessage(runtime, message(), undefined, {
      abortSignal: controller.signal,
      timeoutDuration: 10_000,
    });
    setTimeout(() => controller.abort(new Error("Caller stopped")), 5);
    await expect(run).rejects.toThrow("Caller stopped");
    await drainPostDeliveryTasks(runtime);
    expect(events.filter(({ event }) => event === EventType.RUN_ENDED)).toHaveLength(1);
    expect(events.filter(({ event }) => event === EventType.RUN_TIMEOUT)).toHaveLength(0);
  });
});
