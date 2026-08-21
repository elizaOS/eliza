/** Unit coverage for deterministic Telegram group invocation policy. */
import { describe, expect, it } from "vitest";
import {
  classifyTelegramGroupInvocation,
  resolveTelegramGroupResponsePolicy,
  shouldReplyToTelegramGroup,
} from "./group-response-policy";

const bot = { id: 42, username: "ElizaBot" };

describe("Telegram group response policy", () => {
  it("defaults to mention-only and preserves legacy explicit ambient opt-in", () => {
    expect(resolveTelegramGroupResponsePolicy(undefined, undefined)).toBe(
      "mention_only",
    );
    expect(resolveTelegramGroupResponsePolicy(undefined, "true")).toBe(
      "ambient",
    );
    expect(resolveTelegramGroupResponsePolicy("mention-only", "true")).toBe(
      "mention_only",
    );
  });

  it("recognizes structured mentions, replies, and commands", () => {
    expect(
      classifyTelegramGroupInvocation(
        {
          text: "hello @ElizaBot",
          entities: [{ type: "mention", offset: 6, length: 9 }],
        },
        bot,
      ),
    ).toBe("mention");
    expect(
      classifyTelegramGroupInvocation(
        { text: "follow up", reply_to_message: { from: { id: 42 } } },
        bot,
      ),
    ).toBe("reply");
    expect(
      classifyTelegramGroupInvocation(
        {
          text: "/status@ElizaBot",
          entities: [{ type: "bot_command", offset: 0, length: 16 }],
        },
        bot,
      ),
    ).toBe("command");
  });

  it("does not mistake another bot mention for an invocation", () => {
    const invocation = classifyTelegramGroupInvocation(
      {
        text: "hello @OtherBot",
        entities: [{ type: "mention", offset: 6, length: 9 }],
      },
      bot,
    );
    expect(invocation).toBe("ambient");
    expect(shouldReplyToTelegramGroup("mention_only", invocation)).toBe(false);
    expect(shouldReplyToTelegramGroup("ambient", invocation)).toBe(true);
  });
});
