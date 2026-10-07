/**
 * A native iMessage timestamp of epoch is a real send time. `timestamp || Date.now()`
 * stored that message as sent now.
 */

import { describe, expect, it } from "vitest";
import { nativeMessageToLifeOps } from "../src/lifeops/domains/imessage-service";

describe("nativeMessageToLifeOps", () => {
  it("keeps a message sent at epoch", () => {
    const record = nativeMessageToLifeOps({
      id: "msg-epoch",
      text: "hello",
      handle: "+15551212",
      chatId: "chat-1",
      timestamp: 0,
      isFromMe: false,
      hasAttachments: false,
    });
    expect(record.sentAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
