/**
 * Prefix-coerced /api/dev query tunables must be invalid.
 * Number("1e2") === 100 used to become a real maxLines / limit.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

import { parseDevPositiveInt } from "./dev-compat-routes";

describe("dev-compat query integers", () => {
  it("1e2 is invalid instead of becoming 100", () => {
    expect(parseDevPositiveInt("1e2")).toBe("invalid");
  });

  it("007 is invalid instead of becoming 7", () => {
    expect(parseDevPositiveInt("007")).toBe("invalid");
  });

  it("0x10 is invalid instead of becoming 16", () => {
    expect(parseDevPositiveInt("0x10")).toBe("invalid");
  });

  it("canonical 50 still parses", () => {
    expect(parseDevPositiveInt("50")).toBe(50);
  });

  it("omitted tunable stays omit", () => {
    expect(parseDevPositiveInt(null)).toBe("omit");
  });
});
