import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import callStateProvider from "../../providers/callState";

describe("callStateProvider", () => {
  let mockRuntime: IAgentRuntime;
  let mockTwilioService: any;
  let mockState: State;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTwilioService = {
      voiceStreams: new Map(),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockTwilioService),
    } as any;

    mockState = {} as State;
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
      // Set up mock voice streams
      mockTwilioService.voiceStreams.set("CA123", {
        streamSid: "ST123",
        from: "+18885551234",
        to: "+18885555678",
      });
      mockTwilioService.voiceStreams.set("CA456", {
        streamSid: "ST456",
        from: "+18885555678",
        to: "+18885551234",
      });

      const message = {} as any as Memory;

      const result = await callStateProvider.get(mockRuntime, message, mockState);

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
      const message = {} as any as Memory;

      const result = await callStateProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No active voice calls");
      expect(result.data).toEqual({
        activeCallCount: 0,
      });
    });

    it("should handle when service is not initialized", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const message = {} as any as Memory;

      const result = await callStateProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No Twilio call state available - service not initialized");
    });

    it("should handle when voiceStreams is undefined", async () => {
      mockTwilioService.voiceStreams = undefined;

      const message = {} as any as Memory;

      const result = await callStateProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No active voice calls");
      expect(result.data).toEqual({
        activeCallCount: 0,
      });
    });

    it("should handle errors gracefully", async () => {
      // Make voiceStreams throw an error when accessed
      Object.defineProperty(mockTwilioService, "voiceStreams", {
        get() {
          throw new Error("Service error");
        },
      });

      const message = {} as any as Memory;

      const result = await callStateProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("Error retrieving call state");
    });

    it("should handle single active call", async () => {
      mockTwilioService.voiceStreams.set("CA789", {
        streamSid: "ST789",
        from: "+18885551111",
        to: "+18885552222",
      });

      const message = {} as any as Memory;

      const result = await callStateProvider.get(mockRuntime, message, mockState);

      expect(result.text).toContain("Active voice calls (1):");
      expect(result.text).toContain("Call CA789: +18885551111 → +18885552222");
      expect(result.data?.activeCallCount).toBe(1);
      expect(result.data?.calls).toHaveLength(1);
    });
  });
});
