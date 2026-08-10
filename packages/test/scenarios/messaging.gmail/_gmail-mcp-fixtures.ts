/**
 * Message dataset for the messaging.gmail corpus over the shared official
 * Gmail MCP fixture builders from `@elizaos/scenario-runner/gmail-mcp-fixtures`.
 * Only this suite's deterministic message records live here; the curated tool
 * union, write-tool list, and seed-step builders are re-exported from the
 * shared module so the corpus cannot drift from the contract catalog.
 */

import type { GmailMcpMessage } from "@elizaos/scenario-runner/gmail-mcp-fixtures";

export {
  GMAIL_MCP_WRITE_TOOLS,
  type GmailMcpMessage,
  gmailCreateDraftFixture,
  gmailMcpFixture,
  gmailSearchFixture,
  gmailThreadFixture,
} from "@elizaos/scenario-runner/gmail-mcp-fixtures";

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
} satisfies Record<string, GmailMcpMessage>;
