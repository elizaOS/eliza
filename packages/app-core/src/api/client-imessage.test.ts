// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

describe("ElizaClient iMessage bridge methods", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: test shim
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test shim
    (globalThis as any).fetch = originalFetch;
  });

  it("requests chat-scoped messages with the expected query string", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "msg-1",
              fromHandle: "+15551112222",
              toHandles: [],
              text: "hello",
              isFromMe: false,
              sentAt: "2026-04-25T18:00:00.000Z",
              chatId: "iMessage;+;group-abc",
            },
          ],
          count: 1,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });
    const result = await client.getIMessageMessages({
      chatId: "  iMessage;+;group-abc  ",
      limit: 25,
    });

    expect(result).toEqual({
      messages: [
        {
          id: "msg-1",
          text: "hello",
          handle: "+15551112222",
          chatId: "iMessage;+;group-abc",
          timestamp: Date.parse("2026-04-25T18:00:00.000Z"),
          isFromMe: false,
          hasAttachments: false,
        },
      ],
      count: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /\/api\/lifeops\/connectors\/imessage\/messages\?chatId=iMessage%3B%2B%3Bgroup-abc&limit=25$/,
    );
  });

  it("posts send requests to the shared iMessage bridge route", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messageId: "msg-123",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });
    const result = await client.sendIMessage({
      to: "+15551112222",
      text: "hello from milady",
      mediaUrl: "/tmp/image.png",
    });

    expect(result).toEqual({
      success: true,
      messageId: "msg-123",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/lifeops\/connectors\/imessage\/send$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      to: "+15551112222",
      text: "hello from milady",
      attachmentPaths: ["/tmp/image.png"],
    });
  });
});
