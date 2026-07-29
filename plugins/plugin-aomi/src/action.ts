/**
 * Implements the single follow-up-capable Aomi action and its mandatory two-turn wallet gate.
 */
import type { AomiMessage } from "@aomi-labs/client";
import {
  type Action,
  type ActionResult,
  FOLLOW_UP_CAPABLE_ACTION_TAG,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type ProviderDataRecord,
  requireConfirmation,
  type State,
  toElizaError,
} from "@elizaos/core";
import { AOMI_DIRECT_ROUTE_TAG } from "./routing.js";
import { AomiService } from "./service.js";
import type { AomiBoundary } from "./types.js";

const AOMI_CONFIRM_ACTION = "AOMI_WALLET";

function serviceFromRuntime(runtime: IAgentRuntime): AomiService | null {
  return runtime.getService<AomiService>(AomiService.serviceType);
}

function promptFrom(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>,
): string {
  const parameters =
    options && "parameters" in options ? options.parameters : undefined;
  const parameterPrompt =
    typeof parameters === "object" && parameters !== null
      ? Reflect.get(parameters, "prompt")
      : undefined;
  if (typeof parameterPrompt === "string" && parameterPrompt.trim()) {
    return parameterPrompt.trim();
  }
  return typeof message.content.text === "string"
    ? message.content.text.trim()
    : "";
}

function finalAgentText(messages: readonly AomiMessage[]): string {
  const message = [...messages]
    .reverse()
    .find(
      (candidate) =>
        (candidate.sender === "agent" || candidate.sender === "assistant") &&
        typeof candidate.content === "string" &&
        candidate.content.trim(),
    );
  return message?.content?.trim() ?? "Aomi completed the delegated request.";
}

function completedResult(
  boundary: Extract<AomiBoundary, { status: "completed" }>,
): ActionResult {
  const text = finalAgentText(boundary.result.messages);
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    values: {
      aomiActionCompleted: true,
      aomiPendingConfirmation: false,
    },
    data: {
      status: "completed",
      title: boundary.result.title ?? null,
      messageCount: boundary.result.messages.length,
    },
  };
}

function pendingResult(
  boundary: Extract<AomiBoundary, { status: "wallet_required" }>,
): ActionResult {
  return {
    success: true,
    text: boundary.preview,
    userFacingText: boundary.preview,
    verifiedUserFacing: true,
    turnComplete: true,
    values: {
      aomiActionCompleted: false,
      aomiPendingConfirmation: true,
    },
    data: {
      status: "awaiting_confirmation",
      requiresConfirmation: true,
      awaitingUserInput: true,
      requestId: boundary.request.id,
      requestKind: boundary.request.kind,
    },
  };
}

async function handleBoundary(
  runtime: IAgentRuntime,
  message: Memory,
  service: AomiService,
  roomId: string,
  boundary: AomiBoundary,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  if (boundary.status === "completed") {
    return completedResult(boundary);
  }

  const decision = await requireConfirmation({
    runtime,
    message,
    actionName: AOMI_CONFIRM_ACTION,
    pendingKey: `${roomId}:${boundary.request.id}`,
    prompt: boundary.preview,
    callback,
    metadata: {
      roomId,
      requestId: boundary.request.id,
      requestKind: boundary.request.kind,
    },
  });
  if (decision.status === "pending") {
    return pendingResult(boundary);
  }
  if (decision.status === "cancelled") {
    const next = await service.reject(roomId);
    if (next.status === "wallet_required") {
      return handleBoundary(runtime, message, service, roomId, next, callback);
    }
    const text = "Aomi wallet request rejected. No signature was produced.";
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      values: {
        aomiActionCompleted: false,
        aomiPendingConfirmation: false,
      },
      data: {
        status: "rejected",
        requestId: boundary.request.id,
      },
    };
  }

  const next = await service.confirm(roomId);
  return handleBoundary(runtime, message, service, roomId, next, callback);
}

function failureResult(error: unknown): ActionResult {
  const normalized = toElizaError(error, "AOMI_ACTION_FAILED");
  const known = normalized.code.startsWith("AOMI_");
  const text = known
    ? normalized.message
    : "Aomi could not complete the request. Check the plugin configuration and try again.";
  const data: ProviderDataRecord = {
    status: "failed",
    errorCode: normalized.code,
    retryable: normalized.severity !== "fatal",
  };
  return {
    success: false,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    values: {
      aomiActionCompleted: false,
    },
    data,
  };
}

export const aomiAction: Action = {
  name: "AOMI",
  description:
    "Delegate an open-ended on-chain task to Aomi. Use for protocol research, balances, simulations, DeFi workflows, transaction construction, and multi-step blockchain operations. Aomi wallet requests always pause for a separate user confirmation before signing or submission.",
  descriptionCompressed:
    "AOMI delegates open-ended on-chain research or execution; wallet writes require a later yes/no confirmation",
  routingHint:
    "open-ended on-chain workflow or explicit Aomi request -> AOMI; simple native wallet transfer/swap may use WALLET",
  contexts: ["finance", "crypto", "wallet", "onchain"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "onchain"] },
  roleGate: { minRole: "ADMIN" },
  tags: [FOLLOW_UP_CAPABLE_ACTION_TAG, AOMI_DIRECT_ROUTE_TAG],
  similes: [
    "USE_AOMI",
    "AOMI_ONCHAIN",
    "ONCHAIN_AGENT",
    "DEFI_AGENT",
    "BLOCKCHAIN_WORKFLOW",
  ],
  parameters: [
    {
      name: "prompt",
      description:
        "The complete natural-language task for Aomi. Preserve protocol names, chains, tokens, amounts, addresses, and user constraints.",
      required: true,
      aliases: ["request", "task", "instructions"],
      schema: { type: "string", minLength: 1, maxLength: 8_000 },
    },
  ],
  validate: async (runtime, message, _state, options) => {
    void _state;
    const service = serviceFromRuntime(runtime);
    if (!service) return false;
    const roomId = String(message.roomId);
    return (
      service.pending(roomId) !== null ||
      promptFrom(message, options).length > 0
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    void _state;
    const service = serviceFromRuntime(runtime);
    if (!service) {
      return failureResult(
        new Error("Aomi service is not running. Enable @elizaos/plugin-aomi."),
      );
    }

    const roomId = String(message.roomId);
    try {
      const existing = service.pending(roomId);
      const boundary = existing
        ? {
            status: "wallet_required" as const,
            request: existing.request,
            preview: existing.preview,
          }
        : await service.submit(roomId, promptFrom(message, options));
      return await handleBoundary(
        runtime,
        message,
        service,
        roomId,
        boundary,
        callback,
      );
    } catch (error) {
      // error-policy:J1 The action boundary converts classified failures into planner-visible results.
      return failureResult(error);
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Use Aomi to find the best lending rate for USDC on Base.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I’ll delegate that on-chain comparison to Aomi.",
          action: "AOMI",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Ask Aomi to swap 0.01 ETH for USDC on Base.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I’ll have Aomi construct the swap and show the exact wallet request before anything is signed.",
          action: "AOMI",
        },
      },
    ],
  ],
};
