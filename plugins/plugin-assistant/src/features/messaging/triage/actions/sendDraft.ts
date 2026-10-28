/**
 * The outbound compose-and-send action for the messaging-triage capability,
 * registered under the shared `MESSAGE` action name. When no draft id is
 * supplied it extracts the target platform, recipient, and body from the user's
 * request (via `outboundDraftOptionsFromMessage`, which is model-driven so it
 * works in any language) and persists a draft; when a draft id is supplied it
 * sends that draft. A source whose adapter cannot send a new message is
 * refused before any draft or preview is created.
 *
 * Two independent gates guard every send. Legacy clients need a later user
 * confirmation bound to the preview. An authenticated foreground device request
 * can explicitly opt into an immediate Gmail send; message metadata cannot. The
 * owner SendPolicy gate (when a policy is registered) can defer any send for
 * owner approval, enqueuing the sendDraft executor for later replay.
 *
 * `outboundDraftOptionsFromMessage` is exported for the unit tests in
 * `sendDraft.test.ts`.
 */
import type {
  Action,
  ActionExample,
  ActionParameter,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger, ModelType, parseKeyValueXml } from "@elizaos/core";
import {
  draftConsentDigest,
  pendingSendDraft,
  requireSendConsent,
} from "../send-consent.ts";
import { getSendPolicy } from "../send-policy.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import type { DraftRecord, DraftRequest } from "../types.ts";
import {
  bodyParameter,
  draftIdParameter,
  parseDraftFollowupParams,
  parseSendDraftParams,
  validateMessageAction,
} from "./_shared.ts";

const OUTBOUND_DRAFT_PARAMETERS: ActionParameter[] = [
  {
    name: "source",
    description:
      "Message source for a new outbound draft. Its connected adapter must support sending a new message (the gmail, discord and twitter adapters do).",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "to",
    description:
      "Recipient identifiers, contact names, handles, channels, rooms, or recipient objects for a new outbound draft.",
    required: false,
    schema: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  { ...bodyParameter, required: false },
  {
    name: "subject",
    description: "Optional subject for email-like sources.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "threadId",
    description:
      "Existing thread ID returned by the selected message source. Omit for a new email; never use the current conversation ID.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "channelId",
    description:
      "Platform channel ID returned by the selected source. A new discord draft requires it. Omit for Gmail.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "worldId",
    description:
      "Exact account/server scope ID returned by the selected adapter. Omit for the default account. An email address or conversation ID is not a scope ID; never invent one.",
    required: false,
    schema: { type: "string" as const },
  },
];

function getParameters(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const params = options?.parameters;
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeSource(value: unknown): string | undefined {
  const raw = nonEmptyString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === "x" || raw === "twitter") return "twitter";
  if (raw === "email" || raw === "mail") return "gmail";
  if (raw === "sms" || raw === "text") return "imessage";
  return raw;
}

/**
 * Extract the outbound-draft fields (platform, recipient, message body) the user
 * asked to send, using the model's structured output instead of English-only
 * regex/keyword parsing (#10470). Fields the request doesn't specify come back
 * empty; the caller still enforces that a body + recipient are present. Model
 * failures propagate through the action boundary so an outage is never
 * presented as missing user input.
 */
async function extractOutboundDraftFromText(
  runtime: IAgentRuntime,
  text: string,
): Promise<{
  source?: string;
  recipient?: string;
  subject?: string;
  body?: string;
}> {
  if (!text.trim()) return {};
  const prompt = `A user asked the agent to send an outbound message. Extract the parts of the request — this must work in any language, so do not rely on English keywords.

Request:
${text}

Return ONLY this XML, leaving a field empty when the request does not specify it:
<response>
<source>the platform/app to send on — one of telegram, discord, whatsapp, imessage, gmail, twitter — or empty</source>
<recipient>who to send to (a name, @handle, or contact), or empty</recipient>
<subject>the exact email subject requested by the user, or empty</subject>
<body>the exact message text to send, or empty</body>
</response>`;
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  // Tolerate models that omit the wrapper or wrap the XML in a code fence —
  // parseKeyValueXml reads the direct children of a <response> block.
  const cleaned = raw.replace(/```(?:xml)?/gi, "").trim();
  const wrapped = cleaned.includes("<response>")
    ? cleaned
    : `<response>${cleaned}</response>`;
  const parsed = parseKeyValueXml(wrapped) ?? {};
  return {
    source: nonEmptyString(parsed.source),
    recipient: nonEmptyString(parsed.recipient),
    subject: nonEmptyString(parsed.subject),
    body: nonEmptyString(parsed.body),
  };
}

export async function outboundDraftOptionsFromMessage(
  runtime: IAgentRuntime,
  message: Memory,
  options: HandlerOptions | undefined,
): Promise<HandlerOptions | undefined> {
  const params = getParameters(options);
  const text =
    typeof message.content.text === "string" ? message.content.text : "";

  // Structured params from the planner/tool-call win; only invoke the model to
  // fill the gaps (cheap no-LLM fast path when they are already complete).
  const paramSource = normalizeSource(
    params.source ?? params.platform ?? params.connector ?? params.service,
  );
  const paramBody = nonEmptyString(
    params.body ?? params.text ?? params.message ?? params.content,
  );
  const paramTo =
    params.to ??
    params.recipient ??
    params.target ??
    params.channel ??
    params.room;
  const haveParamTo = Array.isArray(paramTo)
    ? paramTo.length > 0
    : nonEmptyString(paramTo) !== undefined;

  const extracted =
    paramSource && paramBody && haveParamTo
      ? {}
      : await extractOutboundDraftFromText(runtime, text);

  const source = paramSource ?? normalizeSource(extracted.source);
  const body = paramBody ?? extracted.body;
  const subject = nonEmptyString(params.subject) ?? extracted.subject;
  const rawTo = paramTo ?? extracted.recipient;
  const to = Array.isArray(rawTo)
    ? rawTo
    : nonEmptyString(rawTo)
      ? [rawTo]
      : undefined;

  return {
    ...options,
    parameters: {
      ...params,
      ...(source ? { source } : {}),
      ...(body ? { body } : {}),
      ...(subject ? { subject } : {}),
      ...(to ? { to } : {}),
    },
  };
}

function previewOutboundDraft(
  record: Pick<DraftRecord, "source" | "to" | "body" | "subject" | "worldId">,
): string {
  const recipients = record.to
    .map((recipient) =>
      recipient.displayName
        ? `${recipient.displayName} <${recipient.identifier}>`
        : recipient.identifier,
    )
    .join(", ");
  const subject = record.subject ? `Subject: ${record.subject}\n` : "";
  return `[${record.source}${record.worldId ? ` account ${record.worldId}` : ""}] To: ${recipients}\n${subject}${record.body}`;
}

/**
 * MESSAGE requires either the later-turn confirmation or an authenticated,
 * current device request bound to the exact Gmail draft. Model parameters and
 * message metadata never supply that authority.
 */
export const sendDraftAction: Action = {
  name: "MESSAGE",
  contexts: ["messaging", "email", "contacts"],
  roleGate: { minRole: "ADMIN" },
  description:
    "Create or send an owner-scoped outbound message draft. Use this for first-turn requests like 'DM Bob on Discord' and 'email Alice the notes'. The source's adapter must support sending a new message. It previews the exact draft and requires a later affirmative user reply before sending. For a plain later confirmation, omit draftId and message fields: the host resolves and checks the reviewed draft. Never invent an ID or restore history just to find one.",
  descriptionCompressed:
    "outbound draft/send Discord|email|X DM; host enforces current-device Gmail policy or later confirmation",
  similes: [
    "DISPATCH_DRAFT",
    "CONFIRM_AND_SEND",
    "COMPOSE_MESSAGE",
    "OUTBOUND_MESSAGE",
  ],
  parameters: [
    { ...draftIdParameter, required: false },
    ...OUTBOUND_DRAFT_PARAMETERS,
  ],
  examples: [
    [
      {
        name: "User",
        content: { text: "Send the draft" },
      },
      {
        name: "Agent",
        content: {
          text: "Sent.",
          action: "MESSAGE",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => validateMessageAction(message, state),

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    let parsed = parseSendDraftParams(options);
    let currentRequestConfirmed = false;
    const service = getDefaultTriageService();
    // A whole-turn affirmation refers to the host's latest reviewed draft.
    // Planner content or an invented ID cannot redirect it. A different draft
    // the planner names explicitly is kept: the digest gate below then
    // re-previews it instead of sending the earlier armed draft.
    const pendingId = await pendingSendDraft(runtime, _message);
    if (pendingId && service.getDraft(runtime, pendingId)) {
      const named = "error" in parsed ? undefined : parsed.draftId;
      if (!named || named === pendingId || !service.getDraft(runtime, named))
        parsed = { draftId: pendingId };
    }
    if ("error" in parsed) {
      const draftParsed = parseDraftFollowupParams(
        await outboundDraftOptionsFromMessage(runtime, _message, options),
      );
      if ("error" in draftParsed) {
        const text = `Could not create outbound draft: ${draftParsed.error}.`;
        logger.warn(`[SendDraft] ${text}`);
        return {
          success: false,
          text,
          error: draftParsed.error,
          continueChain: false,
          data: {
            actionName: "MESSAGE",
            error: "MISSING_DRAFT_DETAILS",
            requiresInput: true,
          },
        };
      }

      // Refuse before the preview: a draft that no adapter can deliver would
      // ask the user to confirm a send that then fails.
      const adapter = service.getAdapter(draftParsed.source);
      const unsupported = !adapter
        ? "no adapter is connected"
        : !adapter.isAvailable(runtime)
          ? "its adapter is unavailable"
          : adapter.capabilities().send.new !== true
            ? "its adapter does not support sending a new message"
            : undefined;
      if (unsupported) {
        const text = `${draftParsed.source} cannot send a new message from a draft: ${unsupported}. Use action=send for a direct connector send.`;
        logger.warn(`[SendDraft] ${text}`);
        return {
          success: false,
          text,
          error: text,
          continueChain: false,
          data: { actionName: "MESSAGE", error: "DRAFT_SEND_UNSUPPORTED" },
        };
      }

      const record = await service.draftFollowup(runtime, {
        requester: _message,
        source: draftParsed.source,
        to: draftParsed.to,
        subject: draftParsed.subject,
        body: draftParsed.body,
        threadId: draftParsed.threadId,
        worldId: draftParsed.worldId,
        channelId: draftParsed.channelId,
      });
      const initialConsent = await requireSendConsent(
        runtime,
        _message,
        draftConsentDigest(record),
        {
          draftId: record.draftId,
          source: record.source,
          requestMessageId: _message.id,
        },
      );
      if (initialConsent === "confirmed") {
        parsed = { draftId: record.draftId };
        currentRequestConfirmed = true;
      } else {
        const recipients = record.to
          .map((recipient) =>
            recipient.displayName
              ? `${recipient.displayName} <${recipient.identifier}>`
              : recipient.identifier,
          )
          .join(", ");
        const text = `Drafted ${record.source} message to ${recipients}.\n${previewOutboundDraft(record)}\nConfirm before I send it.`;
        logger.info(
          `[SendDraft] created outbound draft draftId=${record.draftId} source=${record.source}`,
        );
        if (callback) {
          await callback({ text, action: "MESSAGE" });
        }
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          turnComplete: true,
          continueChain: false,
          data: {
            requiresConfirmation: true,
            preview: record.preview,
            draftId: record.draftId,
            source: record.source,
            to: record.to,
          },
        };
      }
    }

    const existing = service.getDraft(runtime, parsed.draftId);
    if (!existing) {
      const msg = `No draft found for id ${parsed.draftId}`;
      logger.warn(`[SendDraft] ${msg}`);
      return { success: false, text: msg, error: msg };
    }

    const consentDigest = draftConsentDigest(existing);
    const consent = currentRequestConfirmed
      ? "confirmed"
      : await requireSendConsent(runtime, _message, consentDigest, {
          draftId: existing.draftId,
          source: existing.source,
        });
    if (consent === "cancelled")
      return {
        success: false,
        text: "Nothing was sent. Preview the draft again before confirming.",
        continueChain: false,
      };
    if (consent === "pending") {
      // The confirm prompt is the designed ask the user must answer:
      // verified + turnComplete make it the sole delivery, worded like a
      // person asking; the draftId stays planner-facing in data.
      const text = `Here's what I'm about to send: ${previewOutboundDraft(existing)} — want me to send it?`;
      logger.info(`[SendDraft] confirmation gate: draftId=${parsed.draftId}`);
      if (callback) {
        await callback({ text, action: "MESSAGE" });
      }
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
        },
      };
    }

    // Owner-policy gate (separate from the user-confirmation gate above):
    // hosts can register a SendPolicy that defers any outbound send until
    // owner approval. When the policy enqueues, we report pending and
    // hand the executor (sendDraft) over for later replay.
    const policy = getSendPolicy(runtime);
    if (policy) {
      const draftReq: DraftRequest = {
        source: existing.source,
        inReplyToId: existing.inReplyToId,
        threadId: existing.threadId,
        to: existing.to,
        subject: existing.subject,
        body: existing.body,
        worldId: existing.worldId,
        channelId: existing.channelId,
        metadata: existing.metadata,
      };
      const required = await policy.shouldRequireApproval(runtime, draftReq);
      if (required) {
        const enq = await policy.enqueueApproval(runtime, draftReq, () =>
          service
            .sendDraft(runtime, parsed.draftId, consentDigest, _message)
            .then((rec) => ({
              externalId: rec.sentExternalId ?? `pending:${rec.draftId}`,
            })),
        );
        // The pending-approval notice is the complete answer to this turn:
        // verified + turnComplete make it the sole delivery, human-worded;
        // draft/request ids stay planner-facing in data.
        const text =
          "This one needs the owner's approval before it goes out — I've requested it and will send it once approved.";
        logger.info(
          `[SendDraft] policy hold: draftId=${parsed.draftId} requestId=${enq.requestId}`,
        );
        if (callback) {
          await callback({ text, action: "MESSAGE" });
        }
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          turnComplete: true,
          continueChain: false,
          data: {
            requiresConfirmation: true,
            pending: true,
            requestId: enq.requestId,
            preview: enq.preview,
            draftId: existing.draftId,
            source: existing.source,
          },
        };
      }
    }

    const sent = await service.sendDraft(
      runtime,
      parsed.draftId,
      consentDigest,
      _message,
    );
    // The sent confirmation is the complete answer to a single-operation
    // turn: verified + turnComplete make it the sole delivery; the draftId
    // stays planner-facing in data.
    const text = "Sent it.";
    logger.info(
      `[SendDraft] sent draftId=${parsed.draftId} externalId=${sent.sentExternalId ?? "unknown"}`,
    );
    if (callback) {
      await callback({ text, action: "MESSAGE" });
    }
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      data: {
        draftId: sent.draftId,
        source: sent.source,
        externalId: sent.sentExternalId ?? null,
      },
    };
  },
};
