/**
 * Exercises every branch of iMessage contact identifier parsing against the
 * real parser; both HTTP route adapters gate contact access on these results.
 */
import { describe, expect, it } from "vitest";
import { parseIMessageContactId } from "./contact-path";

describe("parseIMessageContactId", () => {
  it("reports missing for paths outside the contacts prefix", () => {
    expect(parseIMessageContactId("/api/imessage/chats")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(parseIMessageContactId("/imessage/contacts/+14155550123")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(parseIMessageContactId("")).toEqual({ ok: false, reason: "missing" });
  });

  it("reports missing when the prefix carries no identifier", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("returns the raw identifier untouched", () => {
    const parsed = parseIMessageContactId("/api/imessage/contacts/+14155550123");
    expect(parsed).toEqual({ ok: true, id: "+14155550123" });
    expect(parsed.ok).toBe(true);
  });

  it("percent-decodes an encoded identifier", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/John%20Doe")).toEqual({
      ok: true,
      id: "John Doe",
    });
    expect(parseIMessageContactId("/api/imessage/contacts/email%40example.com")).toEqual({
      ok: true,
      id: "email@example.com",
    });
  });

  it("decodes an encoded slash instead of treating it as a path separator", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/team%2Fops")).toEqual({
      ok: true,
      id: "team/ops",
    });
  });

  it("decodes multibyte UTF-8 identifiers", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/ren%C3%A9e")).toEqual({
      ok: true,
      id: "renée",
    });
  });

  it("fails closed with malformed instead of throwing on invalid escapes", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/%zz")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseIMessageContactId("/api/imessage/contacts/%")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseIMessageContactId("/api/imessage/contacts/ok%2Gtruncated")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("never reports malformed for well-formed identifiers", () => {
    const parsed = parseIMessageContactId("/api/imessage/contacts/alice");
    if (!parsed.ok) {
      throw new Error("well-formed identifier parsed as malformed");
    }
    expect(parsed.id).toBe("alice");
  });
});
