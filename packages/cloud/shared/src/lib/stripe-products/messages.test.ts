/**
 * Coverage for stripe product messages.
 */
import { describe, expect, it } from "vitest";

import { getStripeProductMessages } from "./messages.js";

describe("getStripeProductMessages", () => {
  it("returns en for no locale", () => {
    expect(getStripeProductMessages()).toBeDefined();
    expect(getStripeProductMessages(null)).toBeDefined();
    expect(getStripeProductMessages("")).toBeDefined();
  });

  it("returns catalog for known locale", () => {
    expect(getStripeProductMessages("es")).toBeDefined();
    expect(getStripeProductMessages("ja")).toBeDefined();
    expect(getStripeProductMessages("zh-CN")).toBeDefined();
  });

  it("falls back to en for unknown", () => {
    const en = getStripeProductMessages("en");
    expect(getStripeProductMessages("xx")).toBe(en);
    expect(getStripeProductMessages("unknown-locale")).toBe(en);
  });

  it("handles primary fallback", () => {
    const pt = getStripeProductMessages("pt");
    expect(getStripeProductMessages("pt-BR")).toBe(pt);
  });

  it("is case-sensitive", () => {
    const en = getStripeProductMessages("en");
    expect(getStripeProductMessages("ES")).toBe(en);
  });
});
