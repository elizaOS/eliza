// Exercises AgentManager.handleMessage fail-closed behavior on a null message
// service and its honest empty-reply handling (fallback-slop remediation for
// #12789 / #12268 — the previous `rt.messageService?.` + "No response
// generated." fabricated a 200 reply that masked a structural pipeline
// failure end-to-end at the gateway-webhook consumer).
import { describe, expect, mock, test } from "bun:test";
import type {
  HandlerCallback,
  IAgentRuntime,
  IMessageService,
  Memory,
  MessageProcessingResult,
} from "@elizaos/core";
import { AgentManager } from "../../src/agent-manager";

interface FakeRuntimeOptions {
  messageService: IMessageService | null;
}

/**
 * Builds a minimal runtime stub sufficient for handleMessage: ensureConnection
 * is a no-op and messageService is injectable (nullable) to model a runtime
 * whose message pipeline failed to initialize.
 */
function makeRuntime(opts: FakeRuntimeOptions): IAgentRuntime {
  return {
    ensureConnection: mock(async () => {}),
    messageService: opts.messageService,
  } as unknown as IAgentRuntime;
}

/**
 * Injects a running agent entry into the manager's private registry so
 * getRuntime resolves without a real startAgent (which needs Redis + plugins).
 */
function withRunningAgent(
  manager: AgentManager,
  agentId: string,
  runtime: IAgentRuntime,
): void {
  (
    manager as unknown as {
      agents: Map<string, unknown>;
    }
  ).agents.set(agentId, {
    agentId,
    characterRef: "test:character",
    runtime,
    state: "running",
  });
}

const OK_RESULT = {
  didRespond: true,
  responseMessages: [],
} as unknown as MessageProcessingResult;

describe("AgentManager.handleMessage fail-closed message pipeline", () => {
  test("throws a structural error when the runtime has no message service", async () => {
    const manager = new AgentManager();
    withRunningAgent(manager, "agent-1", makeRuntime({ messageService: null }));

    await expect(
      manager.handleMessage("agent-1", "user-1", "hello"),
    ).rejects.toThrow(/no message service|not initialized/i);
  });

  test("does not fabricate a reply string when message service is missing", async () => {
    const manager = new AgentManager();
    withRunningAgent(manager, "agent-1", makeRuntime({ messageService: null }));

    let thrown: unknown;
    try {
      await manager.handleMessage("agent-1", "user-1", "hello");
    } catch (err) {
      thrown = err;
    }
    // The old code silently returned "No response generated." here.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("No response generated");
  });

  test("returns accumulated response text from the message pipeline", async () => {
    const manager = new AgentManager();
    const handleMessage = mock(
      async (_rt: IAgentRuntime, _mem: Memory, callback?: HandlerCallback) => {
        await callback?.({ text: "hello " });
        await callback?.({ text: "world" });
        return OK_RESULT;
      },
    );
    withRunningAgent(
      manager,
      "agent-1",
      makeRuntime({
        messageService: { handleMessage } as unknown as IMessageService,
      }),
    );

    const response = await manager.handleMessage("agent-1", "user-1", "hi");
    expect(response).toBe("hello world");
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  test("returns empty string (not a fabricated literal) on a deliberate no-response", async () => {
    const manager = new AgentManager();
    const handleMessage = mock(
      async () =>
        ({
          didRespond: false,
          responseMessages: [],
        }) as unknown as MessageProcessingResult,
    );
    withRunningAgent(
      manager,
      "agent-1",
      makeRuntime({
        messageService: { handleMessage } as unknown as IMessageService,
      }),
    );

    const response = await manager.handleMessage("agent-1", "user-1", "hi");
    // A deliberate silence must be an empty string (adapters drop it), never
    // the old "No response generated." fabrication that read like a reply.
    expect(response).toBe("");
  });

  test("still surfaces getRuntime not-found as its own error (unchanged)", async () => {
    const manager = new AgentManager();
    await expect(
      manager.handleMessage("missing", "user-1", "hi"),
    ).rejects.toThrow("Agent not found");
  });
});
