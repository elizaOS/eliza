import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent";
import { gmailAction } from "./gmail.js";
import { inboxAction } from "./inbox.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import { searchAcrossChannelsAction } from "./search-across-channels.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OwnerInboxSubaction =
  | "triage"
  | "digest"
  | "respond"
  | "needs_response"
  | "search"
  | "read_message"
  | "draft_reply"
  | "send_reply"
  | "cross_channel_search";

type OwnerInboxChannel =
  | "all"
  | "gmail"
  | "slack"
  | "discord"
  | "sms"
  | "telegram"
  | "whatsapp"
  | "imessage";

type OwnerInboxParams = {
  subaction?: OwnerInboxSubaction;
  channel?: OwnerInboxChannel;
  messageId?: string;
  query?: string;
  senderQuery?: string;
  subjectQuery?: string;
  labelQuery?: string;
  replyBody?: string;
  confirmed?: boolean;
  intent?: string;
  target?: string;
  entryId?: string;
};

const ACTION_NAME = "OWNER_INBOX";
const VALID_SUBACTIONS: readonly OwnerInboxSubaction[] = [
  "triage",
  "digest",
  "respond",
  "needs_response",
  "search",
  "read_message",
  "draft_reply",
  "send_reply",
  "cross_channel_search",
];
const VALID_CHANNELS: readonly OwnerInboxChannel[] = [
  "all",
  "gmail",
  "slack",
  "discord",
  "sms",
  "telegram",
  "whatsapp",
  "imessage",
];

function normalizeSubaction(value: unknown): OwnerInboxSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerInboxSubaction)
    : null;
}

function normalizeChannel(value: unknown): OwnerInboxChannel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_CHANNELS as readonly string[]).includes(normalized)
    ? (normalized as OwnerInboxChannel)
    : null;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

type OwnerInboxLlmPlan = {
  subaction: OwnerInboxSubaction | null;
  channel: OwnerInboxChannel | null;
  shouldAct: boolean | null;
  response?: string;
};

async function resolveOwnerInboxPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: OwnerInboxParams;
}): Promise<OwnerInboxLlmPlan> {
  if (typeof args.runtime.useModel !== "function") {
    return { subaction: null, channel: null, shouldAct: null };
  }

  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 6,
    })
  ).join("\n");

  const prompt = [
    "Plan the OWNER_INBOX subaction for this request.",
    "Return ONLY valid JSON with exactly these fields:",
    '{"subaction":"triage"|"digest"|"respond"|"needs_response"|"search"|"read_message"|"draft_reply"|"send_reply"|"cross_channel_search"|null,"channel":"all"|"gmail"|"slack"|"discord"|"sms"|"telegram"|"whatsapp"|"imessage"|null,"shouldAct":true|false,"response":"string|null"}',
    "",
    "OWNER_INBOX is the OWNER's single umbrella for inbox/email work.",
    "Choose channel=gmail whenever the request explicitly names Gmail or email, or when the request is about a specific email by sender, subject, unread status, drafting an email reply, or sending an email reply.",
    "Gmail-only structured params like messageId, senderQuery, subjectQuery, or labelQuery imply channel=gmail.",
    "Choose channel=all for generic phrases like 'my inbox', 'inbox digest', 'triage my inbox', 'what needs my attention in my inbox', or replying to inbox items across channels.",
    "Do NOT act when the request is a morning brief, night brief, operating picture, command center, what matters today, or a full start-of-day / end-of-day review — those belong to RUN_MORNING_CHECKIN / RUN_NIGHT_CHECKIN even when they include inbox items.",
    "Choose triage for scanning and prioritizing new inbox items.",
    "Choose digest for an inbox-only summary / unread overview / mailbox digest, including prioritised inbox briefs like 'show urgent blockers first and separate them from low-priority inbound', pending-drafts sections in a morning brief, or event-asset checklists before an event.",
    "Choose respond for replying to inbox items across channels when the request is not a Gmail-thread-specific draft/send. Missed-call repair notes, approval-held apology drafts, group-chat handoff suggestions, and 'bump me again with context instead of starting over' inbox policies belong here.",
    "Choose needs_response for Gmail/email requests that ask which messages still need a reply.",
    "Choose search for searching messages, especially Gmail/email search by sender / subject / label / keyword.",
    "Choose read_message for reading a specific Gmail message body by message id.",
    "Choose draft_reply for drafting a reply to a specific Gmail thread or latest email from someone.",
    "Choose send_reply for actually sending a Gmail reply.",
    "Choose cross_channel_search when the user wants everything about a person/topic across all channels.",
    "For standing inbox policies like 'if direct relaying gets messy, suggest a group chat handoff' or inbox repair workflows that are still missing channel details, keep shouldAct=true. OWNER_INBOX can store the policy and ask the minimum follow-up inside the action.",
    "Set shouldAct=false only when the request is not an inbox/email operation and a different action should handle it.",
    "When shouldAct=false, response must be a short clarifying sentence in the user's language.",
    "",
    'Example: "which emails need a response" -> {"subaction":"needs_response","channel":"gmail","shouldAct":true,"response":null}',
    'Example: "find everything Alice said across my channels" -> {"subaction":"cross_channel_search","channel":"all","shouldAct":true,"response":null}',
    'Example: "show urgent blockers first and separate them from low-priority inbound" -> {"subaction":"digest","channel":"all","shouldAct":true,"response":null}',
    'Example: "if direct relaying gets messy here, suggest making a group chat handoff instead" -> {"subaction":"respond","channel":"all","shouldAct":true,"response":null}',
    'Example: "also tell me what drafts still need my sign-off in the morning brief" -> {"subaction":"digest","channel":"all","shouldAct":true,"response":null}',
    'Example: "tell me what slides, bio, title, or portal assets I still owe before the event" -> {"subaction":"digest","channel":"all","shouldAct":true,"response":null}',
    'Example: "if I still haven\'t answered about those three events, bump me again with context instead of starting over" -> {"subaction":"respond","channel":"all","shouldAct":true,"response":null}',
    "",
    `Current request: ${JSON.stringify(messageText(args.message))}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Structured parameters: ${JSON.stringify(args.params)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      return { subaction: null, channel: null, shouldAct: null };
    }
    const subaction = normalizeSubaction(parsed.subaction);
    const channel = normalizeChannel(parsed.channel);
    return {
      subaction,
      channel,
      shouldAct: subaction ? true : normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:owner-inbox",
        error: error instanceof Error ? error.message : String(error),
      },
      "Owner inbox planning model call failed",
    );
    return { subaction: null, channel: null, shouldAct: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function missingSubactionResult(): ActionResult {
  return {
    text:
      "missing subaction; choose triage|digest|respond|needs_response|search|read_message|draft_reply|send_reply|cross_channel_search",
    success: false,
    values: { success: false, error: "MISSING_SUBACTION" },
    data: { actionName: ACTION_NAME },
  };
}

function inferImplicitChannel(
  subaction: OwnerInboxSubaction | null,
  params: OwnerInboxParams,
): OwnerInboxChannel | null {
  if (
    subaction === "needs_response" ||
    subaction === "read_message" ||
    subaction === "draft_reply" ||
    subaction === "send_reply"
  ) {
    return "gmail";
  }
  if (params.messageId || params.senderQuery || params.subjectQuery || params.labelQuery) {
    return "gmail";
  }
  return null;
}

function buildGmailSearchQuery(params: OwnerInboxParams): string | undefined {
  const parts: string[] = [];
  if (params.senderQuery && params.senderQuery.trim()) {
    parts.push(`from:${params.senderQuery.trim()}`);
  }
  if (params.subjectQuery && params.subjectQuery.trim()) {
    parts.push(`subject:${params.subjectQuery.trim()}`);
  }
  if (params.labelQuery && params.labelQuery.trim()) {
    parts.push(`label:${params.labelQuery.trim()}`);
  }
  if (params.query && params.query.trim()) {
    parts.push(params.query.trim());
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function delegateTo(
  action: Action,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  parameters: Record<string, unknown>,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  if (typeof action.handler !== "function") {
    return Promise.resolve({
      text: `[${ACTION_NAME}] Delegate handler missing for ${action.name}.`,
      success: false,
      values: { success: false, error: "HANDLER_MISSING" },
      data: { actionName: ACTION_NAME, delegate: action.name },
    });
  }
  const delegated = {
    ...(options ?? {}),
    parameters: {
      ...(options?.parameters ?? {}),
      ...parameters,
    },
  } as HandlerOptions;
  const delegatedCallback: HandlerCallback | undefined = callback
    ? async (content, files) =>
        callback(
          content && typeof content === "object"
            ? { ...content, action: ACTION_NAME }
            : content,
          files,
        )
    : undefined;
  return Promise.resolve(
    action.handler(runtime, message, state, delegated, delegatedCallback),
  ) as Promise<ActionResult>;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const ownerInboxAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    // Old action names (back-compat)
    "INBOX",
    "GMAIL_ACTION",
    "INBOX_TRIAGE_GMAIL",
    "SEARCH_ACROSS_CHANNELS",
    // Natural-language synonyms
    "GMAIL",
    "EMAIL",
    "CHECK_EMAIL",
    "CHECK_INBOX",
    "UNIFIED_INBOX",
    "DAILY_BRIEF",
    "DAILY_DIGEST",
    "INBOX_DIGEST",
    "INBOX_TRIAGE",
    "INBOX_SUMMARY",
    "TRIAGE_INBOX",
    "SCAN_MESSAGES",
    "CHECK_MESSAGES",
    "UNREAD_EMAILS",
    "EMAIL_UNREAD",
    "SEARCH_EMAIL",
    "DRAFT_EMAIL_REPLY",
    "SEND_EMAIL_REPLY",
    "REPLY_INBOX",
    "RESPOND_TO_MESSAGE",
    "MISSED_CALL_FOLLOWUP",
    "GROUP_CHAT_HANDOFF",
    "GROUP_CHAT_HANDOFF_POLICY",
    "REPAIR_AND_RESCHEDULE_CALL",
    "CONTEXTUAL_BUMP",
    "BUMP_WITH_CONTEXT",
    "EVENT_ASSET_CHECKLIST",
    "OUTSTANDING_EVENT_ASSETS",
    "CROSS_CHANNEL_SEARCH",
    "SEARCH_ALL_CHANNELS",
    "SEARCH_EVERYWHERE",
    "FIND_ACROSS_PLATFORMS",
    "UNIFIED_SEARCH",
  ],
  tags: [
    "always-include",
    "owner inbox",
    "daily brief",
    "cross-channel inbox",
    "gmail",
    "email",
    "unread summary",
    "urgent blockers first",
    "low-priority inbound",
    "missed call repair",
    "group chat handoff",
    "approval-gated reply workflow",
    "pending drafts",
    "event asset checklist",
    "bump me again with context",
  ],
  description:
    "The OWNER's inbox, across every connected messaging channel — Gmail, " +
    "Slack, Discord, SMS, Telegram, iMessage, and WhatsApp. One umbrella " +
    "action for triage, inbox digests, responding to " +
    "messages, and cross-channel search. " +
    "Subactions: triage | digest | respond | needs_response | search | " +
    "read_message | draft_reply | send_reply | cross_channel_search. " +
    "Channel param: all | gmail | slack | discord | sms | telegram | " +
    "whatsapp | imessage. Defaults to 'all'. " +
    "Gmail-specific operations — search by sender/subject/label, read a " +
    "message body, inspect reply-needed threads, draft or send a threaded " +
    "reply — are available when " +
    "channel=gmail (use messageId + replyBody for read_message / draft_reply / " +
    "send_reply; senderQuery / subjectQuery / labelQuery for search). " +
    "Use this for inbox-shaped coordination requests like 'show the urgent blockers first and separate them from low-priority inbound', " +
    "'repair that missed call and hold the note for my approval', 'if direct relaying gets messy, suggest a group chat handoff', 'if I still have not answered about those three events, bump me again with context instead of starting over', 'also tell me what drafts still need my sign-off in the morning brief', or 'tell me what slides, bio, title, or portal assets I still owe before the event'. " +
    "Route here when the user says 'my inbox', 'inbox digest', 'mailbox digest', " +
    "'unified inbox', 'what needs my attention in my inbox', 'triage my messages', or 'show me the unread blockers first' — use " +
    "channel=all. When the user explicitly says 'Gmail' or 'email', or asks " +
    "to search/read/draft/send a specific email reply, route here with " +
    "channel=gmail. Requests like 'draft a reply to the latest email from Sarah' " +
    "and 'send a reply to the last email from finance confirming receipt' " +
    "belong here, not in generic REPLY. When the user asks for cross-channel " +
    "search ('find everything about X across my channels'), use " +
    "subaction=cross_channel_search. If the channel, recipient, or participant " +
    "details are still missing but the request is clearly inbox-owned, still " +
    "select OWNER_INBOX and let it ask the minimum follow-up question. " +
    "Outstanding 'what do I still owe before the event' questions about slides, bios, titles, portal assets, or pending drafts belong here even when the checklist might ultimately come back empty. " +
    "Policies like 'if direct relaying gets messy, suggest a group chat handoff' and 'bump me again with context instead of starting over' belong here even when participant names, platforms, or the exact blocked event still need follow-up. " +
    "DO NOT use this action for explicit morning or night briefings such as " +
    "'run my morning check-in', 'give me my night check-in', 'morning review', " +
    "'morning brief', 'night brief', 'operating picture', 'command center', " +
    "'evening wrap-up', or 'how did today go?' — those belong to " +
    "RUN_MORNING_CHECKIN / RUN_NIGHT_CHECKIN, even if they may include inbox items. " +
    "DO NOT use this action for the agent's own mailbox — that is AGENT_INBOX. " +
    "Admin/owner only.",
  descriptionCompressed:
    "Owner's unified inbox (Gmail + Slack + Discord + SMS + Telegram + iMessage + WhatsApp): triage, digest, respond, reply-needed lookup, search, and per-Gmail read/draft/send. Admin only. Not the agent's own mailbox.",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    // Union of the old validators: admin access OR LifeOps access (owner / granted user / agent).
    if (await hasAdminAccess(runtime, message)) return true;
    if (await hasLifeOpsAccess(runtime, message)) return true;
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as OwnerInboxParams;
    const body = messageText(message);
    let subaction = normalizeSubaction(params.subaction);
    let channel = normalizeChannel(params.channel);

    if (!subaction) {
      const intent = (params.intent ?? body).trim();
      const plan = await resolveOwnerInboxPlanWithLlm({
        runtime,
        message,
        state,
        intent,
        params,
      });
      subaction = plan.subaction;
      if (plan.channel) {
        channel = plan.channel;
      }
      if (plan.shouldAct === false || !subaction) {
        const text =
          plan.response ??
          "Tell me whether you want me to triage, summarize, search, read, draft, or send something from your inbox.";
        await callback?.({ text });
        return {
          text,
          success: true,
          data: {
            noop: true,
            suggestedSubaction: subaction,
            suggestedChannel: plan.channel,
          },
        };
      }
    }

    channel ??= inferImplicitChannel(subaction, params);
    channel ??= "all";

    // Cross-channel search is its own delegate regardless of channel.
    if (subaction === "cross_channel_search") {
      return delegateTo(
        searchAcrossChannelsAction,
        runtime,
        message,
        state,
        {
          query: params.query,
          intent: params.intent,
        },
        options,
        callback,
      );
    }

    // Gmail-specific per-message ops always route to gmailAction.
    if (channel === "gmail") {
      switch (subaction) {
        case "triage":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            { subaction: "triage", intent: params.intent },
            options,
            callback,
          );
        case "search": {
          const gmailQuery = buildGmailSearchQuery(params);
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            {
              subaction: "search",
              intent: params.intent,
              query: gmailQuery,
              queries: gmailQuery ? [gmailQuery] : undefined,
            },
            options,
            callback,
          );
        }
        case "needs_response":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            { subaction: "needs_response", intent: params.intent },
            options,
            callback,
          );
        case "digest":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            { subaction: "triage", intent: params.intent },
            options,
            callback,
          );
        case "read_message":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            {
              subaction: "read",
              messageId: params.messageId,
              intent: params.intent,
            },
            options,
            callback,
          );
        case "draft_reply":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            {
              subaction: "draft_reply",
              messageId: params.messageId,
              bodyText: params.replyBody,
              intent: params.intent,
            },
            options,
            callback,
          );
        case "send_reply":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            {
              subaction: "send_reply",
              messageId: params.messageId,
              bodyText: params.replyBody,
              intent: params.intent,
            },
            options,
            callback,
          );
        case "respond":
          return delegateTo(
            gmailAction,
            runtime,
            message,
            state,
            {
              subaction: "needs_response",
              intent: params.intent,
            },
            options,
            callback,
          );
      }
    }

    // Non-Gmail channel (all / slack / discord / sms / telegram / whatsapp /
    // imessage): the cross-channel inbox pipeline handles triage / digest /
    // respond. search without channel=gmail falls through to cross-channel
    // unified search.
    switch (subaction) {
      case "triage":
      case "digest":
      case "respond":
      case "needs_response":
        return delegateTo(
          inboxAction,
          runtime,
          message,
          state,
          {
            subaction: subaction === "needs_response" ? "digest" : subaction,
            intent: params.intent,
            target: params.target,
            entryId: params.entryId,
            messageText: params.replyBody,
            confirmed: params.confirmed,
          },
          options,
          callback,
        );
      case "search":
        return delegateTo(
          searchAcrossChannelsAction,
          runtime,
          message,
          state,
          {
            query: params.query,
            intent: params.intent,
          },
          options,
          callback,
        );
      case "read_message":
      case "draft_reply":
      case "send_reply":
        return {
          text:
            `${subaction} requires channel=gmail (Gmail is the only channel ` +
            `that supports per-message read / draft / send operations).`,
          success: false,
          values: { success: false, error: "UNSUPPORTED_CHANNEL" },
          data: { actionName: ACTION_NAME, subaction, channel },
        };
    }

    return missingSubactionResult();
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Which owner-inbox operation to run. One of: triage (scan new messages), " +
        "digest (daily summary), respond (draft/send a reply), needs_response " +
        "(Gmail reply-needed lookup), search (within a channel), read_message " +
        "(Gmail-only: read a full message body), draft_reply (Gmail-only: draft " +
        "a threaded reply), send_reply (Gmail-only: send a threaded reply), " +
        "cross_channel_search (search every connected channel + memory).",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...VALID_SUBACTIONS],
      },
    },
    {
      name: "channel",
      description:
        "Which channel to scope to. Defaults to 'all' (cross-channel). Use " +
        "'gmail' for Gmail-specific operations.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "all",
          "gmail",
          "slack",
          "discord",
          "sms",
          "telegram",
          "whatsapp",
          "imessage",
        ],
      },
    },
    {
      name: "messageId",
      description:
        "Gmail message ID — required for read_message / draft_reply / send_reply.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Free-text search query. Used by search and cross_channel_search.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "senderQuery",
      description: "Gmail sender filter (e.g. 'alice@example.com').",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "subjectQuery",
      description: "Gmail subject-line filter.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "labelQuery",
      description: "Gmail label filter (e.g. 'INBOX', 'STARRED').",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "replyBody",
      description:
        "Pre-composed reply text for draft_reply / send_reply, or for " +
        "respond when the user has already dictated the exact text.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Set to true when the user is confirming a previously drafted response, " +
        "or when send_reply should bypass the draft-preview step.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "intent",
      description:
        "Natural-language intent — passed through to the underlying handler " +
        "when the planner did not extract structured params.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description:
        "For respond: who to respond to (sender name, channel name, or source).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "entryId",
      description: "For respond: specific triage entry ID.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "I missed a call with the Frontier Tower team. Draft a repair note for my approval and help me reschedule it.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Drafted a repair note for Frontier Tower, held it for your approval, and prepared the reschedule follow-through.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Triage my inbox" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Triaged 15 new messages across Gmail / Slack / Discord: 2 urgent (escalated), 5 need reply, 3 auto-replied, 5 ignored.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Give me my daily brief" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "# Daily Inbox Summary — Friday, April 18, 2026\n\n## Urgent (2)\n- Discord DM from Alice: \"Are we meeting tomorrow?\"\n- Gmail from ops@acme: \"Prod incident — need eyes\"",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Search Gmail for emails from finance@ about the Q3 budget",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found 4 Gmail threads from finance@ mentioning the Q3 budget — here are the most recent three.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Find everything Alice said about the Frontier Tower deal across all my channels",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Cross-channel search for \"Frontier Tower\" — 12 hits across Gmail, Telegram, and Calendar.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "If I still haven't answered about those three events, bump me again with context instead of starting over.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll keep the prior context attached and bump you again about those three events instead of restarting the thread from zero.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "In the morning brief, add a Pending Drafts section that lists which drafts still need my sign-off and who they are for.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll surface the pending drafts still waiting for your sign-off as part of the inbox briefing context.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Tell me what slides, bio, title, or portal assets I still owe before the event.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll pull together the outstanding event assets and deadlines so you can see what is still owed before the event.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a reply to the last email from finance confirming receipt.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sent a reply on the most recent finance thread confirming receipt.",
        },
      },
    ],
  ] as ActionExample[][],
};
