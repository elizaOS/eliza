/**
 * APPROVE_REQUEST / REJECT_REQUEST actions.
 *
 * These resolve a pending `ApprovalRequest` from the LifeOps approval queue
 * (WS6). Parameter extraction is LLM-driven: the handler asks TEXT_LARGE to
 * pick the target request id and a resolution reason from the incoming
 * message plus a snapshot of the queue. The prompt is multilingual — the
 * model is instructed to understand any language and to echo the reason in
 * the user's language.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { ModelType, logger, parseJSONObjectFromText } from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import {
  ApprovalNotFoundError,
  type ApprovalRequest,
  ApprovalStateTransitionError,
} from "../lifeops/approval-queue.types.js";

type ApprovalIntent = "approve" | "reject";

interface ExtractedResolution {
  readonly requestId: string | null;
  readonly reason: string | null;
}

function formatPending(requests: ReadonlyArray<ApprovalRequest>): string {
  if (requests.length === 0) return "(no pending requests)";
  return requests
    .map((r, i) => {
      const payloadSummary = JSON.stringify(r.payload);
      return `${i + 1}. id=${r.id} action=${r.action} channel=${r.channel} reason=${r.reason} payload=${payloadSummary}`;
    })
    .join("\n");
}

async function extractResolution(
  runtime: IAgentRuntime,
  userText: string,
  intent: ApprovalIntent,
  pending: ReadonlyArray<ApprovalRequest>,
): Promise<ExtractedResolution> {
  if (pending.length === 0) {
    return { requestId: null, reason: null };
  }
  if (typeof runtime.useModel !== "function") {
    if (pending.length === 1) {
      return {
        requestId: pending[0].id,
        reason: userText.trim() || `user ${intent}d`,
      };
    }
    return { requestId: null, reason: null };
  }
  const prompt = `You are resolving an approval queue decision.
The user wants to ${intent} one of the pending requests below.
Understand the user's message in any language. Echo the reason in the user's language.

User message:
"""
${userText}
"""

Pending requests:
${formatPending(pending)}

Respond as strict JSON with exactly these keys:
{
  "requestId": "<id of the single targeted request, or null if ambiguous>",
  "reason": "<short human-readable reason in the user's language, or null if none given>"
}`;
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const parsed = parseJSONObjectFromText(typeof raw === "string" ? raw : "");
  if (!parsed || typeof parsed !== "object") {
    return { requestId: null, reason: null };
  }
  const record = parsed as { requestId?: unknown; reason?: unknown };
  const requestId =
    typeof record.requestId === "string" && record.requestId.length > 0
      ? record.requestId
      : null;
  const reason =
    typeof record.reason === "string" && record.reason.length > 0
      ? record.reason
      : null;
  return { requestId, reason };
}

function denied(reason: string): ActionResult {
  return {
    text: "",
    success: false,
    data: { error: reason },
  };
}

async function resolveApprovalRequest(
  runtime: IAgentRuntime,
  message: Memory,
  intent: ApprovalIntent,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  if (!(await hasOwnerAccess(runtime, message))) {
    return denied("PERMISSION_DENIED");
  }
  const subjectUserId =
    typeof message.entityId === "string" ? message.entityId : "";
  if (!subjectUserId) {
    return denied("MISSING_SUBJECT_USER");
  }
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  const pending = await queue.list({
    subjectUserId,
    state: "pending",
    action: null,
    limit: 20,
  });
  const userText =
    typeof message.content?.text === "string" ? message.content.text : "";
  const extracted = await extractResolution(runtime, userText, intent, pending);
  if (!extracted.requestId) {
    const text =
      pending.length === 0
        ? "There are no pending approval requests."
        : "Which request? Please reference it by id or describe it.";
    if (callback) await callback({ text });
    return {
      text,
      success: false,
      data: { error: "REQUEST_ID_NOT_RESOLVED", pendingCount: pending.length },
    };
  }
  const resolution = {
    resolvedBy: subjectUserId,
    resolutionReason: extracted.reason ?? `user ${intent}d`,
  };
  try {
    const updated =
      intent === "approve"
        ? await queue.approve(extracted.requestId, resolution)
        : await queue.reject(extracted.requestId, resolution);
    logger.info(
      `[ApprovalAction] ${intent} ${updated.id} by ${subjectUserId}`,
    );
    const text =
      intent === "approve"
        ? `Approved request ${updated.id}.`
        : `Rejected request ${updated.id}.`;
    if (callback) await callback({ text });
    return {
      text,
      success: true,
      data: {
        requestId: updated.id,
        state: updated.state,
        action: updated.action,
      },
    };
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      return denied("REQUEST_NOT_FOUND");
    }
    if (error instanceof ApprovalStateTransitionError) {
      return denied("INVALID_STATE_TRANSITION");
    }
    throw error;
  }
}

export const approveRequestAction: Action = {
  name: "APPROVE_REQUEST",
  similes: [
    "APPROVE",
    "CONFIRM_REQUEST",
    "ACCEPT_REQUEST",
    "YES_DO_IT",
    "GO_AHEAD",
  ],
  description:
    "Approve a pending action that the agent queued for human confirmation (send message, schedule event, book travel, etc.). Understands any language.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message, _state, _options, callback) =>
    resolveApprovalRequest(runtime, message, "approve", callback),
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Yeah, go ahead and send that draft to Marco.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Approved request req-8821.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "sounds good, do it",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Approved request req-8912.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const rejectRequestAction: Action = {
  name: "REJECT_REQUEST",
  similes: [
    "REJECT",
    "DENY_REQUEST",
    "DECLINE_REQUEST",
    "CANCEL_REQUEST",
    "NO_DONT",
  ],
  description:
    "Reject a pending action that the agent queued for human confirmation. Understands any language.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message, _state, _options, callback) =>
    resolveApprovalRequest(runtime, message, "reject", callback),
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "No, don't send that. Let's hold off.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Rejected request req-8821.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Skip the one about the dinner reservation — we'll do it another day.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Rejected request req-9014.",
        },
      },
    ],
  ] as ActionExample[][],
};
