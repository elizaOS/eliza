import { describe, expect, it } from "vitest";
import { normalizeGateRole } from "./context-gates";
import type { RoleGateRole } from "./context-gates";

/**
 * Tests for the role-gate normalizer (#8801 / #9943). normalizeGateRole canon-
 * icalizes a role before a gate check; the USER->MEMBER alias and the case/trim
 * handling must be consistent or role gating silently diverges. It was untested.
 */
const norm = (r: string) => normalizeGateRole(r as RoleGateRole);

describe("normalizeGateRole", () => {
  it("aliases USER to MEMBER", () => {
    expect(norm("USER")).toBe("MEMBER");
    expect(norm("user")).toBe("MEMBER");
  });

  it("uppercases and trims", () => {
    expect(norm("  admin  ")).toBe("ADMIN");
    expect(norm("owner")).toBe("OWNER");
  });

  it("leaves an already-canonical role unchanged", () => {
    expect(norm("MEMBER")).toBe("MEMBER");
    expect(norm("OWNER")).toBe("OWNER");
  });
});
