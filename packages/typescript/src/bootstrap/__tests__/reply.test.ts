// Note: test file verifies replyAction behavior for the specific test suite context
import { describe, it, expect, vi } from "vitest";
import { replyAction } from "../actions/reply";
import { type IAgentRuntime, type Memory, type State } from "../../types";

describe("replyAction optimization", () => {
  const mockRuntime = {
    agentId: "test-agent",
    composeState: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
    }
  } as unknown as IAgentRuntime;

  const mockMemory = {
    content: {
      text: "Test message"
    }
  } as Memory;

  it("should skip composeState when required providers exist in state", async () => {
    const mockState = {
      data: {
        providers: {
          RECENT_MESSAGES: {},
          ACTION_STATE: {},
          SOME_PROVIDER: {}
        }
      }
    } as State;

    const responses = [{
      content: {
        providers: ["SOME_PROVIDER"]
      }
    }] as Memory[];

    await replyAction.handler(mockRuntime, mockMemory, mockState, undefined, undefined, responses);

    expect(mockRuntime.composeState).not.toHaveBeenCalled();
  });

  it("should call composeState when state is missing required providers", async () => {
    const mockState = {
      data: {
        providers: {
          // Missing required ACTION_STATE
          RECENT_MESSAGES: {}
        }
      }
    } as State;

    const responses = [{
      content: {
        providers: ["SOME_PROVIDER"]
      }
    }] as Memory[];

    await replyAction.handler(mockRuntime, mockMemory, mockState, undefined, undefined, responses);

    expect(mockRuntime.composeState).toHaveBeenCalled();
    expect(mockRuntime.composeState).toHaveBeenCalledWith(
      mockMemory,
      ["SOME_PROVIDER", "RECENT_MESSAGES", "ACTION_STATE"]
    );
  });

  it("should call composeState when state is null", async () => {
    const responses = [{
      content: {
        providers: ["SOME_PROVIDER"]
      }
    }] as Memory[];

    await replyAction.handler(mockRuntime, mockMemory, null, undefined, undefined, responses);

    expect(mockRuntime.composeState).toHaveBeenCalled();
    expect(mockRuntime.composeState).toHaveBeenCalledWith(
      mockMemory,
      ["SOME_PROVIDER", "RECENT_MESSAGES", "ACTION_STATE"]
    );
  });
});
