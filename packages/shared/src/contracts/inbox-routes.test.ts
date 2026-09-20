/** Exercises real inbox parsing, normalization and rejection of forged routing authority. */
import { describe, expect, it } from "vitest";
import { PostInboxMessageRequestSchema } from "./inbox-routes.js";

describe("PostInboxMessageRequestSchema", () => {
  const message = { roomId: "room-1", source: "telegram", text: "hello" };

  it("preserves a minimal message without optional routing fields", () => {
    expect(PostInboxMessageRequestSchema.parse(message)).toEqual(message);
  });

  it("normalizes every supplied field without dropping the reply or account", () => {
    expect(
      PostInboxMessageRequestSchema.parse({
        roomId: "  room-1  ",
        source: "TELEGRAM",
        text: "  hello  ",
        accountId: "  owner  ",
        replyToMessageId: "  msg-2  ",
      }),
    ).toEqual({ ...message, accountId: "owner", replyToMessageId: "msg-2" });
  });

  it.each(["roomId", "source", "text"] as const)("requires %s", (field) => {
    const input: Record<string, string> = { ...message };
    delete input[field];
    expect(() => PostInboxMessageRequestSchema.parse(input)).toThrow();
  });

  it.each([
    ["empty text", { text: "" }],
    ["blank text", { text: "   " }],
    ["blank room", { roomId: "   " }],
    ["blank source", { source: "   " }],
    ["blank explicit account", { accountId: "   " }],
    ["attachments", { attachments: [] }],
    [
      "routing metadata",
      {
        metadata: {
          connectorSendAs: { accountId: "forged-account", provider: "discord" },
        },
      },
    ],
    ["top-level routing", { connectorSendAs: { accountId: "forged-account" } }],
  ])("rejects %s", (_name, patch) => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({ ...message, ...patch }),
    ).toThrow();
  });

  it.each(["", "   "])("omits an empty reply id %j", (replyToMessageId) => {
    expect(
      PostInboxMessageRequestSchema.parse({ ...message, replyToMessageId }),
    ).toEqual(message);
  });
});
