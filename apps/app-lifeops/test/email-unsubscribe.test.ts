import { afterEach, describe, expect, test, vi } from "vitest";
import {
  extractListUnsubscribeOptions,
  parseMailtoUnsubscribe,
  performGmailHttpUnsubscribe,
  type GmailSubscriptionMessageHeaders,
} from "../src/lifeops/email-unsubscribe-gmail.js";

function makeHeader(
  overrides: Partial<GmailSubscriptionMessageHeaders> = {},
): GmailSubscriptionMessageHeaders {
  return {
    messageId: "msg-1",
    threadId: "thr-1",
    receivedAt: "2026-04-19T12:00:00Z",
    subject: "Your weekly digest",
    fromDisplay: "Acme Weekly",
    fromEmail: "news@acme.example",
    listId: "<acme-weekly.acme.example>",
    listUnsubscribe: null,
    listUnsubscribePost: null,
    snippet: "",
    labels: ["INBOX"],
    ...overrides,
  };
}

describe("email-unsubscribe-gmail header parsing", () => {
  test("parses List-Unsubscribe with both http and mailto entries", () => {
    const header = makeHeader({
      listUnsubscribe:
        "<https://unsubscribe.acme.example/u?id=abc>, <mailto:unsubscribe@acme.example?subject=unsubscribe>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
    const options = extractListUnsubscribeOptions(header);
    expect(options.httpUrl).toBe("https://unsubscribe.acme.example/u?id=abc");
    expect(options.mailto).toBe(
      "mailto:unsubscribe@acme.example?subject=unsubscribe",
    );
    expect(options.oneClickPost).toBe(true);
  });

  test("handles mailto-only senders", () => {
    const header = makeHeader({
      listUnsubscribe: "<mailto:leave@acme.example>",
    });
    const options = extractListUnsubscribeOptions(header);
    expect(options.httpUrl).toBeNull();
    expect(options.mailto).toBe("mailto:leave@acme.example");
    expect(options.oneClickPost).toBe(false);
  });

  test("returns nulls when no unsubscribe header is present", () => {
    const options = extractListUnsubscribeOptions(makeHeader());
    expect(options.httpUrl).toBeNull();
    expect(options.mailto).toBeNull();
    expect(options.oneClickPost).toBe(false);
  });

  test("does not treat non-one-click post headers as one-click", () => {
    const header = makeHeader({
      listUnsubscribe: "<https://unsubscribe.acme.example/u?id=abc>",
      listUnsubscribePost: "something else",
    });
    expect(extractListUnsubscribeOptions(header).oneClickPost).toBe(false);
  });
});

describe("parseMailtoUnsubscribe", () => {
  test("extracts recipient, subject, and body from a mailto URI", () => {
    const parsed = parseMailtoUnsubscribe(
      "mailto:unsubscribe@acme.example?subject=unsubscribe&body=please+stop",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.recipient).toBe("unsubscribe@acme.example");
    expect(parsed!.subject).toBe("unsubscribe");
    expect(parsed!.body).toBe("please stop");
  });

  test("accepts a bare mailto: with no query string", () => {
    const parsed = parseMailtoUnsubscribe("mailto:leave@acme.example");
    expect(parsed).not.toBeNull();
    expect(parsed!.recipient).toBe("leave@acme.example");
    expect(parsed!.subject).toBeNull();
    expect(parsed!.body).toBeNull();
  });

  test("rejects non-mailto URIs", () => {
    expect(parseMailtoUnsubscribe("https://example.com/unsub")).toBeNull();
    expect(parseMailtoUnsubscribe("")).toBeNull();
  });
});

describe("performGmailHttpUnsubscribe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not fall back to GET when one-click POST fails at the network layer", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      performGmailHttpUnsubscribe({
        url: "https://unsubscribe.acme.example/u?id=abc",
        preferOneClickPost: true,
      }),
    ).rejects.toThrow("network down");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  test("uses GET only when one-click POST is not requested", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        statusText: "No Content",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await performGmailHttpUnsubscribe({
      url: "https://unsubscribe.acme.example/u?id=abc",
      preferOneClickPost: false,
    });

    expect(result.method).toBe("GET");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});
