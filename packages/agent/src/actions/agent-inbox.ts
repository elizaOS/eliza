/**
 * AGENT_INBOX — the agent's own mailbox / channel inbox.
 *
 * Distinct from the OWNER's inbox (covered by core's MESSAGE /
 * MESSAGE / MESSAGE). AGENT_INBOX is scoped to the agent's OWN
 * accounts — the mailbox the agent itself holds for autonomous outbound
 * and inbound.
 *
 * Returns `not_configured` until an agent mailbox is wired. Placed in the
 * registry now so the planner can distinguish the agent's own mailbox from
 * the owner's inbox.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
} from "@elizaos/core";

type AgentInboxSubaction =
  | "triage"
  | "digest"
  | "respond"
  | "search"
  | "read_message"
  | "draft_reply"
  | "send_reply";

interface AgentInboxParameters {
  subaction?: AgentInboxSubaction | string;
  channel?: string;
  query?: string;
  messageId?: string;
  replyBody?: string;
  confirmed?: boolean;
}

function notConfigured(subaction: string | undefined): ActionResult {
  return {
    success: false,
    text:
      "The agent's own inbox is not configured yet. Wire an agent-scoped " +
      "mailbox (e.g. an Eliza Cloud inbox or a dedicated IMAP/SMTP account) " +
      "before using AGENT_INBOX. For the OWNER's inbox, use MESSAGE.",
    values: {
      success: false,
      actionName: "AGENT_INBOX",
      error: "AGENT_INBOX_NOT_CONFIGURED",
    },
    data: {
      actionName: "AGENT_INBOX",
      subaction: subaction ?? null,
      reason: "no_agent_mailbox_configured",
    },
  };
}

export const agentInboxAction: Action = {
  name: "AGENT_INBOX",
  contexts: ["messaging", "email", "connectors", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "AGENT_MAILBOX",
    "AGENT_GMAIL",
    "AGENT_EMAIL",
    "AGENT_MESSAGES",
    "MY_AGENT_INBOX",
  ],
  description:
    "AGENT-scoped inbox: the AGENT's own mailbox / channel inbox. Use this " +
    "when the agent itself has email or messaging accounts and needs to " +
    "triage, digest, read, search, draft, or send on those accounts. " +
    "Subactions: triage | digest | respond | search | read_message | " +
    "draft_reply | send_reply. " +
    "Do NOT use this for the OWNER's inbox — any 'my inbox', 'my Gmail', " +
    "'my email', 'inbox digest', 'daily brief' request from the owner " +
    "belongs to MESSAGE. AGENT_INBOX only applies when the subject " +
    "being triaged is the AGENT's own account.",
  descriptionCompressed:
    "AGENT-scoped inbox: AGENT's mailbox / channel inbox use agent itself email message account need triage, digest, read, search, draft, send account subaction: triage digest respond search read_message draft_reply send_reply use OWNER's inbox inbox, Gmail, email, inbox digest, daily brief request owner belong MESSAGE AGENT_INBOX apply subject be triage AGENT's account",

  validate: async () => true,

  parameters: [
    {
      name: "subaction",
      description:
        "One of: triage, digest, respond, search, read_message, draft_reply, send_reply.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "channel",
      description:
        "Which of the agent's channels to target (e.g. 'gmail', 'all').",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description: "Search / triage query string.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "messageId",
      description:
        "Specific message id for read_message / draft_reply / send_reply.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "replyBody",
      description: "Body text for draft_reply / send_reply.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Must be true to dispatch a draft via send_reply.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | AgentInboxParameters
        | undefined) ?? {};
    const subaction = (params.subaction ?? "").toString().trim().toLowerCase();
    // No agent-scoped mailbox is configured yet. Return a clean result so the
    // planner gets an unambiguous signal rather than an exception.
    return notConfigured(subaction || undefined);
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Check the agent's own inbox for anything new from the Eliza Cloud notifications address.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "The agent's own inbox is not configured yet.",
          actions: ["AGENT_INBOX"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Triage your own mailbox and tell me what's pending.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "The agent's own inbox is not configured yet.",
          actions: ["AGENT_INBOX"],
        },
      },
    ],
  ] as ActionExample[][],
};
