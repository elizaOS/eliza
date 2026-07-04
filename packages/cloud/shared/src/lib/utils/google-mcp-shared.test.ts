// Exercises google mcp shared behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  errMsg,
  extractBody,
  mapCalendarEvent,
  mapContact,
  mapGmailMessage,
  sanitizeHeaderValue,
} from "./google-mcp-shared";

/**
 * Google MCP shared helpers. sanitizeHeaderValue strips CR/LF so an
 * attacker-controlled subject/recipient cannot inject extra email headers
 * (header-injection). extractBody walks the MIME tree and base64-decodes the
 * first text part; the mappers flatten Google's verbose API shapes into the
 * compact DTO the agent consumes.
 */

describe("sanitizeHeaderValue", () => {
  test("removes CR and LF (header-injection defense)", () => {
    expect(sanitizeHeaderValue("Subject: hi\r\nBcc: evil@x.com")).toBe(
      "Subject: hiBcc: evil@x.com",
    );
    expect(sanitizeHeaderValue("clean")).toBe("clean");
  });
});

describe("errMsg", () => {
  test("uses an Error's message, else the fallback", () => {
    expect(errMsg(new Error("boom"), "fb")).toBe("boom");
    expect(errMsg("not an error", "fb")).toBe("fb");
  });
});

describe("extractBody", () => {
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

  test("decodes a direct base64 body", () => {
    expect(extractBody({ body: { data: b64("hello") } })).toBe("hello");
  });

  test("prefers text/plain among MIME parts", () => {
    const payload = {
      parts: [
        { mimeType: "text/html", body: { data: b64("<b>html</b>") } },
        { mimeType: "text/plain", body: { data: b64("plain text") } },
      ],
    };
    expect(extractBody(payload)).toBe("plain text");
  });

  test("returns empty string when no body is present", () => {
    expect(extractBody({})).toBe("");
  });
});

describe("mappers", () => {
  test("mapGmailMessage flattens headers + converts internalDate", () => {
    const out = mapGmailMessage({
      id: "m1",
      threadId: "t1",
      internalDate: "0",
      payload: { headers: [{ name: "From", value: "a@b.com" }] },
    });
    expect(out.id).toBe("m1");
    expect((out.headers as Record<string, string>).From).toBe("a@b.com");
    expect(out.internalDate).toBe("1970-01-01T00:00:00.000Z");
  });

  test("mapCalendarEvent prefers dateTime, falls back to date", () => {
    const out = mapCalendarEvent({
      id: "e1",
      summary: "Sync",
      start: { dateTime: "2026-01-02T10:00:00Z" },
      end: { date: "2026-01-03" },
    });
    expect(out.start).toBe("2026-01-02T10:00:00Z");
    expect(out.end).toBe("2026-01-03");
  });

  test("mapContact picks the first name/email/phone and unwraps person", () => {
    const out = mapContact({
      person: {
        resourceName: "people/1",
        names: [{ displayName: "Ada" }],
        emailAddresses: [{ value: "ada@x.com" }, { value: "alt@x.com" }],
        phoneNumbers: [{ value: "+1555" }],
      },
    });
    expect(out).toMatchObject({ name: "Ada", email: "ada@x.com", phone: "+1555" });
  });
});
