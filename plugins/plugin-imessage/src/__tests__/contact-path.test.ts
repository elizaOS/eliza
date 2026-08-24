import { describe, expect, it } from "vitest";
import { parseIMessageContactId } from "./contact-path.ts";

describe("parseIMessageContactId", () => {
  it("parses a valid contact id", () => {
    const r = parseIMessageContactId("/api/imessage/contacts/user123");
    expect(r).toEqual({ ok: true, id: "user123" });
  });

  it("decodes percent-encoded ids", () => {
    const r = parseIMessageContactId("/api/imessage/contacts/user%40example.com");
    expect(r).toEqual({ ok: true, id: "user@example.com" });
  });

  it("reports missing for non-contact paths", () => {
    expect(parseIMessageContactId("/api/other")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports missing for empty contact id", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports malformed for invalid percent-encoding", () => {
    expect(parseIMessageContactId("/api/imessage/contacts/%zz")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
