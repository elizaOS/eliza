/**
 * Verifies the production router preserves typed parent-agent broker failures.
 * Deterministic integration-style test with an in-memory ACP event source; no
 * subprocess or live model is used.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpService } from "../services/acp-service.js";
import { SubAgentRouter } from "../services/sub-agent-router.js";

describe("SubAgentRouter parent-agent failure preservation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits a nonterminal typed receipt while leaving the child session running", async () => {
    const terminalFailure = {
      kind: "coding_tool_failure" as const,
      code: "SHELL_UNAVAILABLE",
      transient: true,
      message: "Shell execution failed.",
    };
    const session = {
      id: "sess-router-failure",
      status: "running",
      workdir: "/repo",
      metadata: {},
    };
    let handler: Parameters<AcpService["onSessionEvent"]>[0] | undefined;
    const emitted: Array<{ event: string; data: unknown }> = [];
    const sent: string[] = [];
    const acp = {
      onSessionEvent: vi.fn((callback) => {
        handler = callback;
        return () => undefined;
      }),
      getSession: vi.fn(async () => session),
      sendToSession: vi.fn(async (_sessionId: string, input: string) => {
        sent.push(input);
        return {};
      }),
      emitSessionEvent: vi.fn(
        (sessionId: string, event: string, data: unknown) => {
          emitted.push({ event, data });
          handler?.(sessionId, event, data, session as never);
        },
      ),
    };
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getService: vi.fn(() => acp),
      getSetting: vi.fn(() => undefined),
      createMemory: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      messageService: {
        handleMessage: vi.fn(async (_runtime, _memory, callback) => {
          await callback({ text: "Done." });
          return {
            didRespond: true,
            responseContent: null,
            responseMessages: [],
            terminalFailure,
          };
        }),
      },
    } as unknown as IAgentRuntime;
    const router = await SubAgentRouter.start(runtime);

    expect(handler).toBeDefined();
    handler?.(
      session.id,
      "message",
      {
        text: 'USE_SKILL parent-agent {"request":"Run the coding task."}',
      },
      session as never,
    );

    await vi.waitFor(() => {
      expect(emitted).toContainEqual({
        event: "parent_agent_failure",
        data: {
          type: "parent_agent_failure",
          version: 1,
          brokerSuccess: false,
          terminalFailure,
          delivered: true,
        },
      });
      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          src: "acpx:sub-agent-router",
          sessionId: session.id,
          receipt: expect.objectContaining({
            terminalFailure,
            delivered: true,
          }),
        }),
        "parent-agent failure receipt recorded",
      );
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"kind":"coding_tool_failure"');
    expect(session.status).toBe("running");

    await router.stop();
  });
});
