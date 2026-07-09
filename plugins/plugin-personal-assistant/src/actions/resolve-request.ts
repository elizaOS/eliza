/**
 * RESOLVE_REQUEST action — owner decision surface for the approval queue.
 * Approve or reject a pending request (reject is also the hold verb: "don't
 * send it for now" terminally cancels the dispatch and a fresh request can be
 * queued later); on approval it dispatches the queued payload (message send,
 * document signature, travel booking, …) through `executeApprovedRequest`.
 * Owner-gated; the only path that runs a queued external side effect. The
 * planner learns about pending rows from the `pendingApprovals` provider
 * (../providers/pending-approvals.ts), which routes decisions here (#14630).
 */
import { hasOwnerAccess } from "@elizaos/agent";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  appendInteractionBlock,
  type ChoiceInteraction,
  logger,
  ModelType,
  resolveActionArgs,
  runWithTrajectoryPurpose,
  type SubactionsMap,
} from "@elizaos/core";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioVoiceCall,
} from "@elizaos/plugin-phone/twilio";
import { INTERNAL_URL } from "../lifeops/access.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import {
  ApprovalNotFoundError,
  type ApprovalQueue,
  type ApprovalRequest,
  ApprovalStateTransitionError,
  ApprovalTransitionConflictError,
} from "../lifeops/approval-queue.types.js";
import { extractCommitmentLedgerRecords } from "../lifeops/commitments/index.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeApprovedBookTravel } from "./book-travel.js";
import { dispatchApprovedSignatureRequest } from "./document.js";
import {
  type CrossChannelSendChannel,
  dispatchCrossChannelSend,
} from "./lib/messaging-helpers.js";
import { formatPromptValue } from "./lib/prompt-format.js";

const ACTION_NAME = "RESOLVE_REQUEST";

type ResolveSubaction = "approve" | "reject";

const SUBACTIONS: SubactionsMap<ResolveSubaction> = {
  approve: {
    description: "Approve queued action; optional reason, user language.",
    descriptionCompressed: "approve queued action reason-optional multilingual",
    required: [],
    optional: ["requestId", "reason"],
  },
  reject: {
    description:
      "Reject queued action so it never dispatches — also the verb for holds " +
      "('don't send it', 'not yet', 'hold off until I confirm'); a fresh " +
      "request can be queued later. Optional reason, user language.",
    descriptionCompressed:
      "reject/hold queued action (nothing dispatches) reason-optional multilingual",
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

/** Chip labels stay glanceable; the full reason lives in the queue row. */
function truncateReason(reason: string, max = 48): string {
  const trimmed = reason.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * One-tap request picker for an ambiguous approve/reject (#14733). Each option
 * value is `<intent> <requestId>` — the tap round-trips it as the owner's next
 * message, which this action's extraction resolves verbatim (the id is in the
 * text and the `pendingApprovals` provider lists the same ids).
 */
export function buildResolveRequestChoice(
  intent: ResolveSubaction,
  pending: ReadonlyArray<ApprovalRequest>,
): ChoiceInteraction {
  return {
    kind: "choice",
    id: `approval-resolve-${Date.now().toString(36)}`,
    scope: "approval-resolve",
    options: pending.slice(0, 5).map((request) => ({
      value: `${intent} ${request.id}`,
      label: truncateReason(request.reason),
    })),
  };
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
  // The approve/reject intent was already decided by the planner's verb
  // choice; extraction only picks WHICH row. With exactly one pending row
  // there is no selection judgment left, so skip the model call — this keeps
  // single-approval resolution deterministic (and keyless).
  const [onlyPending] = pending;
  if (pending.length === 1 && onlyPending) {
    return {
      requestId: onlyPending.id,
      reason: userText.trim() || `user ${intent}d`,
    };
  }
  if (typeof runtime.useModel !== "function") {
    return { requestId: null, reason: null };
  }
  // LLM resolution path for natural-language approval decisions.
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
  const raw = await runWithTrajectoryPurpose("lifeops-resolve-request", () =>
    runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
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

async function persistSentMailCommitments(args: {
  runtime: IAgentRuntime;
  request: ApprovalRequest;
  sentAt: Date;
}): Promise<void> {
  if (args.request.action !== "send_email") return;
  const payload = args.request.payload;
  if (payload.action !== "send_email") return;
  const adapter = (args.runtime as { adapter?: { db?: unknown } }).adapter;
  if (!adapter?.db) {
    logger.debug(
      `[approval] commitment ledger unavailable for sent email approval ${args.request.id}; runtime has no SQL adapter`,
    );
    return;
  }

  const records = extractCommitmentLedgerRecords({
    agentId: args.runtime.agentId,
    source: "sent_mail",
    sourceKey: `approval:${args.request.id}`,
    text: payload.body,
    observedAt: args.sentAt.toISOString(),
    counterparty: payload.to.join(", ") || null,
    metadata: {
      approvalRequestId: args.request.id,
      subject: payload.subject,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      replyToMessageId: payload.replyToMessageId,
    },
  });
  if (records.length === 0) return;

  const repository = new LifeOpsRepository(args.runtime);
  try {
    for (const record of records) {
      await repository.upsertCommitmentLedgerRecord(record);
    }
  } catch (error) {
    // error-policy:J7 the sent email is already committed externally; report the
    // projection failure without making the approval retriable and duplicating mail.
    logger.warn(
      `[approval] failed to project sent email approval ${args.request.id} into commitment ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
    args.runtime.reportError?.("lifeops:commitment-ledger:sent-mail", error, {
      requestId: args.request.id,
    });
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
    await persistSentMailCommitments({
      runtime: args.runtime,
      request: args.request,
      sentAt: done.updatedAt,
    });
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

  if (args.request.action === "execute_workflow") {
    const payload = args.request.payload;
    if (payload.action !== "execute_workflow") {
      throw new Error(
        `[approval] action/payload mismatch: action=execute_workflow, payload.action=${payload.action}`,
      );
    }
    await args.queue.markExecuting(args.request.id);
    // The owner's approval IS the browser-action confirmation: these
    // approvals exist precisely to gate browser dispatch behind consent.
    const run = await service.runWorkflow(payload.workflowId, {
      confirmBrowserActions: true,
    });
    const done = await args.queue.markDone(args.request.id);
    const text = `Approved and ran workflow ${payload.workflowId} (run ${run.id}: ${run.status}).`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        workflowId: payload.workflowId,
        workflowRunId: run.id,
        workflowRunStatus: run.status,
      },
    };
  }

  if (args.request.action === "schedule_event") {
    const payload = args.request.payload;
    if (payload.action !== "schedule_event") {
      throw new Error(
        `[approval] action/payload mismatch: action=schedule_event, payload.action=${payload.action}`,
      );
    }
    await args.queue.markExecuting(args.request.id);
    // Missing/unconnected calendar credentials throw here and propagate —
    // invoking the rail and surfacing its failure IS the honest execution.
    const event = await service.createCalendarEvent(INTERNAL_URL, {
      ...(payload.calendarId ? { calendarId: payload.calendarId } : {}),
      title: payload.title,
      startAt: new Date(payload.startsAtMs).toISOString(),
      endAt: new Date(payload.endsAtMs).toISOString(),
      ...(payload.location ? { location: payload.location } : {}),
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.attendees.length > 0
        ? { attendees: payload.attendees.map((email) => ({ email })) }
        : {}),
    });
    const done = await args.queue.markDone(args.request.id);
    const text = `Approved and scheduled "${event.title}" (${event.startAt} – ${event.endAt}).`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        calendarEventId: event.id,
        calendarId: event.calendarId,
      },
    };
  }

  if (args.request.action === "make_call") {
    const payload = args.request.payload;
    if (payload.action !== "make_call") {
      throw new Error(
        `[approval] action/payload mismatch: action=make_call, payload.action=${payload.action}`,
      );
    }
    // Missing credentials is a real, typed execution outcome: the approved
    // call cannot be placed until Twilio is configured. The request stays
    // `approved` so the owner can retry after setting the env vars.
    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      const text = `Approved the call to ${payload.to}, but Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) — the call was not placed.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "TWILIO_NOT_CONFIGURED",
          action: args.request.action,
          requestId: args.request.id,
          state: args.request.state,
        },
      };
    }
    await args.queue.markExecuting(args.request.id);
    const delivery = await sendTwilioVoiceCall({
      credentials,
      to: payload.to,
      message: payload.script,
    });
    if (!delivery.ok) {
      const detail = delivery.error ?? `status ${delivery.status}`;
      const text = `Approved the call to ${payload.to}, but the Twilio dispatch failed (${detail}) — the call was not placed.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "TWILIO_DELIVERY_FAILED",
          detail,
          status: delivery.status,
          action: args.request.action,
          requestId: args.request.id,
        },
      };
    }
    const done = await args.queue.markDone(args.request.id);
    const text = `Approved and placed the call to ${payload.to}${
      delivery.sid ? ` (sid ${delivery.sid})` : ""
    }.`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        callSid: delivery.sid ?? null,
      },
    };
  }

  if (args.request.action === "sign_document") {
    const payload = args.request.payload;
    if (payload.action !== "sign_document") {
      throw new Error(
        `[approval] action/payload mismatch: action=sign_document, payload.action=${payload.action}`,
      );
    }
    await args.queue.markExecuting(args.request.id);
    const doc = dispatchApprovedSignatureRequest(
      args.runtime,
      payload.documentId,
    );
    if (!doc) {
      const text = `Approved the signature request for "${payload.documentName}", but DocumentRequest ${payload.documentId} no longer exists (the document store does not survive restarts) — nothing was dispatched. Please re-issue the signature request.`;
      await args.callback?.({ text });
      return {
        text,
        success: false,
        data: {
          error: "DOCUMENT_REQUEST_NOT_FOUND",
          action: args.request.action,
          requestId: args.request.id,
          documentId: payload.documentId,
        },
      };
    }
    const done = await args.queue.markDone(args.request.id);
    const text = `Approved and dispatched the signature request for "${doc.title}" (now ${doc.status}).`;
    await args.callback?.({ text });
    return {
      text,
      success: true,
      data: {
        requestId: done.id,
        state: done.state,
        action: done.action,
        documentId: doc.id,
        documentStatus: doc.status,
      },
    };
  }

  // No executor exists for this action (spend_money, modify_event,
  // cancel_event). spend_money has no spend rail to wire:
  // @elizaos/plugin-finances is read-only — payment-source tracking, CSV
  // import, and spending summaries — and initiates no purchases or
  // transfers. Approving must never report success while executing
  // nothing — surface the gap instead (issue #10723).
  logger.error(
    `[OwnerResolveRequest] request ${args.request.id} approved but no executor exists for action ${args.request.action}; nothing was executed`,
  );
  const text = `Approved request ${args.request.id}, but no executor exists for action "${args.request.action}" — nothing was executed.`;
  await args.callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: "NO_EXECUTOR",
      action: args.request.action,
      requestId: args.request.id,
      state: args.request.state,
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
    typeof message.content.text === "string" ? message.content.text : "";
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
    // Ambiguous target with pending rows: ask with one-tap chips instead of
    // demanding a typed id (#14733).
    const text =
      pending.length === 0
        ? "There are no pending approval requests."
        : appendInteractionBlock(
            "Which request?",
            buildResolveRequestChoice(intent, pending),
          );
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
    // Lost compare-and-swap race (e.g. the request expired while the owner's
    // approval was in flight). Must be matched before the parent
    // ApprovalStateTransitionError and surfaced: nothing was executed.
    if (error instanceof ApprovalTransitionConflictError) {
      const text = `Request ${error.requestId} changed state to "${error.from}" while I was resolving it — nothing was executed.`;
      if (callback) await callback({ text });
      return {
        text,
        success: false,
        data: {
          error: "TRANSITION_CONFLICT",
          requestId: error.requestId,
          state: error.from,
        },
      };
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
    "ADMIN_REJECT_APPROVAL",
    "REJECT_APPROVAL",
    "DENY_APPROVAL",
    "DECLINE_APPROVAL",
  ],
  tags: [
    "domain:meta",
    "capability:execute",
    "capability:update",
    "surface:internal",
    "risk:irreversible",
  ],
  description:
    "Approve/reject pending owner-confirmation action: send_email, send_message, book_travel, voice_call, etc. " +
    "Subactions approve|reject. Reject also covers holds ('don't send it', 'not yet', 'wait until I confirm') — " +
    "it terminally cancels the queued dispatch and a fresh request can be queued later. " +
    "requestId optional; handler inspects pending queue, infers owner intent, or asks follow-up.",
  descriptionCompressed:
    "approve|reject pending approval queue; reject=hold/don't-send-now (nothing dispatches); requestId optional",
  contexts: [
    "email",
    "messaging",
    "calendar",
    "tasks",
    "contacts",
    "payments",
    "automation",
    "admin",
    "general",
  ],
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  parameters: [
    {
      name: "action",
      description: "approve | reject.",
      required: false,
      schema: { type: "string" as const, enum: ["approve", "reject"] },
    },
    {
      name: "requestId",
      description:
        "Approval request id. Optional when user references pending request.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Optional approve/reject reason, user language.",
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
          text: "Yeah, go ahead and send that draft.",
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
