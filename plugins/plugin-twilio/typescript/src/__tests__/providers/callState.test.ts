import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import callStateProvider from "../../providers/callState";

/**
 * Voice stream data structure matching TwilioService
 */
interface VoiceStream {
  streamSid: string;
  from: string;
  to: string;
}

/**
 * Minimal TwilioService interface for testing
 */
interface TwilioServiceTestable {
  voiceStreams: Map<string, VoiceStream>;
}

/**
 * Creates a test Memory object with required fields
 */
function createTestMemory(): Memory {
  return {
    id: "test-memory-id" as UUID,
    roomId: "test-room-id" as UUID,
    entityId: "test-entity-id" as UUID,
    agentId: "test-agent-id" as UUID,
    content: {
      text: "test message",
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  };
}

/**
 * Creates a test State object with required fields
 */
function createTestState(): State {
  return {
    values: {},
    data: {},
    text: "",
  };
}

describe("callStateProvider", () => {
  let twilioService: TwilioServiceTestable;
  let testRuntime: IAgentRuntime;
  let testState: State;
  let testMessage: Memory;

  beforeEach(() => {
    vi.clearAllMocks();

    twilioService = {
      voiceStreams: new Map<string, VoiceStream>(),
    };

    // Create a minimal runtime with the getService method
    testRuntime = {
      getService: vi.fn().mockReturnValue(twilioService),
      agentId: "test-agent-id" as UUID,
    } as unknown as IAgentRuntime;

    testState = createTestState();
    testMessage = createTestMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("should have correct name and description", () => {
      expect(callStateProvider.name).toBe("twilioCallState");
      expect(callStateProvider.description).toBe(
        "Provides information about active voice calls and streams"
      );
    });
  });

  describe("get", () => {
    it("should return active call information when calls exist", async () => {
      // Set up voice streams
      twilioService.voiceStreams.set("CA123", {
        streamSid: "ST123",
        from: "+18885551234",
        to: "+18885555678",
      });
      twilioService.voiceStreams.set("CA456", {
        streamSid: "ST456",
        from: "+18885555678",
        to: "+18885551234",
      });

      const result = await callStateProvider.get(testRuntime, testMessage, testState);

      expect(result.text).toContain("Active voice calls (2):");
      expect(result.text).toContain("Call CA123: +18885551234 → +18885555678");
      expect(result.text).toContain("Call CA456: +18885555678 → +18885551234");
      expect(result.data).toEqual({
        activeCallCount: 2,
        calls: [
          {
            callSid: "CA123",
            streamSid: "ST123",
            from: "+18885551234",
            to: "+18885555678",
          },
          {
            callSid: "CA456",
            streamSid: "ST456",
            from: "+18885555678",
            to: "+18885551234",
          },
        ],
      });
    });

    it("should return no active calls when voice streams is empty", async () => {
      const result = await callStateProvider.get(testRuntime, testMessage, testState);

      expect(result.text).toBe("No active voice calls");
      expect(result.data).toEqual({
        activeCallCount: 0,
      });
    });

    it("should handle when service is not initialized", async () => {
      const runtimeWithoutService = {
        getService: vi.fn().mockReturnValue(null),
        agentId: "test-agent-id" as UUID,
      } as unknown as IAgentRuntime;

      const result = await callStateProvider.get(runtimeWithoutService, testMessage, testState);

      expect(result.text).toBe("No Twilio call state available - service not initialized");
    });

    it("should handle when voiceStreams is undefined", async () => {
      const serviceWithUndefinedStreams = {
        voiceStreams: undefined,
      };
      const runtimeWithUndefined = {
        getService: vi.fn().mockReturnValue(serviceWithUndefinedStreams),
        agentId: "test-agent-id" as UUID,
      } as unknown as IAgentRuntime;

      const result = await callStateProvider.get(runtimeWithUndefined, testMessage, testState);

      expect(result.text).toBe("No active voice calls");
      expect(result.data).toEqual({
        activeCallCount: 0,
      });
    });

    it("should handle errors gracefully", async () => {
      // Create a service that throws when voiceStreams is accessed
      const errorService = {};
      Object.defineProperty(errorService, "voiceStreams", {
        get() {
          throw new Error("Service error");
        },
      });
      const runtimeWithError = {
        getService: vi.fn().mockReturnValue(errorService),
        agentId: "test-agent-id" as UUID,
      } as unknown as IAgentRuntime;

      const result = await callStateProvider.get(runtimeWithError, testMessage, testState);

      expect(result.text).toBe("Error retrieving call state");
    });

    it("should handle single active call", async () => {
      twilioService.voiceStreams.set("CA789", {
        streamSid: "ST789",
        from: "+18885551111",
        to: "+18885552222",
      });

      const result = await callStateProvider.get(testRuntime, testMessage, testState);

      expect(result.text).toContain("Active voice calls (1):");
      expect(result.text).toContain("Call CA789: +18885551111 → +18885552222");
      expect(result.data?.activeCallCount).toBe(1);
      expect(result.data?.calls).toHaveLength(1);
    });
  });
});
