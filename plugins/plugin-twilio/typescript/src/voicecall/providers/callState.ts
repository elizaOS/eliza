/**
 * Call state provider for the Voice Call plugin.
 *
 * Provides real-time call state information including active calls,
 * transcript data, and call lifecycle status.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { VOICE_CALL_SERVICE_NAME } from "../constants";
import type { VoiceCallService } from "../service";
import { type CallRecord, TerminalStates } from "../types";

/**
 * Format call duration in human-readable format.
 */
function formatDuration(startedAt: number, endedAt?: number): string {
  const end = endedAt || Date.now();
  const durationMs = end - startedAt;
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format call state for display.
 */
function formatState(state: string): string {
  const stateMap: Record<string, string> = {
    initiated: "Initiating",
    ringing: "Ringing",
    answered: "Connected",
    active: "Active",
    speaking: "Speaking",
    listening: "Listening",
    completed: "Completed",
    "hangup-user": "Ended by caller",
    "hangup-bot": "Ended by agent",
    timeout: "Timed out",
    error: "Error",
    failed: "Failed",
    "no-answer": "No answer",
    busy: "Line busy",
    voicemail: "Voicemail",
  };
  return stateMap[state] || state;
}

/**
 * Get transcript summary for a call.
 */
function getTranscriptSummary(call: CallRecord): string {
  if (call.transcript.length === 0) {
    return "No transcript yet.";
  }

  const lastEntry = call.transcript[call.transcript.length - 1];
  const speakerLabel = lastEntry.speaker === "bot" ? "Agent" : "Caller";
  const text =
    lastEntry.text.length > 100 ? lastEntry.text.substring(0, 100) + "..." : lastEntry.text;

  return `Last message (${speakerLabel}): "${text}"`;
}

/**
 * Provider that exposes current call state information.
 */
export const callStateProvider: Provider = {
  name: "voiceCallState",
  description: "Provides real-time voice call state and transcript information",

  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const service = await runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);

    // Return minimal data if service not available
    if (!service) {
      return {
        data: { available: false, reason: "Service not found" },
        values: { available: "false" },
        text: "Voice call service is not available.",
      };
    }

    if (!service.isConnected()) {
      return {
        data: { available: false, connected: false, reason: "Not connected" },
        values: { available: "false", connected: "false" },
        text: "Voice call service is not connected.",
      };
    }

    const settings = service.getSettings();
    const activeCalls = service.getActiveCalls();

    // Check for current call context from state
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const currentCallId = stateData.callId as string | undefined;

    // Find the current call (either from state or most recent)
    let currentCall: CallRecord | undefined;
    if (currentCallId) {
      const result = service.getCallStatus(currentCallId);
      currentCall = result.found ? result.call : undefined;
    } else if (activeCalls.length > 0) {
      // Get the most recent non-terminal call
      currentCall = activeCalls.find((c) => !TerminalStates.has(c.state));
      if (!currentCall) {
        currentCall = activeCalls[activeCalls.length - 1];
      }
    }

    // Build detailed call information
    const callDetails = activeCalls.map((call) => ({
      callId: call.callId,
      direction: call.direction,
      state: call.state,
      stateFormatted: formatState(call.state),
      from: call.from,
      to: call.to,
      duration: formatDuration(call.startedAt, call.endedAt),
      transcriptCount: call.transcript.length,
      isTerminal: TerminalStates.has(call.state),
    }));

    // Build context text for the agent
    let contextText = "";

    if (activeCalls.length === 0) {
      contextText = "No active voice calls. Ready to make or receive calls.";
    } else if (currentCall) {
      const direction = currentCall.direction === "inbound" ? "incoming" : "outgoing";
      const party = currentCall.direction === "inbound" ? currentCall.from : currentCall.to;

      contextText = `Currently on ${direction} call with ${party}. `;
      contextText += `Status: ${formatState(currentCall.state)}. `;
      contextText += `Duration: ${formatDuration(currentCall.startedAt, currentCall.endedAt)}. `;

      if (currentCall.transcript.length > 0) {
        contextText += getTranscriptSummary(currentCall);
      }
    } else {
      contextText = `${activeCalls.length} call(s) in progress.`;
    }

    // Provider capabilities info
    const capabilities = {
      canMakeCall:
        activeCalls.filter((c) => !TerminalStates.has(c.state)).length <
        (settings?.maxConcurrentCalls || 1),
      canReceiveCall: settings?.inboundPolicy !== "disabled",
      maxConcurrentCalls: settings?.maxConcurrentCalls || 1,
      provider: settings?.provider,
      hasStreaming: settings?.streaming?.enabled || false,
    };

    return {
      data: {
        available: true,
        connected: true,
        provider: settings?.provider,
        fromNumber: settings?.fromNumber,
        activeCalls: callDetails,
        activeCallCount: activeCalls.length,
        currentCall: currentCall
          ? {
              callId: currentCall.callId,
              providerCallId: currentCall.providerCallId,
              direction: currentCall.direction,
              state: currentCall.state,
              stateFormatted: formatState(currentCall.state),
              from: currentCall.from,
              to: currentCall.to,
              startedAt: currentCall.startedAt,
              answeredAt: currentCall.answeredAt,
              endedAt: currentCall.endedAt,
              duration: formatDuration(currentCall.startedAt, currentCall.endedAt),
              transcript: currentCall.transcript,
              transcriptCount: currentCall.transcript.length,
              endReason: currentCall.endReason,
              isTerminal: TerminalStates.has(currentCall.state),
            }
          : null,
        capabilities,
      },
      values: {
        available: "true",
        connected: "true",
        provider: settings?.provider || "",
        fromNumber: settings?.fromNumber || "",
        activeCallCount: String(activeCalls.length),
        currentCallId: currentCall?.callId || "",
        currentCallState: currentCall?.state || "",
        currentCallParty:
          currentCall?.direction === "inbound" ? currentCall?.from || "" : currentCall?.to || "",
        canMakeCall: String(capabilities.canMakeCall),
      },
      text: contextText,
    };
  },
};
