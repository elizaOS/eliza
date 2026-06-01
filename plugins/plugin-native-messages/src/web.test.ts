import { describe, expect, it } from "vitest";

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

  it.each([
    0,
    -1,
    501,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects malformed listMessages limit %s", async (limit) => {
    const messages = new MessagesWeb();

    await expect(messages.listMessages({ limit })).rejects.toThrow(
      "limit must be between 1 and 500",
    );
  });

  it("returns an empty message list for valid web fallback queries", async () => {
    const messages = new MessagesWeb();

    await expect(
      messages.listMessages({ limit: 25.9, threadId: "../../thread" }),
    ).resolves.toEqual({ messages: [] });
  });
});
