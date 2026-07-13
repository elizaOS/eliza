/**
 * Direct TASKS create lifecycle tests use a real AgentRuntime with an
 * in-memory adapter and a structural ACP service to pin validator ownership,
 * terminal PromptResult handling, and event cardinality.
 */

import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  type Memory,
  Service,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpActionService } from "../../src/actions/common.ts";
import { tasksAction } from "../../src/actions/tasks.ts";
import type {
  PromptResult,
  SessionEventName,
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../../src/services/types.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

type PromptResultFixture = {
  stopReason: string;
  response?: string;
  finalText?: string;
  error?: string;
};

const activeRuntimes: AgentRuntime[] = [];

async function createHarness(
  promptResult: PromptResultFixture = {
    stopReason: "end_turn",
    response: "done",
    finalText: "done",
  },
  emitsPromptTerminalEvents = true,
) {
  const stopSession = vi.fn(
    async (_sessionId: string, _force?: boolean) => undefined,
  );
  const emitSessionEvent = vi.fn(
    (_sessionId: string, _event: SessionEventName, _data: unknown) => undefined,
  );
  const metadataBySession = new Map<string, Record<string, unknown>>();

  class HarnessAcpService extends Service implements AcpActionService {
    static serviceType = "ACP_SUBPROCESS_SERVICE";
    capabilityDescription =
      "Deterministic ACP boundary for TASKS lifecycle tests";
    readonly emitsPromptTerminalEvents = emitsPromptTerminalEvents;
    readonly resolveAgentType = vi.fn(async () => "codex");
    readonly spawnSession = vi.fn(
      async (opts: SpawnOptions): Promise<SpawnResult> => {
        const metadata = opts.metadata ?? {};
        metadataBySession.set("session-1", metadata);
        return {
          sessionId: "session-1",
          id: "session-1",
          name: "validator-view",
          agentType: "codex",
          workdir: "/tmp",
          status: "ready",
          metadata,
        };
      },
    );
    readonly sendPrompt = vi.fn(async (): Promise<PromptResult> => {
      if (emitsPromptTerminalEvents && promptResult.stopReason === "end_turn") {
        emitSessionEvent("session-1", "task_complete", {
          response: promptResult.finalText ?? promptResult.response,
        });
      }
      return {
        sessionId: "session-1",
        response: promptResult.response ?? "",
        finalText: promptResult.finalText ?? "",
        stopReason: promptResult.stopReason,
        durationMs: 1,
        ...(promptResult.error ? { error: promptResult.error } : {}),
      };
    });
    readonly sendToSession = vi.fn(
      async (_sessionId: string, _input: string): Promise<PromptResult> =>
        this.sendPrompt(),
    );
    readonly sendKeysToSession = vi.fn(
      async (_sessionId: string, _keys?: string) => undefined,
    );
    readonly stopSession = stopSession;
    readonly emitSessionEvent = emitSessionEvent;
    readonly getSession = vi.fn(
      async (): Promise<SessionInfo> => ({
        id: "session-1",
        name: "validator-view",
        agentType: "codex",
        workdir: "/tmp",
        status: "ready",
        approvalPreset: "standard",
        createdAt: new Date(0),
        lastActivityAt: new Date(0),
        metadata: metadataBySession.get("session-1"),
      }),
    );
    readonly listSessions = vi.fn(async (): Promise<SessionInfo[]> => []);

    static async start(runtime: IAgentRuntime): Promise<Service> {
      return new HarnessAcpService(runtime);
    }

    async stop(): Promise<void> {}
  }

  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character: createCharacter({ name: "Tester" }),
    adapter: new InMemoryDatabaseAdapter(),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  activeRuntimes.push(runtime);
  runtime.setSetting("ELIZA_ORCHESTRATOR_TASK_ROOMS", "0");
  await runtime.initialize({ skipMigrations: true });
  await runtime.registerService(HarnessAcpService);
  await runtime.getServiceLoadPromise(HarnessAcpService.serviceType);
  const acp = runtime.getService<HarnessAcpService>(
    HarnessAcpService.serviceType,
  );
  if (!acp) {
    throw new Error("ACP harness service did not start");
  }
  const message = {
    id: MESSAGE_ID,
    agentId: AGENT_ID,
    entityId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: "Create the proof view" },
  } as Memory;
  const invoke = (parameters: Record<string, unknown>) =>
    tasksAction.handler(runtime, message, undefined, { parameters });
  return {
    acp,
    emitSessionEvent,
    invoke,
    metadataBySession,
    stopSession,
  };
}

describe("TASKS create validator lifecycle", () => {
  let previousSmithers: string | undefined;

  beforeEach(() => {
    previousSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
    process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
  });

  afterEach(async () => {
    if (previousSmithers === undefined) {
      delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
    } else {
      process.env.ELIZA_ORCHESTRATOR_SMITHERS = previousSmithers;
    }
    for (const runtime of activeRuntimes.splice(0)) {
      await runtime.stop();
      await runtime.close();
    }
  });

  it("derives keep-alive from the locked retrying validator contract", async () => {
    const harness = await createHarness();
    const result = await harness.invoke({
      action: "create",
      task: "Create the proof view",
      workdir: "/tmp",
      lockWorkdir: true,
      validator: {
        service: "app-verification",
        method: "verifyPlugin",
        params: { workdir: "/tmp", pluginName: "proof-view" },
      },
      maxRetries: 2,
      onVerificationFail: "retry",
    });

    expect(result?.success).toBe(true);
    expect(harness.emitSessionEvent).toHaveBeenCalledWith(
      "session-1",
      "task_complete",
      expect.objectContaining({ response: "done" }),
    );
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.metadataBySession.get("session-1")).toMatchObject({
      keepAliveAfterComplete: true,
      validator: {
        service: "app-verification",
        method: "verifyPlugin",
      },
    });
  });

  it("ignores an independently supplied keep-alive flag", async () => {
    const harness = await createHarness();
    const result = await harness.invoke({
      action: "create",
      task: "Create an ordinary script",
      workdir: "/tmp",
      keepAliveAfterComplete: true,
    });

    expect(result?.success).toBe(true);
    expect(harness.stopSession).toHaveBeenCalledOnce();
    expect(harness.metadataBySession.get("session-1")).toMatchObject({
      keepAliveAfterComplete: false,
    });
  });

  it.each([
    "cancelled",
    "stopped",
  ])("reports a %s PromptResult as failed instead of completed", async (stopReason) => {
    const harness = await createHarness({ stopReason });
    const result = await harness.invoke({
      action: "create",
      task: "Create the proof view",
      workdir: "/tmp",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      agents: [expect.objectContaining({ status: "failed" })],
    });
    expect(
      harness.emitSessionEvent.mock.calls.filter(
        ([, event]) => event === "task_complete",
      ),
    ).toHaveLength(0);
    expect(harness.stopSession).toHaveBeenCalledOnce();
  });

  it("bridges a legacy PromptResult error into exactly one error event", async () => {
    const harness = await createHarness(
      { stopReason: "error", error: "agent crashed" },
      false,
    );
    const result = await harness.invoke({
      action: "create",
      task: "Create the proof view",
      workdir: "/tmp",
    });

    expect(result?.success).toBe(false);
    expect(
      harness.emitSessionEvent.mock.calls.filter(
        ([, event]) => event === "error",
      ),
    ).toEqual([
      [
        "session-1",
        "error",
        expect.objectContaining({ message: "agent crashed" }),
      ],
    ]);
  });
});
