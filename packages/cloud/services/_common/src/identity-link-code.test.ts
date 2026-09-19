/** Exercises identity-link code parsing and reply mapping with deterministic unit inputs. */

import { describe, expect, it } from "vitest";
import {
  extractIdentityLinkCode,
  identityLinkReply,
  normalizeIdentityLinkCodeBody,
} from "./identity-link-code.js";

describe("extractIdentityLinkCode", () => {
  it("returns null for undefined or empty", () => {
    expect(extractIdentityLinkCode(undefined)).toBeNull();
    expect(extractIdentityLinkCode("")).toBeNull();
    expect(extractIdentityLinkCode("no code here")).toBeNull();
  });

  it("extracts and normalizes link code", () => {
    expect(extractIdentityLinkCode("Here is LINK-ABCD2345 please")).toBe(
      "LINK-ABCD2345",
    );
    expect(extractIdentityLinkCode("link-abcd2345 lower")).toBe(
      "LINK-ABCD2345",
    );
  });

  it("handles code at boundaries", () => {
    expect(extractIdentityLinkCode("LINK-ABCDEFGH")).toBe("LINK-ABCDEFGH");
  });

  it("rejects symbols outside the product link-code alphabet", () => {
    for (const body of ["01ABCDEF", "ABCDILOP", "ABCD2340"]) {
      expect(normalizeIdentityLinkCodeBody(body)).toBeNull();
      expect(extractIdentityLinkCode(`LINK-${body}`)).toBeNull();
    }
  });

  it("normalizes a valid unprefixed body for command transports", () => {
    expect(normalizeIdentityLinkCodeBody("abcd2345")).toBe("ABCD2345");
  });
});

describe("identityLinkReply", () => {
  it("returns linked reply", () => {
    expect(identityLinkReply("linked")).toMatch(/linked/i);
  });

  it("handles expired and already_used", () => {
    expect(identityLinkReply("expired")).toMatch(/expired/i);
    expect(identityLinkReply("already_used")).toMatch(/already used/i);
  });

  it("handles unknown status as default", () => {
    expect(identityLinkReply("unknown")).toMatch(/valid link code/i);
  });

  it("handles platform_mismatch and handle_conflict", () => {
    expect(identityLinkReply("platform_mismatch")).toMatch(
      /different platform/i,
    );
    expect(identityLinkReply("handle_conflict")).toMatch(/already linked/i);
  });
});
