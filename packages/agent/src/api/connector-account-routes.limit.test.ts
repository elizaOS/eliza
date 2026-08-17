/**
 * Prefix-coerced connector-audit limits must be invalid.
 * Number("1e2") === 100 used to become a real audit page size.
 */
import { describe, expect, it } from "vitest";
import { parseAuditLimit } from "./connector-account-routes";

describe("connector audit query integers", () => {
  it("1e2 is invalid instead of becoming 100", () => {
    expect(parseAuditLimit("1e2")).toBe("invalid");
  });

  it("007 is invalid instead of becoming 7", () => {
    expect(parseAuditLimit("007")).toBe("invalid");
  });

  it("0x10 is invalid instead of becoming 16", () => {
    expect(parseAuditLimit("0x10")).toBe("invalid");
  });

  it("canonical 5 still parses", () => {
    expect(parseAuditLimit("5")).toBe(5);
  });

  it("omitted limit keeps the default 50", () => {
    expect(parseAuditLimit(undefined)).toBe(50);
  });
});
