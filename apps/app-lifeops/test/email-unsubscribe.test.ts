import { describe, expect, test } from "vitest";
import {
  extractListUnsubscribeOptions,
  parseMailtoUnsubscribe,
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
