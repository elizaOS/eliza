/**
 * Unit tests for config control primitives helpers: validates input and textarea class derivation.
 */
import { describe, expect, it } from "vitest";
import {
  getConfigInputClassName,
  getConfigTextareaClassName,
} from "./config-control-primitives.helpers.ts";

describe("config-control-primitives.helpers", () => {
  it("derives regular input class name without error", () => {
    const cls = getConfigInputClassName({
      density: "regular",
      hasError: false,
    });
    expect(cls).toContain("h-9");
    expect(cls).toContain("rounded-sm");
    expect(cls).not.toContain("border-destructive");
  });

  it("derives compact input class name with error styling", () => {
    const cls = getConfigInputClassName({ density: "compact", hasError: true });
    expect(cls).toContain("h-8");
    expect(cls).toContain("text-xs");
    expect(cls).toContain("border-destructive");
  });

  it("derives textarea class name supporting density and custom classes", () => {
    const cls = getConfigTextareaClassName({
      className: "custom-textarea-class",
      density: "compact",
      hasError: false,
    });
    expect(cls).toContain("min-h-16");
    expect(cls).toContain("custom-textarea-class");
    expect(cls).toContain("resize-y");
  });
});
