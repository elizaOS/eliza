import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import {
  ApprovalNotFoundError,
  type ApprovalQueue,
  type ApprovalRequest,
  ApprovalStateTransitionError,
} from "../lifeops/approval-queue.types.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeApprovedBookTravel } from "./book-travel.js";
import {
  type CrossChannelSendChannel,
  dispatchCrossChannelSend,
} from "./lib/messaging-helpers.js";
import { formatPromptValue } from "./lib/prompt-format.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import { INTERNAL_URL } from "./lifeops-google-helpers.js";

const ACTION_NAME = "RESOLVE_REQUEST";

type ResolveSubaction = "approve" | "reject";

const SUBACTIONS: SubactionsMap<ResolveSubaction> = {
  approve: {
    description:
      "Approve a queued action; reason optional in the user's language.",
    descriptionCompressed: "approve queued action reason-optional multilingual",
    required: [],
    optional: ["requestId", "reason"],
  },
  reject: {
    description:
      "Reject a queued action; reason optional in the user's language.",
    descriptionCompressed: "reject queued action reason-optional multilingual",
    required: [],
    optional: ["requestId", "reason"],
  },
};

interface ExtractedResolution {
  readonly requestId: string | null;
  readonly reason: string | null;
}

interface ResolveRequestParameters {
  readonly subaction?: ResolveSubaction | string;
  readonly requestId?: string;
  readonly reason?: string;
}

function formatPending(requests: ReadonlyArray<ApprovalRequest>): string {
  if (requests.length === 0) return "(no pending requests)";
  return requests
    .map((r, i) => {
      const payloadSummary = formatPromptValue(r.payload, 2);
      return `${i + 1}. id=${r.id} action=${r.action} channel=${r.channel} reason=${r.reason}\n  payload:\n${payloadSummary}`;
    })
    .join("\n");
}

function parseResolutionJson(raw: unknown): ExtractedResolution {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { requestId: null, reason: null };
  }
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const objectText = trimmed.match(/\{[\s\S]*\}/u)?.[0] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return { requestId: null, reason: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { requestId: null, reason: null };
  }
  const record = parsed as { requestId?: unknown; reason?: unknown };
  return {
    requestId:
      typeof record.requestId === "string" && record.requestId.length > 0
        ? record.requestId
        : null,
    reason:
      typeof record.reason === "string" && record.reason.length > 0
        ? record.reason
        : null,
  };
}

async function extractResolution(
  runtime: IAgentRuntime,
  userText: string,
  intent: ResolveSubaction,
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
  // TODO(native-parameters): delete this legacy resolution fallback after the planner
  // consistently supplies requestId/reason in options.parameters.
  const prompt = `You are resolving an approval queue decision.
The user wants to ${intent} one of the pending requests below.
Understand the user's message in any language. Echo the reason in the user's language.

User message:
"""
${userText}
"""

Pending requests:
${formatPending(pending)}

Return strict JSON only with exactly these keys:
{
  "requestId": "id of the single targeted request, or null if ambiguous",
  "reason": "short human-readable reason in the user's language, or null if none given"
}`;
  const raw = await runWithTrajectoryContext(
    { purpose: "lifeops-resolve-request" },
    () => runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
  );
  return parseResolutionJson(raw);
}

function denied(reason: string): ActionResult {
  return {
    text: "",
    success: false,
    data: { error: reason },
  };
}

function approvalChannelToCrossChannelSend(
  channel: ApprovalRequest["channel"],
): CrossChannelSendChannel | null {
  switch (channel) {
    case "telegram":
    case "discord":
    case "imessage":
    case "sms":
    case "x_dm":
      return channel;
    default:
      return null;
  }
}

export async function executeApprovedRequest(args: {
  runtime: IAgentRuntime;
  queue: ApprovalQueue;
  request: ApprovalRequest;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  if (args.request.action === "book_travel") {
    return executeApprovedBookTravel(args);
  }

  const service = new LifeOpsService(args.runtime);

  if (args.request.action === "send_email") {
    const payload = args.request.payload;
    if (payload.action !== "send_email") {
      throw new Error(
        `[approval] action/payload mismatch: action=send_email, payload.action=${payload.action}`,
      );
    }
    await args.queue.markExecuting(args.request.id);
    if (payload.replyToMessageId) {
      await service.sendGmailReply(INTERNAL_URL, {
        messageId: payload.replyToMessageId,
        bodyText: payload.body,
        subject: payload.subject || undefined,
        to: payload.to.length > 0 ? [...payload.to] : undefined,
        cc: payload.cc.length > 0 ? [...payload.cc] : undefined,
        confirmSend: true,
      });
    } else {
      await service.sendGmailMessage(INTERNAL_URL, {
        to: [...payload.to],
        cc: [...payload.cc],
        bcc: [...payload.bcc],
        subject: payload.subject,
        bodyText: payload.body,
        confirmSend: true,
      });
    }
    const done = await args.queue.markDone(args.request.id);
    const text =
      payload.to.length > 0
        ? `Approved and sent email to ${payload.to.join(", ")}.`
        : "Approved and sent the Gmail reply.";
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
      },
    };
  }

  if (args.request.action === "send_message") {
    const channel = approvalChannelToCrossChannelSend(args.request.channel);
    if (!channel) {
      return denied("UNSUPPORTED_APPROVAL_CHANNEL");
    }
    const payload = args.request.payload;
    if (payload.action !== "send_message") {
      throw new Error(
        `[approval] action/payload mismatch: action=send_message, payload.action=${payload.action}`,
      );
    }
    await args.queue.markExecuting(args.request.id);
    const dispatch = await dispatchCrossChannelSend({
      runtime: args.runtime,
      service,
      channel,
      target: payload.recipient,
      body: payload.body,
    });
    if (!dispatch.success) {
      return dispatch;
    }
    const done = await args.queue.markDone(args.request.id);
    const text = `Approved and sent ${channel} message.`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        channel,
      },
    };
  }

  logger.info(
    `[OwnerResolveRequest] approved ${args.request.id} without executor`,
  );
  const text = "Approved.";
  await args.callback?.({ text });
  return {
    text,
    success: true,
    data: {
      requestId: args.request.id,
      state: args.request.state,
      action: args.request.action,
    },
  };
}

async function resolveApprovalRequest(
  runtime: IAgentRuntime,
  message: Memory,
  intent: ResolveSubaction,
  params: ResolveRequestParameters,
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
  const explicitRequestId =
    typeof params.requestId === "string" && params.requestId.trim().length > 0
      ? params.requestId.trim()
      : null;
  const explicitReason =
    typeof params.reason === "string" && params.reason.trim().length > 0
      ? params.reason.trim()
      : null;
  const extracted = explicitRequestId
    ? { requestId: explicitRequestId, reason: explicitReason }
    : await extractResolution(runtime, userText, intent, pending);
  if (!extracted.requestId) {
    const text =
      pending.length === 0
        ? "There are no pending approval requests."
        : "Which request? Please reference it by id or describe it.";
    if (callback) await callback({ text });
    return {
      text,
      success: false,
      values: { requiresConfirmation: true },
      data: {
        error: "REQUEST_ID_NOT_RESOLVED",
        pendingCount: pending.length,
        requiresConfirmation: true,
      },
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
    if (intent === "approve") {
      return executeApprovedRequest({
        runtime,
        queue,
        request: updated,
        callback,
      });
    }
    logger.info(
      `[OwnerResolveRequest] ${intent} ${updated.id} by ${subjectUserId}`,
    );
    const text = `Rejected request ${updated.id}.`;
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

export const resolveRequestAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  suppressPostActionContinuation: true,
  similes: [
    "APPROVE",
    "REJECT",
    "CONFIRM",
    "DENY",
    "YES_DO_IT",
    "NO_DONT",
    "ACCEPT_REQUEST",
    "DECLINE_REQUEST",
  ],
  description:
    "Owner-only. Approve or reject a pending action queued for human confirmation (send_email, send_message, " +
    "book_travel, voice_call, etc.). Picks the target request from the queue based on user intent (multilingual).",
  descriptionCompressed:
    "approve|reject pending request from queue: send_email send_message book_travel voice_call multilingual",
  contexts: ["email", "messaging", "calendar", "tasks", "contacts", "payments"],
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  parameters: [
    {
      name: "subaction",
      description: "One of: approve, reject.",
      required: false,
      schema: { type: "string" as const, enum: ["approve", "reject"] },
    },
    {
      name: "requestId",
      description:
        "Approval request id to approve or reject. Supply this when the planner can identify the pending request directly.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description:
        "Optional short reason for the approval or rejection, in the user's language.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  handler: async (runtime, message, state, options, callback) => {
    const resolved = await resolveActionArgs<
      ResolveSubaction,
      ResolveRequestParameters
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: { actionName: ACTION_NAME, missing: resolved.missing },
      };
    }
    return resolveApprovalRequest(
      runtime,
      message,
      resolved.subaction,
      resolved.params,
      callback,
    );
  },
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
  ] as ActionExample[][],
};
