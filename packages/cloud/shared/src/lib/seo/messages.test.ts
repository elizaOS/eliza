/**
 * Coverage for SEO messages.
 */
import { describe, expect, it } from "vitest";

import { getSeoMessages } from "./messages.js";

describe("getSeoMessages", () => {
  it("returns en for no locale", () => {
    expect(getSeoMessages()).toBeDefined();
    expect(getSeoMessages(null)).toBeDefined();
  });

  it("returns catalog for known locale", () => {
    expect(getSeoMessages("es")).toBeDefined();
    expect(getSeoMessages("zh-CN")).toBeDefined();
  });

  it("falls back to en for unknown", () => {
    const en = getSeoMessages("en");
    expect(getSeoMessages("xx")).toBe(en);
  });

  it("handles primary fallback", () => {
    const pt = getSeoMessages("pt");
    expect(getSeoMessages("pt-BR")).toBe(pt);
  });
});
