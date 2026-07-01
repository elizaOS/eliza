import { describe, expect, it } from "vitest";

import type { ListMessagesOptions, SendSmsOptions } from "./definitions";
import { MessagesWeb } from "./web";

describe("MessagesWeb fallback", () => {
  it("rejects malformed outbound SMS payloads before Android-only fallback errors", async () => {
    const messages = new MessagesWeb();

    await expect(
      messages.sendSms({ address: " \n\t ", body: "hello" }),
    ).rejects.toThrow("address is required");
    await expect(
      messages.sendSms({
        address: ["+15550100"] as unknown as string,
        body: { text: "hello" } as unknown as string,
      }),
    ).rejects.toThrow("address is required");
    await expect(
      messages.sendSms({ address: "+15550100", body: "" }),
    ).rejects.toThrow("body is required");
    await expect(
      messages.sendSms({ address: "+15550100", body: "hello" }),
    ).rejects.toThrow("SMS is only available on Android.");
  });

  it("does not coerce hostile outbound SMS values into valid strings", async () => {
    const messages = new MessagesWeb();
    const hostileAddress = {
      toString: () => "+15550100",
      trim: () => "+15550100",
    };
    const hostileBody = {
      toString: () => "send this",
      trim: () => "send this",
    };

    await expect(
      messages.sendSms({
        address: hostileAddress as unknown as string,
        body: "hello",
      }),
    ).rejects.toThrow("address is required");
    await expect(
      messages.sendSms({
        address: "+15550100",
        body: hostileBody as unknown as string,
      }),
    ).rejects.toThrow("body is required");
  });

  it.each([
    undefined,
    null,
    42,
    "sms",
  ])("rejects non-object outbound SMS payload %s as missing an address", async (options) => {
    const messages = new MessagesWeb();

    await expect(
      messages.sendSms(options as unknown as SendSmsOptions),
    ).rejects.toThrow("address is required");
  });

  it.each([
    0,
    -1,
    501,
    "25",
    null,
    { valueOf: () => 25 },
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects malformed listMessages limit %s", async (limit) => {
    const messages = new MessagesWeb();

    await expect(
      messages.listMessages({ limit } as unknown as ListMessagesOptions),
    ).rejects.toThrow("limit must be between 1 and 500");
  });

  it("returns an empty message list for valid web fallback queries", async () => {
    const messages = new MessagesWeb();

    await expect(
      messages.listMessages({ limit: 25.9, threadId: "../../thread" }),
    ).resolves.toEqual({ messages: [] });
  });

  it("keeps fallback state stable across rejected sends and repeated reads", async () => {
    const messages = new MessagesWeb();

    const results = await Promise.allSettled([
      messages.sendSms({ address: "+15550100", body: "hello" }),
      messages.sendSms({ address: "", body: "hello" }),
      messages.listMessages({ limit: 1 }),
      messages.listMessages(),
    ]);

    expect(results).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({
          message: "SMS is only available on Android.",
        }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "address is required" }),
      },
      { status: "fulfilled", value: { messages: [] } },
      { status: "fulfilled", value: { messages: [] } },
    ]);
  });
});
