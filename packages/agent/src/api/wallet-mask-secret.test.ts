/**
 * Coverage for `maskSecret`, the redaction applied to wallet secrets in logs/UI.
 * Deterministic and run against the real implementation — the load-bearing case
 * is that short secrets stay fully masked so the 4+4 preview never leaks a whole
 * value.
 */
import { describe, expect, it } from "vitest";
import { maskSecret } from "./wallet.ts";

/**
 * `maskSecret` is the display/log redaction for wallet secrets (#8801 — shipped
 * untested). The security-critical property is that a SHORT secret is *fully*
 * masked: revealing first-4 + last-4 of an 8-char secret would expose all of it,
 * so the threshold must fully hide anything ≤ 8 chars and only ever show the
 * 4+4 window for longer values.
 */
describe("maskSecret", () => {
  it("fully masks empty / short secrets (≤ 8 chars)", () => {
    for (const v of ["", "a", "1234", "12345678" /* exactly 8 = boundary */]) {
      expect(maskSecret(v)).toBe("****");
    }
  });

  it("shows only the first 4 + last 4 for longer secrets", () => {
    expect(maskSecret("123456789")).toBe("1234...6789"); // 9 chars
    expect(maskSecret("0xABCDEF0123456789")).toBe("0xAB...6789");
  });

  it("never reveals the middle of a long secret", () => {
    const secret = `sk-${"M".repeat(40)}END`; // "sk-" + 40×M + "END"
    const masked = maskSecret(secret);
    expect(masked).not.toContain("MMMM"); // the 40-char middle is gone
    expect(masked).toBe("sk-M...MEND"); // first4 "sk-M" + last4 "MEND"
  });
});
