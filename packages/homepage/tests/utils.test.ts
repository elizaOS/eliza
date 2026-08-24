/**
 * Tests the homepage Tailwind class-name merger `cn` for conditional inputs,
 * conflict resolution, and empty-input handling through the real clsx +
 * tailwind-merge pipeline (deterministic unit suite, no mocks).
 */

import { describe, expect, test } from "bun:test";
import { cn } from "../src/lib/utils";

describe("cn", () => {
  test("joins plain class names in input order", () => {
    expect(cn("flex", "items-center")).toBe("flex items-center");
  });

  test("drops falsy conditional inputs used for variant flags", () => {
    const isCollapsed = false;
    expect(cn("flex", isCollapsed && "hidden")).toBe("flex");
    expect(cn("flex", undefined, null)).toBe("flex");
  });

  test("keeps truthy keys and drops falsy keys from object inputs", () => {
    expect(
      cn({
        "ring-2": true,
        hidden: false,
      }),
    ).toBe("ring-2");
  });

  test("flattens nested array inputs", () => {
    expect(cn(["px-2", ["py-1", "rounded"]])).toBe("px-2 py-1 rounded");
  });

  test("resolves same-group conflicts last-wins and dedupes repeats", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("px-2 px-4", "px-6")).toBe("px-6");
    expect(cn("shadow-sm", "shadow-sm")).toBe("shadow-sm");
  });

  test("keeps non-conflicting utilities even when they share a prefix", () => {
    expect(cn("text-sm", "text-red-500")).toBe("text-sm text-red-500");
  });

  test("lets a later broad utility fully override earlier axis utilities", () => {
    expect(cn("px-2 py-1", "p-4")).toBe("p-4");
  });

  test("keeps a broad padding utility alongside a later axis refinement", () => {
    expect(cn("p-2", "px-4")).toBe("p-2 px-4");
    expect(cn("px-4", "p-2")).toBe("p-2");
  });

  test("merges arbitrary-value utilities within their group", () => {
    expect(cn("w-[10px]", "w-8")).toBe("w-8");
  });

  test("scopes conflict resolution per responsive modifier", () => {
    expect(cn("md:px-2", "px-4", "md:px-6")).toBe("px-4 md:px-6");
  });

  test("returns an empty string when every input is absent", () => {
    expect(cn()).toBe("");
    expect(cn("", null, undefined, false)).toBe("");
  });
});
