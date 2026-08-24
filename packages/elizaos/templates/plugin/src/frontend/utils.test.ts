/**
 * `cn` class-name merge helper tests drive the real clsx + tailwind-merge
 * composition with deterministic inputs: conditional and nested inclusion,
 * conflicting-utility resolution, variant scoping, and empty-input behavior.
 */

import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins multiple string arguments with spaces", () => {
    expect(cn("btn", "btn-primary", "rounded-lg")).toBe("btn btn-primary rounded-lg");
  });

  it("omits falsy conditional inputs", () => {
    const isActive = false;
    expect(cn("badge", isActive && "badge-active", null, undefined)).toBe("badge");
  });

  it("includes only truthy keys from object inputs", () => {
    expect(cn("card", { "card-elevated": true, "card-disabled": false })).toBe(
      "card card-elevated",
    );
  });

  it("flattens nested arrays of classes", () => {
    expect(cn(["p-1", ["px-2"]], "py-3")).toBe("p-1 px-2 py-3");
  });

  it("lets a later conflicting padding utility win", () => {
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  it("keeps utilities from different groups", () => {
    expect(cn("p-4", "m-2")).toBe("p-4 m-2");
  });

  it("separates font-size and text-color conflict groups", () => {
    expect(cn("text-sm", "text-red-500", "text-blue-500")).toBe("text-sm text-blue-500");
  });

  it("resolves conflicts within the same hover variant only", () => {
    expect(cn("hover:p-4", "hover:p-8")).toBe("hover:p-8");
  });

  it("keeps the same property across different variants", () => {
    expect(cn("p-4", "hover:p-8")).toBe("p-4 hover:p-8");
  });

  it("returns an empty string when no input survives", () => {
    expect(cn()).toBe("");
    expect(cn("", false)).toBe("");
  });
});
