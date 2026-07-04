/** Verifies inbox assembly and request resolution from inbound cross-channel messages. Deterministic vitest with fixture messages. */
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../inbox/types.js";
import { buildInbox, resolveInboxRequest } from "./service-mixin-inbox.js";

function inboundPhoneMessage(
  id: string,
  phoneNumber: string,
  text = "hello",
): InboundMessage {
  return {
    id,
    source: "imessage",
    roomId: `room-${id}`,
    entityId: `sender-${id}`,
    senderName: `Sender ${id}`,
    channelName: `iMessage from Sender ${id}`,
    channelType: "dm",
    text,
    snippet: text,
    timestamp: Date.now(),
    threadId: `thread-${id}`,
    chatType: "dm",
    phoneAccountId: phoneNumber,
    phoneAccountLabel: phoneNumber,
    phoneNumber,
  };
}

describe("LifeOps inbox phone account filtering", () => {
  it("filters iMessage inbox rows to selected local phone identities", () => {
    const request = resolveInboxRequest({
      channels: ["imessage"],
      phoneAccountIds: ["+14159611510"],
    });

    const inbox = buildInbox(
      [
        inboundPhoneMessage("gateway", "+14159611510"),
        inboundPhoneMessage("personal", "+14153024399"),
      ],
      {
        limit: request.limit,
        allowed: request.allowed,
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        phoneAccountIds: request.phoneAccountIds,
      },
    );

    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.phoneNumber).toBe("+14159611510");
    expect(inbox.messages[0]?.sourceRef.phoneAccountId).toBe("+14159611510");
  });
});
