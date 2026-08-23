/**
 * Unit tests for terminal CLI color palette tokens.
 */

import { describe, expect, it } from "vitest";
import { CLI_PALETTE } from "./palette.js";

describe("CLI_PALETTE", () => {
  it("contains all canonical color keys", () => {
    expect(CLI_PALETTE).toHaveProperty("accent");
    expect(CLI_PALETTE).toHaveProperty("accentBright");
    expect(CLI_PALETTE).toHaveProperty("accentDim");
    expect(CLI_PALETTE).toHaveProperty("info");
    expect(CLI_PALETTE).toHaveProperty("success");
    expect(CLI_PALETTE).toHaveProperty("warn");
    expect(CLI_PALETTE).toHaveProperty("error");
    expect(CLI_PALETTE).toHaveProperty("muted");
  });

  it("defines valid uppercase 6-digit hex color strings", () => {
    const hexPattern = /^#[0-9A-F]{6}$/;
    for (const [key, color] of Object.entries(CLI_PALETTE)) {
      expect(
        hexPattern.test(color),
        `Expected ${key} (${color}) to match ${hexPattern}`,
      ).toBe(true);
    }
  });

  it("matches the exact canonical palette definitions", () => {
    expect(CLI_PALETTE.accent).toBe("#FF5A2D");
    expect(CLI_PALETTE.accentBright).toBe("#FF7A3D");
    expect(CLI_PALETTE.accentDim).toBe("#D14A22");
    expect(CLI_PALETTE.info).toBe("#FF8A5B");
    expect(CLI_PALETTE.success).toBe("#2FBF71");
    expect(CLI_PALETTE.warn).toBe("#FFB020");
    expect(CLI_PALETTE.error).toBe("#E23D2D");
    expect(CLI_PALETTE.muted).toBe("#8B7F77");
  });

  it("has exactly 8 palette entries", () => {
    expect(Object.keys(CLI_PALETTE)).toHaveLength(8);
  });
});
