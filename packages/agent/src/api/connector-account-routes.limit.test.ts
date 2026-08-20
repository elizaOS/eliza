/** Connector-audit page sizes accept only canonical positive integers. */
import { describe, expect, it } from "vitest";
import { parseAuditLimit } from "./connector-account-routes";

describe("connector audit query integers", () => {
  it("rejects scientific notation", () => {
    expect(parseAuditLimit("1e2")).toBe("invalid");
  });

  it("rejects leading zeroes", () => {
    expect(parseAuditLimit("007")).toBe("invalid");
  });

  it("rejects hexadecimal notation", () => {
    expect(parseAuditLimit("0x10")).toBe("invalid");
  });

  it("canonical 5 still parses", () => {
    expect(parseAuditLimit("5")).toBe(5);
  });

  it("omitted limit keeps the default 50", () => {
    expect(parseAuditLimit(undefined)).toBe(50);
  });
});
