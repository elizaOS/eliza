import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { TWILIO_SERVICE_NAME } from "../constants";
import type { TwilioService } from "../service";

const callStateProvider: Provider = {
  name: "twilioCallState",
  description: "Provides information about active voice calls and streams",
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    try {
      const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
      if (!twilioService) {
        return {
          text: "No Twilio call state available - service not initialized",
        };
      }

      // Get active voice streams
      // @ts-expect-error - accessing private property for provider
      const activeStreams = twilioService.voiceStreams;

      if (!activeStreams || activeStreams.size === 0) {
        return {
          text: "No active voice calls",
          data: {
            activeCallCount: 0,
          },
        };
      }

      // Format active call information
      const callInfo: string[] = [];
      const callData: any[] = [];

      activeStreams.forEach((stream, callSid) => {
        callInfo.push(`Call ${callSid}: ${stream.from} → ${stream.to}`);
        callData.push({
          callSid,
          streamSid: stream.streamSid,
          from: stream.from,
          to: stream.to,
        });
      });

      return {
        text: `Active voice calls (${activeStreams.size}):\n${callInfo.join("\n")}`,
        data: {
          activeCallCount: activeStreams.size,
          calls: callData,
        },
      };
    } catch (error) {
      console.error("Error in callStateProvider:", error);
      return {
        text: "Error retrieving call state",
      };
    }
  },
};

export default callStateProvider;
