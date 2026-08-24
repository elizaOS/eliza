/**
 * Unit tests for setup classes: validates wizard style constants.
 */
import { describe, expect, it } from "vitest";
import {
  setupDetailStackClassName,
  setupPrimaryActionClass,
  setupReadableTextStrongClassName,
  setupTextShadowStyle,
  setupTitleClass,
} from "./setup-classes.ts";

describe("setup-classes", () => {
  it("exports detail stack and readable text class constants", () => {
    expect(setupDetailStackClassName).toContain("flex");
    expect(setupDetailStackClassName).toContain("w-full");
    expect(setupReadableTextStrongClassName).toContain(
      "text-[var(--first-run-text-strong)]",
    );
  });

  it("exports title and primary action classes", () => {
    expect(setupTitleClass).toContain("text-center");
    expect(setupTitleClass).toContain("text-xl");
    expect(setupPrimaryActionClass).toContain("uppercase");
  });

  it("exports text shadow styles", () => {
    expect(setupTextShadowStyle.textShadow).toBe(
      "var(--first-run-text-shadow-strong)",
    );
  });
});
