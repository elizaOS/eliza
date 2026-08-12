/**
 * Classifies a terminal Agent Client Protocol response at the transport
 * boundary. Only a correlated `session/prompt` response can authorize a
 * provider-accepted receipt; local session identity and process exit state are
 * deliberately insufficient because both can exist without a provider reply.
 */

import type { PromptProviderDisposition } from "./types.js";

export function unknownPromptProviderDisposition(
  code: string,
  effectsMayHaveOccurred: boolean,
): PromptProviderDisposition {
  return { kind: "unknown", code, effectsMayHaveOccurred };
}

export function classifyPromptProviderResponse(input: {
  transport: "native" | "cli";
  protocolSessionId: string | undefined;
  requestId: string | undefined;
  stopReason: string | undefined;
  acceptedAt: string;
}): PromptProviderDisposition {
  if (!input.protocolSessionId || !input.requestId) {
    return unknownPromptProviderDisposition(
      "ACP_PROMPT_RESPONSE_UNCORRELATED",
      true,
    );
  }
  if (input.stopReason === "end_turn") {
    return {
      kind: "accepted",
      receipt: {
        receiptId: `${input.transport}:${input.protocolSessionId}:${input.requestId}`,
        acceptedAt: input.acceptedAt,
        transport: input.transport,
        protocolSessionId: input.protocolSessionId,
        requestId: input.requestId,
      },
    };
  }
  if (input.stopReason === "refusal" || input.stopReason === "content_filter") {
    return {
      kind: "rejected",
      code: "ACP_PROMPT_REJECTED",
      message: "The coding-agent provider declined the follow-up.",
    };
  }
  return unknownPromptProviderDisposition(
    promptUnsettledCode(input.stopReason),
    true,
  );
}

function promptUnsettledCode(stopReason: string | undefined): string {
  switch (stopReason) {
    case "cancelled":
      return "ACP_PROMPT_CANCELLED_UNSETTLED";
    case "stopped":
      return "ACP_PROMPT_STOPPED_UNSETTLED";
    case "error":
      return "ACP_PROMPT_ERROR_UNSETTLED";
    case "max_tokens":
      return "ACP_PROMPT_MAX_TOKENS_UNSETTLED";
    case "max_turn_requests":
      return "ACP_PROMPT_MAX_TURN_REQUESTS_UNSETTLED";
    case "length":
      return "ACP_PROMPT_LENGTH_UNSETTLED";
    case "interrupted":
      return "ACP_PROMPT_INTERRUPTED_UNSETTLED";
    case undefined:
      return "ACP_PROMPT_RESPONSE_INVALID";
    default:
      return "ACP_PROMPT_RESPONSE_UNRECOGNIZED";
  }
}
