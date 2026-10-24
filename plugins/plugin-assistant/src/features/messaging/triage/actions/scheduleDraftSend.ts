/**
 * The deferred-send action for the messaging-triage capability, registered
 * under the shared `MESSAGE` action name. Given an existing draft id and a
 * target time, it schedules the draft through an authoritative adapter-native
 * remote schedule or the canonical durable ScheduledTask runner. The returned
 * confirmation is bound to the provider or task-store commit receipt.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import {
  draftConsentDigest,
  requireSendConsent,
  sendConsentDigest,
} from "../send-consent.ts";
import { getSendPolicy } from "../send-policy.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import {
  draftIdParameter,
  parseScheduleDraftSendParams,
  validateMessageAction,
} from "./_shared.ts";

export function formatSendAtIso(sendAtMs: number): string {
  if (!Number.isFinite(sendAtMs)) {
    throw new ElizaError(
      `Invalid sendAtMs: ${String(sendAtMs)} is not finite`,
      {
        code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
        context: { sendAtMs },
      },
    );
  }
  const date = new Date(sendAtMs);
  if (Number.isNaN(date.getTime())) {
    throw new ElizaError(
      `Invalid sendAtMs: ${String(sendAtMs)} is out of Date range`,
      {
        code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
        context: { sendAtMs },
      },
    );
  }
  return date.toISOString();
}

export const scheduleDraftSendAction: Action = {
  name: "MESSAGE",
  contexts: ["messaging", "email", "calendar", "automation"],
  roleGate: { minRole: "ADMIN" },
  description:
    "Schedule a previously created draft to send at a future time. Uses authoritative adapter-native scheduling when supported and otherwise persists a one-shot task in the shared scheduler.",
  descriptionCompressed: "schedule draft send sendAt durable shared scheduler",
  tags: [
    "domain:messages",
    "capability:schedule",
    "capability:send",
    "effect:receipt-required",
  ],
  similes: ["DEFER_SEND", "SCHEDULE_SEND", "SEND_LATER"],
  parameters: [
    draftIdParameter,
    {
      name: "sendAt",
      description:
        "When to send the draft, as an ISO 8601 timestamp or epoch milliseconds.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "User",
        content: { text: "Send that draft tomorrow at 9am" },
      },
      {
        name: "Agent",
        content: {
          text: "Scheduled.",
          action: "MESSAGE",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    validateMessageAction(message, state, [
      "messaging",
      "email",
      "calendar",
      "automation",
    ]),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const parsed = parseScheduleDraftSendParams(options);
    if ("error" in parsed) {
      logger.warn(`[ScheduleDraftSend] ${parsed.error}`);
      return { success: false, text: parsed.error, error: parsed.error };
    }
    const sendAtIso = formatSendAtIso(parsed.sendAtMs);

    const service = getDefaultTriageService();
    const existing = service.getDraft(runtime, parsed.draftId);
    if (!existing) {
      const msg = `No draft found for id ${parsed.draftId}`;
      logger.warn(`[ScheduleDraftSend] ${msg}`);
      return { success: false, text: msg, error: msg };
    }

    // A connector that routes sends through the owner approval queue cannot
    // take a scheduled send: the queue holds the draft until the owner
    // approves, and that is the send_draft path. Decide this before asking,
    // so the owner is never asked to confirm something that cannot run.
    const policy = getSendPolicy(runtime);
    if (
      policy &&
      (await policy.shouldRequireApproval(runtime, {
        source: existing.source,
        inReplyToId: existing.inReplyToId,
        threadId: existing.threadId,
        to: existing.to,
        subject: existing.subject,
        body: existing.body,
        worldId: existing.worldId,
        channelId: existing.channelId,
        metadata: existing.metadata,
      }))
    ) {
      const msg = `Draft ${parsed.draftId} needs owner approval before it is sent; use send_draft so it goes through the approval queue instead of a timer.`;
      logger.warn(`[ScheduleDraftSend] ${msg}`);
      return { success: false, text: msg, error: msg, continueChain: false };
    }

    // Scheduling is a send with a later clock: it passes the same owner
    // consent gate as sending now, bound to a later user message, to this
    // exact draft and to this exact send time. A changed draft or a changed
    // time is a new ask. The one-shot dispatcher sends without a user turn,
    // so the consent has to be given here.
    const consent = await requireSendConsent(
      runtime,
      message,
      sendConsentDigest({
        draft: draftConsentDigest(existing),
        sendAt: sendAtIso,
      }),
      { draftId: existing.draftId, source: existing.source },
    );
    if (consent === "cancelled") {
      return {
        success: false,
        text: "Nothing was scheduled.",
        continueChain: false,
      };
    }
    if (consent === "pending") {
      const text = `Here's what I'm about to schedule for ${sendAtIso}: ${existing.preview} — want me to schedule it?`;
      logger.info(
        `[ScheduleDraftSend] confirmation gate: draftId=${parsed.draftId}`,
      );
      if (callback) await callback({ text, action: "MESSAGE" });
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
        continueChain: false,
        data: {
          requiresConfirmation: true,
          preview: existing.preview,
          draftId: existing.draftId,
          source: existing.source,
          sendAt: sendAtIso,
        },
      };
    }

    const updated = await service.scheduleDraftSend(
      runtime,
      parsed.draftId,
      parsed.sendAtMs,
    );

    const text = `Scheduled draft ${parsed.draftId} for ${sendAtIso}.`;
    const commit = updated.scheduleCommit;
    if (!commit) {
      throw new ElizaError(
        `Scheduled draft ${parsed.draftId} returned without commit proof.`,
        {
          code: "MESSAGE_DRAFT_SCHEDULE_RECEIPT_MISSING",
          context: { draftId: parsed.draftId, sendAtMs: parsed.sendAtMs },
          severity: "fatal",
        },
      );
    }
    const receipt: EffectReceipt = {
      receiptId: `message-schedule:${commit.kind}:${commit.id}`,
      operation: "message.draft.schedule",
      resource: {
        kind: "messaging.deferred_send",
        id: commit.id,
      },
      artifacts: [
        {
          kind: "messaging.draft",
          id: updated.draftId,
        },
      ],
      idempotency: {
        key: commit.idempotencyKey,
        replayed: commit.replayed,
      },
      observedAt: new Date().toISOString(),
      outcome: "applied",
      commit: {
        kind: commit.kind,
        id: commit.id,
        committedAt: commit.committedAt,
      },
    };
    logger.info(
      `[ScheduleDraftSend] draftId=${parsed.draftId} sendAtMs=${parsed.sendAtMs} scheduledId=${updated.scheduledId ?? "unknown"}`,
    );
    if (callback) {
      await callback({ text, action: "MESSAGE" });
    }
    return {
      success: true,
      text,
      verifiedUserFacing: true,
      userFacingText: text,
      effectReceipts: [receipt],
      userFacingEffectReceiptIds: [receipt.receiptId],
      data: {
        draftId: updated.draftId,
        source: updated.source,
        scheduledForMs: updated.scheduledForMs ?? parsed.sendAtMs,
        scheduledId: updated.scheduledId ?? null,
      },
    };
  },
};
