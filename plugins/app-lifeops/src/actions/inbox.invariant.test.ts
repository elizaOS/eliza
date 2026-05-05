import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { InboxTriageRepository } from "../inbox/repository.js";
import type {
  InboundMessage,
  InboxTriageConfig,
  TriageResult,
} from "../inbox/types.js";

/**
 * Headline invariant from the user: "NEVER auto-respond to my mails — always
 * asks permission first." This test pins that invariant in code: when an
 * inbound message arrives on an email channel (gmail), `tryAutoReply` MUST
 * enqueue an approval request and MUST NOT dispatch through any send path,
 * even when `autoReply.enabled` is true and `reflectOnAutoReply` would
 * approve the send.
 */

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

// Spies wired through hoisted module mocks so the real `tryAutoReply`
// implementation in `inbox.ts` reaches them when it imports `service.js`,
// `approval-queue.js`, and `reflection.js`.
const sendGmailReply = vi.hoisted(() => vi.fn(async () => undefined));
const sendXConversationMessage = vi.hoisted(() => vi.fn(async () => undefined));
const sendXDirectMessage = vi.hoisted(() => vi.fn(async () => undefined));
const reflectOnAutoReply = vi.hoisted(() =>
  vi.fn(async () => ({ approved: true, reasoning: "ok to send" })),
);
const reflectOnSendConfirmation = vi.hoisted(() =>
  vi.fn(async () => ({ approved: true, reasoning: "ok to send" })),
);
const enqueueSpy = vi.hoisted(() => vi.fn(async () => ({ id: "approval-1" })));

vi.mock("@elizaos/agent/actions/send-message", () => ({
  resolveAdminEntityId: vi.fn(async () => null),
}));

vi.mock("@elizaos/agent/security/access", () => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("../lifeops/service.js", () => {
  class FakeLifeOpsService {
    sendGmailReply = sendGmailReply;
    sendXConversationMessage = sendXConversationMessage;
    sendXDirectMessage = sendXDirectMessage;
  }
  return { LifeOpsService: FakeLifeOpsService };
});

vi.mock("../lifeops/approval-queue.js", () => ({
  createApprovalQueue: () => ({
    enqueue: enqueueSpy,
  }),
}));

vi.mock("../inbox/reflection.js", () => ({
  reflectOnAutoReply,
  reflectOnSendConfirmation,
}));

// Avoid initialising the live LifeOps Google helpers (they look for a real
// API base URL during module load) — the tryAutoReply path only uses
// INTERNAL_URL for the Gmail send, which we never reach in the email-invariant
// case but do reach for the non-email "preserve current behavior" sanity test.
vi.mock("./lifeops-google-helpers.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1/"),
  hasLifeOpsAccess: vi.fn(async () => true),
}));

function makeRuntime(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    sendMessageToTarget: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime;
}

function makeRepo(): InboxTriageRepository {
  return {
    countAutoRepliesSince: vi.fn(async () => 0),
    markResolved: vi.fn(async () => undefined),
  } as unknown as InboxTriageRepository;
}

function autoReplyEnabledConfig(): InboxTriageConfig {
  return {
    enabled: true,
    triageCron: "0 * * * *",
    digestCron: "0 8 * * *",
    digestTimezone: undefined,
    channels: ["gmail"],
    prioritySenders: [],
    priorityChannels: [],
    autoReply: {
      enabled: true,
      confidenceThreshold: 0.5,
      senderWhitelist: [],
      channelWhitelist: [],
      maxAutoRepliesPerHour: 100,
    },
    triageRules: { alwaysUrgent: [], alwaysIgnore: [], alwaysNotify: [] },
    digestDeliveryChannel: "client_chat",
    retentionDays: 30,
  };
}

function gmailMessage(): InboundMessage {
  return {
    id: "gmail-msg-1",
    source: "gmail",
    senderName: "alice@example.com",
    senderEmail: "alice@example.com",
    channelName: "Project sync follow-up",
    channelType: "dm",
    text: "Can we move the meeting to 4pm?",
    snippet: "Can we move the meeting to 4pm?",
    timestamp: Date.parse("2026-05-03T15:00:00Z"),
    gmailMessageId: "gmail-thread-1",
    gmailIsImportant: true,
    gmailLikelyReplyNeeded: true,
  };
}

function highConfidenceTriage(): TriageResult {
  return {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.99,
    reasoning: "direct question expecting a yes/no answer",
    suggestedResponse: "Sure — 4pm works for me.",
  };
}

describe("tryAutoReply invariant: email channels never auto-send", () => {
  beforeEach(() => {
    sendGmailReply.mockClear();
    sendXConversationMessage.mockClear();
    sendXDirectMessage.mockClear();
    reflectOnAutoReply.mockClear();
    enqueueSpy.mockClear();
  });

  test("Gmail message with autoReply.enabled=true is queued for approval, not sent", async () => {
    const { tryAutoReply, requiresApprovalQueue } = await import("./inbox.js");

    expect(requiresApprovalQueue("gmail")).toBe(true);

    const runtime = makeRuntime();
    const repo = makeRepo();
    const config = autoReplyEnabledConfig();
    const msg = gmailMessage();
    const result = highConfidenceTriage();

    const sentAuto = await tryAutoReply(
      runtime,
      msg,
      result,
      "entry-1",
      config,
      repo,
    );

    // tryAutoReply returns false because the message was queued, not sent.
    expect(sentAuto).toBe(false);

    // The approval queue was called with the email payload.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const enqueueCall = enqueueSpy.mock.calls[0]?.[0] as
      | {
          action: string;
          channel: string;
          payload: { action: string; body: string };
          reason: string;
        }
      | undefined;
    expect(enqueueCall?.action).toBe("send_email");
    expect(enqueueCall?.channel).toBe("email");
    expect(enqueueCall?.payload.action).toBe("send_email");
    expect(enqueueCall?.payload.body).toBe("Sure — 4pm works for me.");
    expect(enqueueCall?.reason).toMatch(/queued for approval/i);

    // No outbound send happened on any channel.
    expect(sendGmailReply).not.toHaveBeenCalled();
    expect(sendXConversationMessage).not.toHaveBeenCalled();
    expect(sendXDirectMessage).not.toHaveBeenCalled();
    expect(runtime.sendMessageToTarget).not.toHaveBeenCalled();

    // Email gate runs BEFORE reflection — we never even ask the LLM.
    expect(reflectOnAutoReply).not.toHaveBeenCalled();

    // Repo is NOT marked auto-replied (the message is awaiting approval).
    expect(repo.markResolved).not.toHaveBeenCalled();
  });

  test("requiresApprovalQueue is true for gmail and false for non-email sources", async () => {
    const { requiresApprovalQueue } = await import("./inbox.js");
    expect(requiresApprovalQueue("gmail")).toBe(true);
    expect(requiresApprovalQueue("imessage")).toBe(false);
    expect(requiresApprovalQueue("discord")).toBe(false);
    expect(requiresApprovalQueue("telegram")).toBe(false);
    expect(requiresApprovalQueue("signal")).toBe(false);
    expect(requiresApprovalQueue("whatsapp")).toBe(false);
    expect(requiresApprovalQueue("x_dm")).toBe(false);
  });
});
