/** A dollar sign is a currency mark only at the start of a number. */
import { describe, expect, it } from "vitest";
import { parseValue, validateField } from "./validation";

const control = { key: "amount", label: "Amount", type: "number" as const };

describe("validateField currency numbers", () => {
  it("rejects a dollar sign inside the digits", () => {
    expect(validateField("1$2", control).valid).toBe(false);
    expect(parseValue("1$2", control)).toBe("1$2");
  });

  it("rejects a trailing dollar sign", () => {
    expect(validateField("50$", control).valid).toBe(false);
    expect(parseValue("50$", control)).toBe("50$");
  });

  it("still accepts a leading dollar sign and thousands commas", () => {
    expect(validateField("$50", control).valid).toBe(true);
    expect(parseValue("$50", control)).toBe(50);
    expect(parseValue("$1,234", control)).toBe(1234);
    expect(parseValue("1,234", control)).toBe(1234);
  });
});
