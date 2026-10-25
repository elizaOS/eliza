/** The Telegram gateway keeps a photo or document message instead of dropping it. */
import { describe, expect, test } from "bun:test";
import { telegramAdapter } from "../src/adapters/telegram";

function update(message: Record<string, unknown>) {
  return JSON.stringify({
    update_id: 1001,
    message: {
      message_id: 7,
      date: 1_760_000_000,
      from: { id: 42, first_name: "Ana" },
      chat: { id: 42, type: "private" },
      ...message,
    },
  });
}

describe("Telegram gateway media messages", () => {
  test("a captioned photo reaches the agent with its caption and a photo note", async () => {
    const event = await telegramAdapter.extractEvent(
      update({
        caption: "what plant is this?",
        photo: [{ file_id: "PHOTO1" }],
      }),
      {},
    );
    expect(event?.text).toBe(
      "what plant is this?\n[The user sent a photo on Telegram. This connector cannot open Telegram files yet.]",
    );
  });

  test("a document without a caption is not dropped", async () => {
    const event = await telegramAdapter.extractEvent(
      update({ document: { file_id: "DOC1", file_name: "invoice.pdf" } }),
      {},
    );
    expect(event?.text).toBe(
      '[The user sent a document ("invoice.pdf") on Telegram. This connector cannot open Telegram files yet.]',
    );
    expect(event?.isCommand).toBe(false);
  });

  test("a plain text message is unchanged", async () => {
    const event = await telegramAdapter.extractEvent(
      update({ text: "hello" }),
      {},
    );
    expect(event?.text).toBe("hello");
  });
});
