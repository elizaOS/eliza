/**
 * Locks the cn() tailwind-merge contract for the custom font-size utilities
 * registered in tailwind-theme.css. Without the classGroups registration,
 * tailwind-merge parses `text-xs-tight` / `text-2xs` / `text-3xs` as text
 * COLORS and silently drops them whenever a real color class appears in the
 * same cn() call. Real merge library, no mocks.
 */
import { describe, expect, it } from "vitest";

import { cn } from "./utils";

const CUSTOM_SIZES = [
  "text-3xs",
  "text-2xs",
  "text-xs-tight",
  "text-sm-tight",
  "text-chat-body",
  "text-chat-lead",
] as const;

describe("cn() custom font-size merge contract", () => {
  it.each(CUSTOM_SIZES)("%s survives a following text color", (size) => {
    expect(cn(size, "text-muted")).toBe(`${size} text-muted`);
  });

  it.each(CUSTOM_SIZES)("%s survives a preceding text color", (size) => {
    expect(cn("text-muted", size)).toBe(`text-muted ${size}`);
  });

  it("keeps a custom size alongside arbitrary-value and opacity-suffixed colors", () => {
    expect(cn("text-chat-body", "text-white/80")).toBe(
      "text-chat-body text-white/80",
    );
    expect(cn("text-xs-tight", "text-[color:var(--brand-white)]")).toBe(
      "text-xs-tight text-[color:var(--brand-white)]",
    );
  });

  it("resolves custom-size vs custom-size conflicts last-wins", () => {
    expect(cn("text-2xs", "text-xs-tight")).toBe("text-xs-tight");
    expect(cn("text-chat-body", "text-chat-lead")).toBe("text-chat-lead");
  });

  it("resolves custom-size vs built-in-size conflicts last-wins in both directions", () => {
    expect(cn("text-sm", "text-chat-body")).toBe("text-chat-body");
    expect(cn("text-chat-body", "text-sm")).toBe("text-sm");
    expect(cn("text-xs", "text-2xs")).toBe("text-2xs");
    expect(cn("text-3xs", "text-[16px]")).toBe("text-[16px]");
  });

  it("does not merge a size across a variant boundary", () => {
    // The composer pattern: base size + coarse-pointer override must coexist.
    expect(cn("text-chat-body", "pointer-coarse:text-[16px]")).toBe(
      "text-chat-body pointer-coarse:text-[16px]",
    );
  });

  it("leaves ordinary Tailwind size and color merging undisturbed", () => {
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
    expect(cn("text-muted", "text-warn")).toBe("text-warn");
    expect(cn("text-sm", "text-muted")).toBe("text-sm text-muted");
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
