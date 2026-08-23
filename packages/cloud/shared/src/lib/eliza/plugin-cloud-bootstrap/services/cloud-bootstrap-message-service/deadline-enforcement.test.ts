// Regression coverage for the CloudBootstrapMessageService deadline (#25109):
// the configured timeout must settle handleMessage even when the RUN_TIMEOUT
// lifecycle emission never settles or rejects. The service runs real; only the
// runtime surface is stubbed and the DEFLLMOFF branch keeps the turn LLM-free.
import { describe, expect, it } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { EventType } from "@elizaos/core";
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
    // The DEFLLMOFF branch must have been the turn terminator; otherwise
    // this test would not be exercising a LLM-free path.
    expect(emitLog.some(({ event }) => event === EventType.RUN_ENDED)).toBe(true);
  }, 10_000);

  it("enforces the deadline when RUN_TIMEOUT emission rejects", async () => {
    const emitLog = await expectTimeoutSettles("reject");
    expect(emitLog.some(({ event }) => event === EventType.RUN_TIMEOUT)).toBe(true);
  }, 10_000);
});
