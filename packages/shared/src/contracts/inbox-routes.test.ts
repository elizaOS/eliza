/**
 * Contract tests for PostInboxMessageRequestSchema, the schema for injecting
 * an inbound message into a room. Locks in the required roomId/source/text
 * shape, account selection, normalization, required-field rejection, and the
 * strict boundary that keeps client metadata out of routing authority.
 */
import { describe, expect, it } from "vitest";
import { PostInboxMessageRequestSchema } from "./inbox-routes.js";

describe("PostInboxMessageRequestSchema", () => {
  it("accepts the minimal required shape", () => {
    expect(
      PostInboxMessageRequestSchema.parse({
        roomId: "room-1",
        source: "telegram",
        text: "hello",
      }),
    ).toEqual({
      roomId: "room-1",
      source: "telegram",
      text: "hello",
    });
  });

  it("accepts replyToMessageId", () => {
    const parsed = PostInboxMessageRequestSchema.parse({
      roomId: "room-1",
      source: "telegram",
      text: "hello",
      replyToMessageId: "msg-2",
    });
    expect(parsed.replyToMessageId).toBe("msg-2");
  });

  it("accepts and trims an explicit accountId", () => {
    expect(
      PostInboxMessageRequestSchema.parse({
        accountId: "  discord-owner  ",
        roomId: "room-1",
        source: "discord",
        text: "hello",
      }),
    ).toEqual({
      accountId: "discord-owner",
      roomId: "room-1",
      source: "discord",
      text: "hello",
    });
  });

  it("trims roomId, text, and replyToMessageId", () => {
    const parsed = PostInboxMessageRequestSchema.parse({
      roomId: "  room-1  ",
      source: "TELEGRAM",
      text: "  hello  ",
      replyToMessageId: "  msg-2  ",
    });
    expect(parsed).toEqual({
      roomId: "room-1",
      source: "telegram",
      text: "hello",
      replyToMessageId: "msg-2",
    });
  });

  it("lower-cases source", () => {
    const parsed = PostInboxMessageRequestSchema.parse({
      roomId: "r",
      source: "Telegram",
      text: "x",
    });
    expect(parsed.source).toBe("telegram");
  });

  it("rejects missing roomId", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({ source: "x", text: "y" }),
    ).toThrow();
  });

  it("rejects missing source", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({ roomId: "r", text: "y" }),
    ).toThrow();
  });

  it("rejects missing text", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({ roomId: "r", source: "x" }),
    ).toThrow();
  });

  it("rejects empty text", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "r",
        source: "x",
        text: "",
      }),
    ).toThrow();
  });

  it("rejects whitespace-only text", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "r",
        source: "x",
        text: "   ",
      }),
    ).toThrow();
  });

  it("rejects whitespace-only roomId", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "   ",
        source: "x",
        text: "y",
      }),
    ).toThrow();
  });

  it("rejects whitespace-only source", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "r",
        source: "   ",
        text: "y",
      }),
    ).toThrow();
  });

  it("rejects whitespace-only accountId", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        accountId: "   ",
        roomId: "r",
        source: "x",
        text: "y",
      }),
    ).toThrow();
  });

  it("treats whitespace-only replyToMessageId as absent", () => {
    const parsed = PostInboxMessageRequestSchema.parse({
      roomId: "r",
      source: "x",
      text: "y",
      replyToMessageId: "   ",
    });
    expect(parsed).toEqual({ roomId: "r", source: "x", text: "y" });
    expect(parsed).not.toHaveProperty("replyToMessageId");
  });

  it("treats empty replyToMessageId as absent", () => {
    const parsed = PostInboxMessageRequestSchema.parse({
      roomId: "r",
      source: "x",
      text: "y",
      replyToMessageId: "",
    });
    expect(parsed).not.toHaveProperty("replyToMessageId");
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "r",
        source: "x",
        text: "y",
        attachments: [],
      }),
    ).toThrow();
  });

  it("rejects connectorSendAs metadata", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "r",
        source: "discord",
        text: "hello",
        metadata: {
          connectorSendAs: {
            accountId: "forged-account",
            provider: "discord",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects top-level connector routing fields outside accountId", () => {
    expect(() =>
      PostInboxMessageRequestSchema.parse({
        roomId: "r",
        source: "discord",
        text: "hello",
        connectorSendAs: { accountId: "forged-account" },
      }),
    ).toThrow();
  });
});
