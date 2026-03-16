import { replyAction } from "../actions/reply.ts";
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../types/index.ts";

describe("reply action", () => {
  const mockRuntime = {
    agentId: "test-agent-id",
    character: {
      name: "TestAgent",
      templates: {},
    },
    composeState: vi.fn().mockResolvedValue({
      values: {},
      data: { providers: {} },
      text: "",
    }),
    useModel: vi.fn().mockResolvedValue("<thought>test thought</thought><text>test response</text>"),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;

  it("should have correct name", () => {
    expect(replyAction.name).toBe("REPLY");
  });

  it("should validate successfully", async () => {
    const result = await replyAction.validate(mockRuntime);
    expect(result).toBe(true);
  });

  it("should reuse initial response text when first action in chain", async () => {
    const mockMessage = {
      id: "test-msg-id",
      content: { text: "Hello" },
      roomId: "test-room",
      entityId: "test-entity",
    } as Memory;

    const mockState = {
      values: {},
      data: { providers: {} },
      text: "",
    } as State;

    const mockResponses = [
      {
        content: {
          text: "Initial response text",
          thought: "Initial thought",
        },
      },
    ] as Memory[];

    const result = await replyAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      { actionContext: { previousResults: [] } },
      undefined,
      mockResponses,
    );

    expect(result.success).toBe(true);
    expect(result.values?.lastReply).toBe("Initial response text");
  });

  it("should generate new response when previous results exist", async () => {
    const mockMessage = {
      id: "test-msg-id",
      content: { text: "Hello" },
      roomId: "test-room",
      entityId: "test-entity",
    } as Memory;

    const mockState = {
      values: {},
      data: { providers: { RECENT_MESSAGES: {}, ACTION_STATE: {} } },
      text: "",
    } as State;

    const result = await replyAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      { actionContext: { previousResults: [{ success: true }] } },
      undefined,
      [],
    );

    expect(result.success).toBe(true);
  });
});
