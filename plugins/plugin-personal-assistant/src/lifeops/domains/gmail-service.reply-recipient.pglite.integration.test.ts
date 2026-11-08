/** Gmail reply recipients through LifeOpsService on a real PGlite runtime; the Google provider is stubbed, so no mail leaves the test. */
import { getConnectorAccountManager } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../../test/stubs/plugin-google-workspace.js";
import { LifeOpsRepository } from "../repository.js";
import { LifeOpsService } from "../service.js";

const REQUEST_URL = new URL("http://127.0.0.1/api/lifeops/gmail/reply-send");

// Shapes as the Google plugin's getMessage returns them (gmail.ts mapMessage).
const MESSAGES: Record<string, unknown> = {
  "gh-msg-1": {
    id: "gh-msg-1",
    threadId: "gh-thread-1",
    subject: "Re: [owner/repo] Fix flaky test (PR #42)",
    from: { email: "notifications@github.com", name: "Reviewer" },
    replyTo: { email: "reply+ABC123@reply.github.com", name: "owner/repo" },
    to: [{ email: "owner@example.test" }],
    snippet: "Can you rebase?",
    receivedAt: "2026-11-08T10:00:00.000Z",
    labelIds: ["INBOX", "UNREAD"],
    bodyText: "Can you rebase?",
    headers: {
      "Message-ID": "<owner/repo/pull/42/c1@github.com>",
      From: "Reviewer <notifications@github.com>",
      "Reply-To": "owner/repo <reply+ABC123@reply.github.com>",
    },
  },
  "alice-msg-1": {
    id: "alice-msg-1",
    threadId: "alice-thread-1",
    subject: "Lunch on Friday?",
    from: { email: "alice@example.test", name: "Alice" },
    to: [{ email: "owner@example.test" }],
    snippet: "Are you free?",
    receivedAt: "2026-11-08T11:00:00.000Z",
    labelIds: ["INBOX", "UNREAD"],
    bodyText: "Are you free?",
    headers: {
      "Message-ID": "<lunch-1@example.test>",
      From: "Alice <alice@example.test>",
    },
  },
};

let host: RealTestRuntimeResult;
const sent: string[][] = [];

beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
  await LifeOpsRepository.bootstrapSchema(host.runtime);
  await host.runtime.registerService(GoogleWorkspaceTestService);
  const google = await host.runtime.getServiceLoadPromise("google");
  Object.assign(google, {
    getMessage: async ({ messageId }: { messageId: string }) => {
      const message = MESSAGES[messageId];
      if (!message) throw new Error(`unknown message ${messageId}`);
      return message;
    },
    sendGmailReply: async (input: { to: string[]; threadId: string }) => {
      sent.push(input.to);
      return { messageId: `sent-${sent.length}`, threadId: input.threadId };
    },
  });
  const accounts = getConnectorAccountManager(host.runtime);
  if (!accounts.getProvider("google")) {
    accounts.registerProvider({ provider: "google" });
  }
  await accounts.upsertAccount("google", {
    id: "owner-gmail",
    provider: "google",
    role: "OWNER",
    purpose: ["reading", "messaging"],
    accessGate: "owner_binding",
    status: "connected",
    displayHandle: "owner@example.test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      grantedScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    },
  });
}, 180_000);

afterAll(async () => {
  await host?.cleanup();
});

beforeEach(() => {
  sent.length = 0;
});

it("sends a reply without a recipient to the Reply-To address that its draft shows", async () => {
  const service = new LifeOpsService(host.runtime);
  const draft = await service.createGmailReplyDraft(REQUEST_URL, {
    messageId: "gh-msg-1",
    intent: "Rebased, thanks.",
  });
  expect(draft.to).toEqual(["reply+abc123@reply.github.com"]);

  await service.sendGmailReply(REQUEST_URL, {
    messageId: "gh-msg-1",
    bodyText: "Rebased, thanks.",
    confirmSend: true,
  });

  expect(sent).toEqual([["reply+ABC123@reply.github.com"]]);
}, 60_000);

it("sends a reply without a recipient to the sender when the message has no Reply-To", async () => {
  const service = new LifeOpsService(host.runtime);
  await service.sendGmailReply(REQUEST_URL, {
    messageId: "alice-msg-1",
    bodyText: "Friday works.",
    confirmSend: true,
  });

  expect(sent).toEqual([["alice@example.test"]]);
}, 60_000);
