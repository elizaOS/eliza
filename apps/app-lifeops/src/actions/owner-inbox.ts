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
import { hasAdminAccess } from "@elizaos/agent/security/access";
import { gmailAction } from "./gmail.js";
import { inboxAction } from "./inbox.js";
import { searchAcrossChannelsAction } from "./search-across-channels.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OwnerInboxSubaction =
  | "triage"
  | "digest"
  | "respond"
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function missingSubactionResult(): ActionResult {
  return {
    text:
      "missing subaction; choose triage|digest|respond|search|read_message|draft_reply|send_reply",
    success: false,
    values: { success: false, error: "MISSING_SUBACTION" },
    data: { actionName: ACTION_NAME },
  };
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
  return Promise.resolve(
    action.handler(runtime, message, state, delegated, callback),
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
  ],
  description:
    "The OWNER's inbox, across every connected messaging channel — Gmail, " +
    "Slack, Discord, SMS, Telegram, iMessage, and WhatsApp. One umbrella " +
    "action for triage, the daily executive-assistant brief, responding to " +
    "messages, and cross-channel search. " +
    "Subactions: triage | digest | respond | search | read_message | " +
    "draft_reply | send_reply | cross_channel_search. " +
    "Channel param: all | gmail | slack | discord | sms | telegram | " +
    "whatsapp | imessage. Defaults to 'all'. " +
    "Gmail-specific operations — search by sender/subject/label, read a " +
    "message body, draft or send a threaded reply — are available when " +
    "channel=gmail (use messageId + replyBody for read_message / draft_reply / " +
    "send_reply; senderQuery / subjectQuery / labelQuery for search). " +
    "Route here when the user says 'my inbox', 'inbox digest', 'daily brief', " +
    "'unified inbox', 'what needs my attention', 'triage my messages' — use " +
    "channel=all. When the user explicitly says 'Gmail' or 'email', route " +
    "here with channel=gmail. When the user asks for cross-channel search " +
    "('find everything about X across my channels'), use " +
    "subaction=cross_channel_search. " +
    "DO NOT use this action for the agent's own mailbox — that is AGENT_INBOX. " +
    "Admin/owner only.",
  descriptionCompressed:
    "Owner's unified inbox (Gmail + Slack + Discord + SMS + Telegram + iMessage + WhatsApp): triage, digest, respond, search, per-Gmail read/draft/send. Admin only. Not the agent's own mailbox.",
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
    const params = ((options?.parameters ?? {}) as OwnerInboxParams) ?? {};
    const subaction = params.subaction;
    const channel: OwnerInboxChannel = params.channel ?? "all";

    if (!subaction) {
      return missingSubactionResult();
    }

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
        case "digest":
        case "respond":
          // Digest / respond are cross-channel concepts — delegate to the
          // unified inbox even when the caller scoped channel=gmail.
          return delegateTo(
            inboxAction,
            runtime,
            message,
            state,
            {
              subaction,
              intent: params.intent,
              target: params.target,
              entryId: params.entryId,
              messageText: params.replyBody,
              confirmed: params.confirmed,
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
        return delegateTo(
          inboxAction,
          runtime,
          message,
          state,
          {
            subaction,
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
        "digest (daily summary), respond (draft/send a reply), search (within a " +
        "channel), read_message (Gmail-only: read a full message body), " +
        "draft_reply (Gmail-only: draft a threaded reply), send_reply " +
        "(Gmail-only: send a threaded reply), cross_channel_search (search " +
        "every connected channel + memory).",
      required: true,
      schema: {
        type: "string" as const,
        enum: [
          "triage",
          "digest",
          "respond",
          "search",
          "read_message",
          "draft_reply",
          "send_reply",
          "cross_channel_search",
        ],
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
  ] as ActionExample[][],
};
