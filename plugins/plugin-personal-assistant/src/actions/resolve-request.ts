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
import {
  hasOwnerAccess,
  ApprovalNotFoundError as RuntimeApprovalNotFoundError,
  ApprovalStateTransitionError as RuntimeApprovalStateTransitionError,
} from "@elizaos/agent";
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
  ApprovalQueueCompatibilityError,
  type ApprovalRequest,
  ApprovalStateTransitionError,
} from "../lifeops/approval-queue.types.js";
import { extractCommitmentLedgerRecords } from "../lifeops/commitments/index.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeApprovedBookTravel } from "./book-travel.js";
import {
  dispatchApprovedSignatureRequest,
  getDocumentRequest,
} from "./document.js";
import {
  type ApprovalDispatchOutcome,
  recoverInterruptedApproval,
  runApprovalDispatch,
} from "./lib/approval-execution.js";
import {
  ApprovalConnectorPreflightError,
  ApprovalKnownNonDeliveryError,
  type CrossChannelSendChannel,
  prepareCrossChannelSend,
} from "./lib/messaging-helpers.js";
import { formatPromptValue } from "./lib/prompt-format.js";

const ACTION_NAME = "RESOLVE_REQUEST";

type ResolveSubaction =
  | "approve"
  | "reject"
  | "reconcile_delivered"
  | "reconcile_not_delivered";

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
  reconcile_delivered: {
    description:
      "Record provider-confirmed delivery for an ambiguous approval attempt.",
    descriptionCompressed:
      "reconcile ambiguous approval as provider-confirmed delivered",
    required: ["requestId"],
    optional: ["reason", "providerReceiptId"],
  },
  reconcile_not_delivered: {
    description:
      "Record provider-confirmed non-delivery so an approval can be retried.",
    descriptionCompressed:
      "reconcile ambiguous approval as provider-confirmed not delivered",
    required: ["requestId"],
    optional: ["reason", "providerReceiptId"],
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
  readonly providerReceiptId?: string;
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

async function dispatchFailureResult(args: {
  request: ApprovalRequest;
  outcome: Exclude<ApprovalDispatchOutcome<unknown>, { kind: "delivered" }>;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const reconciliationRequired =
    args.outcome.kind === "reconciliation_required";
  const text = reconciliationRequired
    ? `The provider outcome for request ${args.request.id} is ambiguous. I will not retry it until the owner or provider reconciles delivery.`
    : `Request ${args.request.id} was not delivered and is safe to retry.`;
  await args.callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: reconciliationRequired
        ? "APPROVAL_RECONCILIATION_REQUIRED"
        : "APPROVAL_DELIVERY_FAILED_RETRYABLE",
      detail: args.outcome.error.message,
      requestId: args.request.id,
      state: args.outcome.request.state,
      action: args.request.action,
      attemptId: args.outcome.request.execution?.attemptId ?? null,
      executed: reconciliationRequired ? null : false,
      deliveryUnknown: reconciliationRequired,
    },
  };
}

function preflightFailureResult(
  request: ApprovalRequest,
  error: unknown,
): ActionResult {
  const known = error instanceof ApprovalConnectorPreflightError;
  return {
    text: "",
    success: false,
    data: {
      error: known ? error.code : "APPROVAL_PREFLIGHT_FAILED",
      detail: error instanceof Error ? error.message : String(error),
      requestId: request.id,
      state: request.state,
      action: request.action,
      executed: false,
    },
  };
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
    try {
      if (payload.body.trim().length === 0) {
        throw new ApprovalConnectorPreflightError(
          "INVALID_EMAIL_PAYLOAD",
          "Email body must not be empty",
        );
      }
      if (
        !payload.replyToMessageId &&
        payload.to.every((recipient) => recipient.trim().length === 0)
      ) {
        throw new ApprovalConnectorPreflightError(
          "INVALID_EMAIL_PAYLOAD",
          "A new email requires at least one recipient",
        );
      }
      await service.requireGoogleGmailSendGrant(INTERNAL_URL, "local", "owner");
      if (payload.replyToMessageId) {
        await service.readGmailMessage(INTERNAL_URL, {
          mode: "local",
          side: "owner",
          messageId: payload.replyToMessageId,
        });
      }
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "gmail",
        dispatch: async () => {
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
          return {
            value: undefined,
            receipt: {
              provider: "gmail",
              accepted: true,
              replyToMessageId: payload.replyToMessageId ?? null,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const done = outcome.request;
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
    let prepared: Awaited<ReturnType<typeof prepareCrossChannelSend>>;
    try {
      prepared = await prepareCrossChannelSend({
        runtime: args.runtime,
        service,
        channel,
        target: payload.recipient,
        body: payload.body,
      });
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: prepared.provider,
        dispatch: async (providerIdempotencyKey) => ({
          value: undefined,
          receipt: await prepared.dispatch(providerIdempotencyKey),
        }),
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const done = outcome.request;
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
        providerReceipt: done.execution?.providerReceipt ?? null,
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
    try {
      await service.getWorkflow(payload.workflowId);
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "lifeops-workflow",
        dispatch: async () => {
          // The owner's approval is the browser-action confirmation.
          const run = await service.runWorkflow(payload.workflowId, {
            confirmBrowserActions: true,
          });
          return {
            value: run,
            receipt: {
              provider: "lifeops-workflow",
              workflowRunId: run.id,
              workflowRunStatus: run.status,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const run = outcome.value;
    const done = outcome.request;
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
    try {
      if (
        payload.title.trim().length === 0 ||
        !Number.isFinite(payload.startsAtMs) ||
        !Number.isFinite(payload.endsAtMs) ||
        payload.endsAtMs <= payload.startsAtMs
      ) {
        throw new ApprovalConnectorPreflightError(
          "INVALID_CALENDAR_PAYLOAD",
          "Calendar event requires a title and an end time after its start time",
        );
      }
      await service.requireGoogleCalendarWriteGrant(
        INTERNAL_URL,
        "local",
        "owner",
      );
    } catch (error) {
      return preflightFailureResult(args.request, error);
    }
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "google-calendar",
        dispatch: async () => {
          const event = await service.createCalendarEvent(INTERNAL_URL, {
            ...(payload.calendarId ? { calendarId: payload.calendarId } : {}),
            title: payload.title,
            startAt: new Date(payload.startsAtMs).toISOString(),
            endAt: new Date(payload.endsAtMs).toISOString(),
            ...(payload.location ? { location: payload.location } : {}),
            ...(payload.description
              ? { description: payload.description }
              : {}),
            ...(payload.attendees.length > 0
              ? { attendees: payload.attendees.map((email) => ({ email })) }
              : {}),
          });
          return {
            value: event,
            receipt: {
              provider: "google-calendar",
              eventId: event.id,
              calendarId: event.calendarId,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const event = outcome.value;
    const done = outcome.request;
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
    if (payload.to.trim().length === 0 || payload.script.trim().length === 0) {
      return preflightFailureResult(
        args.request,
        new ApprovalConnectorPreflightError(
          "INVALID_CALL_PAYLOAD",
          "A call requires both a recipient and a non-empty script",
        ),
      );
    }
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
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "twilio-voice",
        dispatch: async (providerIdempotencyKey) => {
          const delivery = await sendTwilioVoiceCall({
            credentials,
            to: payload.to,
            message: payload.script,
            idempotencyKey: providerIdempotencyKey,
          });
          if (!delivery.ok) {
            const detail = delivery.error ?? `status ${delivery.status}`;
            if (delivery.status === null || delivery.status >= 500) {
              throw new Error(detail);
            }
            throw new ApprovalKnownNonDeliveryError(
              "TWILIO_DELIVERY_REJECTED",
              detail,
              delivery.status,
            );
          }
          return {
            value: delivery,
            receipt: {
              provider: "twilio",
              sid: delivery.sid ?? null,
              status: delivery.status,
              retryCount: delivery.retryCount ?? 0,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const delivery = outcome.value;
    const done = outcome.request;
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
    if (!getDocumentRequest(args.runtime, payload.documentId)) {
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
    const outcome = await runApprovalDispatch({
      queue: args.queue,
      request: args.request,
      subjectUserId: args.request.subjectUserId,
      prepared: {
        provider: "lifeops-document",
        dispatch: async () => {
          const doc = dispatchApprovedSignatureRequest(
            args.runtime,
            payload.documentId,
          );
          if (!doc) {
            throw new ApprovalKnownNonDeliveryError(
              "DOCUMENT_REQUEST_NOT_FOUND",
              `DocumentRequest ${payload.documentId} disappeared before dispatch`,
            );
          }
          return {
            value: doc,
            receipt: {
              provider: "lifeops-document",
              documentId: doc.id,
              documentStatus: doc.status,
            },
          };
        },
      },
    });
    if (outcome.kind !== "delivered") {
      return dispatchFailureResult({
        request: args.request,
        outcome,
        callback: args.callback,
      });
    }
    const doc = outcome.value;
    const done = outcome.request;
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

interface SettledDecision {
  readonly text: string;
  readonly result: ActionResult;
}

function completedApprovalReplay(request: ApprovalRequest): SettledDecision {
  const text = `Request ${request.id} already completed successfully — nothing was executed again.`;
  return {
    text,
    result: {
      text,
      success: true,
      data: {
        requestId: request.id,
        state: request.state,
        action: request.action,
        alreadyResolved: true,
        duplicateSuppressed: true,
        executed: false,
      },
    },
  };
}

function rejectedDecisionReplay(request: ApprovalRequest): SettledDecision {
  const text = `Request ${request.id} was already rejected — nothing was dispatched.`;
  return {
    text,
    result: {
      text,
      success: true,
      data: {
        requestId: request.id,
        state: request.state,
        action: request.action,
        alreadyResolved: true,
        duplicateSuppressed: true,
        executed: false,
      },
    },
  };
}

function executionOutcomeUnknown(request: ApprovalRequest): SettledDecision {
  const text = `Request ${request.id} has an ambiguous provider outcome. I did not retry the operation because its delivery must be reconciled first.`;
  return {
    text,
    result: {
      text,
      success: false,
      data: {
        error: "APPROVAL_EXECUTION_OUTCOME_UNKNOWN",
        requestId: request.id,
        state: request.state,
        action: request.action,
        attemptId: request.execution?.attemptId ?? null,
        provider: request.execution?.provider ?? null,
        providerReceipt: request.execution?.providerReceipt ?? null,
        duplicateSuppressed: true,
        executed: null,
        deliveryUnknown: true,
      },
    },
  };
}

function conflictingDecision(
  intent: ResolveSubaction,
  request: ApprovalRequest,
): SettledDecision {
  const text = `Request ${request.id} is already "${request.state}" — I did not ${intent} it, and nothing was executed.`;
  return {
    text,
    result: {
      text,
      success: false,
      data: {
        error: "APPROVAL_DECISION_CONFLICT",
        requestId: request.id,
        state: request.state,
        action: request.action,
        attempted: intent,
        executed: false,
      },
    },
  };
}

/**
 * Classify terminal or claimed rows before attempting another transition.
 * `approved` deliberately falls through: it is the durable outbox state, not
 * proof of execution, so a replay after a pre-dispatch crash may claim it.
 */
function classifySettledDecision(
  intent: ResolveSubaction,
  request: ApprovalRequest,
): SettledDecision | null {
  if (request.state === "reconciliation_required") {
    return executionOutcomeUnknown(request);
  }
  if (intent === "approve") {
    if (request.state === "done") return completedApprovalReplay(request);
    if (request.state === "rejected" || request.state === "expired") {
      return conflictingDecision(intent, request);
    }
    return null;
  }
  if (intent === "reject" && request.state === "rejected") {
    return rejectedDecisionReplay(request);
  }
  if (request.state === "done" || request.state === "expired") {
    return conflictingDecision(intent, request);
  }
  return null;
}

function isKnownApprovalNotFound(
  error: unknown,
): error is ApprovalNotFoundError | RuntimeApprovalNotFoundError {
  return (
    error instanceof ApprovalNotFoundError ||
    error instanceof RuntimeApprovalNotFoundError
  );
}

function isKnownApprovalTransition(
  error: unknown,
): error is ApprovalStateTransitionError | RuntimeApprovalStateTransitionError {
  return (
    error instanceof ApprovalStateTransitionError ||
    error instanceof RuntimeApprovalStateTransitionError
  );
}

async function returnSettledDecision(
  settled: SettledDecision,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  await callback?.({ text: settled.text });
  return settled.result;
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
  let queue: ApprovalQueue;
  try {
    queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  } catch (error) {
    // error-policy:J1 the action boundary converts an incompatible registered
    // queue into a typed denial before any owner decision can be mutated.
    if (error instanceof ApprovalQueueCompatibilityError) {
      return {
        text: "",
        success: false,
        data: {
          error: "APPROVAL_QUEUE_INCOMPATIBLE",
          expectedCapability: "eliza.approval-execution",
          expectedVersion: 2,
          actualCapability:
            error.actualCapability === undefined
              ? null
              : String(error.actualCapability),
          actualVersion:
            error.actualVersion === undefined
              ? null
              : String(error.actualVersion),
        },
      };
    }
    throw error;
  }
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let current = await queue.byId(extracted.requestId, subjectUserId);
    if (!current) return denied("REQUEST_NOT_FOUND");

    try {
      if (
        intent === "reconcile_delivered" ||
        intent === "reconcile_not_delivered"
      ) {
        if (current.state !== "reconciliation_required" || !current.execution) {
          return returnSettledDecision(
            conflictingDecision(intent, current),
            callback,
          );
        }
        const reconciled = await queue.reconcileExecution({
          requestId: current.id,
          subjectUserId,
          attemptId: current.execution.attemptId,
          outcome:
            intent === "reconcile_delivered" ? "delivered" : "not_delivered",
          reconciledBy: subjectUserId,
          reconciliationReason:
            extracted.reason ?? `owner ${intent.replace("_", " ")}`,
          providerReceipt:
            typeof params.providerReceiptId === "string" &&
            params.providerReceiptId.trim().length > 0
              ? {
                  provider: current.execution.provider,
                  receiptId: params.providerReceiptId.trim(),
                }
              : undefined,
        });
        const text =
          reconciled.state === "done"
            ? `Reconciled request ${reconciled.id} as delivered.`
            : `Reconciled request ${reconciled.id} as not delivered; it is now safe to retry.`;
        await callback?.({ text });
        return {
          text,
          success: true,
          data: {
            requestId: reconciled.id,
            state: reconciled.state,
            action: reconciled.action,
            executed: reconciled.state === "done",
            deliveryReconciled: true,
          },
        };
      }

      if (current.state === "executing") {
        current = await recoverInterruptedApproval(
          queue,
          current,
          subjectUserId,
        );
      }
      const settled = classifySettledDecision(intent, current);
      if (settled) return returnSettledDecision(settled, callback);

      if (intent === "reject") {
        const rejected = await queue.reject(
          current.id,
          subjectUserId,
          resolution,
        );
        logger.info(
          `[OwnerResolveRequest] ${intent} ${rejected.id} by ${subjectUserId}`,
        );
        const text = `Rejected request ${rejected.id}.`;
        await callback?.({ text });
        return {
          text,
          success: true,
          data: {
            requestId: rejected.id,
            state: rejected.state,
            action: rejected.action,
          },
        };
      }

      const approved =
        current.state === "approved" || current.state === "retryable"
          ? current
          : await queue.approve(current.id, subjectUserId, resolution);
      return await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
        callback,
      });
    } catch (error) {
      // error-policy:J1 queue CAS failures are translated at the action
      // boundary after an authoritative re-read; unrelated errors propagate.
      if (isKnownApprovalNotFound(error)) {
        return denied("REQUEST_NOT_FOUND");
      }
      if (isKnownApprovalTransition(error)) {
        continue;
      }
      throw error;
    }
  }

  const latest = await queue.byId(extracted.requestId, subjectUserId);
  if (!latest) return denied("REQUEST_NOT_FOUND");
  const settled = classifySettledDecision(intent, latest);
  if (settled) return returnSettledDecision(settled, callback);
  const text = `Request ${latest.id} kept changing state while I was resolving it — nothing was executed.`;
  await callback?.({ text });
  return {
    text,
    success: false,
    data: {
      error: "TRANSITION_CONFLICT",
      requestId: latest.id,
      state: latest.state,
      executed: false,
    },
  };
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
      description:
        "approve | reject | reconcile_delivered | reconcile_not_delivered.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "approve",
          "reject",
          "reconcile_delivered",
          "reconcile_not_delivered",
        ],
      },
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
