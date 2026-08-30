/**
 * Verifies identical Gmail message and thread ids from different grants stay
 * distinct in the unified inbox while retaining provider ids for effects.
 * All inputs are deterministic and no connector is invoked.
 */

import { describe, expect, it } from "vitest";
import { toInboxMessages } from "./aggregate.js";
import type { InboundMessage } from "./types.js";

function gmailMessage(accountId: string): InboundMessage {
  return {
    id: "projection-id",
    source: "gmail",
    senderName: "Fixture sender",
    senderEmail: "sender@example.test",
    channelName: "Email from Fixture sender",
    channelType: "dm",
    text: "Fixture message",
    snippet: "Fixture message",
    timestamp: Date.parse("2026-08-22T18:00:00.000Z"),
    gmailMessageId: "same-provider-message-id",
    gmailAccountId: accountId,
    threadId: "same-provider-thread-id",
  };
}

describe("Gmail unified inbox account isolation", () => {
  it("scopes cache and thread identities without changing provider ids", () => {
    const [first, second] = toInboxMessages([
      gmailMessage("connector-account:account-1"),
      gmailMessage("connector-account:account-2"),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.sourceRef.externalId).toBe("same-provider-message-id");
    expect(second.sourceRef.externalId).toBe("same-provider-message-id");
  });
});
