/**
 * Supplies deterministic Gmail data for cross-cutting scenarios at the
 * official MCP tool boundary. These records contain no transport, OAuth, or
 * REST assumptions and intentionally expose no send, spam, trash, delete, or
 * batch-mutation operation.
 */

import type { ScenarioSeedStep } from "@elizaos/scenario-runner/schema";

export type GmailScenarioMessage = {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  toRecipients: string[];
  snippet: string;
  date: string;
  labelIds: string[];
  plaintextBody: string;
};

export const GMAIL_SCENARIO_MESSAGES = {
  finance: {
    id: "msg-finance",
    threadId: "thr-finance",
    subject: "Invoice 4831 received",
    sender: "Finance Team <finance@example.com>",
    toRecipients: ["owner@example.test"],
    snippet: "Please confirm receipt of invoice 4831 when you get a chance.",
    date: "2026-08-10T09:00:00.000Z",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    plaintextBody:
      "We received invoice 4831 for April. Please confirm receipt when you get a chance.",
  },
  sarah: {
    id: "msg-sarah",
    threadId: "thr-sarah",
    subject: "Can you review the product brief?",
    sender: "Sarah Lee <sarah@example.com>",
    toRecipients: ["owner@example.test"],
    snippet:
      "Could you review the product brief tomorrow and send notes before lunch?",
    date: "2026-08-10T07:00:00.000Z",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    plaintextBody:
      "Could you review the product brief tomorrow and send me notes before lunch?",
  },
  julia: {
    id: "msg-julia",
    threadId: "thr-julia",
    subject: "Looking forward to tomorrow",
    sender: "Julia Chen <julia.chen@example.com>",
    toRecipients: ["owner@example.test"],
    snippet: "Looking forward to our intro meeting tomorrow.",
    date: "2026-08-10T04:00:00.000Z",
    labelIds: ["INBOX"],
    plaintextBody:
      "Looking forward to our intro meeting tomorrow. I'd love to compare notes on product strategy and AI assistants.",
  },
  newsletter: {
    id: "msg-newsletter",
    threadId: "thr-news",
    subject: "Weekly ops digest",
    sender: "Weekly Digest <digest@example.com>",
    toRecipients: ["owner@example.test"],
    snippet:
      "This week in ops: ship the launch checklist and review the metrics deck.",
    date: "2026-08-10T00:00:00.000Z",
    labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    plaintextBody:
      "This week in ops: ship the launch checklist, review the metrics deck, and confirm next week's travel.",
  },
  spam: {
    id: "msg-spam",
    threadId: "thr-spam",
    subject: "Account notice",
    sender: "Security Notice <security@example.com>",
    toRecipients: ["owner@example.test"],
    snippet: "Suspicious account notice routed to spam.",
    date: "2026-08-10T08:00:00.000Z",
    labelIds: ["SPAM", "UNREAD"],
    plaintextBody: "This is a synthetic spam-folder fixture.",
  },
  unrespondedInbound: {
    id: "msg-unresponded-inbound",
    threadId: "thr-unresponded",
    subject: "Signed vendor packet",
    sender: "Vendor Ops <vendor@example.com>",
    toRecipients: ["owner@example.test"],
    snippet: "Could you send the signed vendor packet?",
    date: "2026-07-25T10:00:00.000Z",
    labelIds: ["INBOX"],
    plaintextBody: "Could you send the signed vendor packet when you can?",
  },
  unrespondedSent: {
    id: "msg-unresponded-sent",
    threadId: "thr-unresponded",
    subject: "Re: Signed vendor packet",
    sender: "Owner <owner@example.test>",
    toRecipients: ["vendor@example.com"],
    snippet: "Following up on the signed packet.",
    date: "2026-07-27T10:00:00.000Z",
    labelIds: ["SENT"],
    plaintextBody:
      "Following up on the signed packet. Can you confirm receipt?",
  },
} satisfies Record<string, GmailScenarioMessage>;

type CuratedGmailTool =
  | "create_draft"
  | "list_drafts"
  | "get_thread"
  | "get_message"
  | "search_threads"
  | "label_thread"
  | "unlabel_thread"
  | "list_labels"
  | "label_message"
  | "unlabel_message";

export function gmailFixture(args: {
  tool: CuratedGmailTool;
  arguments?: Record<string, unknown>;
  structuredContent: Record<string, unknown>;
  repeat?: boolean;
}): ScenarioSeedStep {
  return {
    type: "mcpFixture",
    provider: "google",
    resource: "gmail",
    tool: args.tool,
    ...(args.arguments ? { arguments: args.arguments } : {}),
    result: { structuredContent: args.structuredContent },
    ...(args.repeat ? { repeat: true } : {}),
  };
}

export function gmailSearchFixture(
  messages: GmailScenarioMessage[],
  query?: string,
): ScenarioSeedStep {
  const threads = new Map<
    string,
    { id: string; messages: GmailScenarioMessage[] }
  >();
  for (const message of messages) {
    const thread = threads.get(message.threadId) ?? {
      id: message.threadId,
      messages: [],
    };
    thread.messages.push(message);
    threads.set(message.threadId, thread);
  }
  return gmailFixture({
    tool: "search_threads",
    ...(query ? { arguments: { query } } : {}),
    structuredContent: { threads: [...threads.values()] },
    repeat: true,
  });
}

export function gmailThreadFixture(
  messages: GmailScenarioMessage[],
): ScenarioSeedStep {
  const threadId = messages[0]?.threadId;
  if (!threadId || messages.some((message) => message.threadId !== threadId)) {
    throw new Error("Gmail thread fixtures require one non-empty thread");
  }
  return gmailFixture({
    tool: "get_thread",
    arguments: { threadId },
    structuredContent: { thread: { id: threadId, messages } },
    repeat: true,
  });
}

export function gmailDraftFixture(
  threadId: string,
  draftId: string,
): ScenarioSeedStep {
  return gmailFixture({
    tool: "create_draft",
    structuredContent: { draft: { id: draftId, threadId } },
  });
}

export const GMAIL_MCP_WRITE_TOOLS: string[] = [
  "create_draft",
  "label_thread",
  "unlabel_thread",
  "label_message",
  "unlabel_message",
];
