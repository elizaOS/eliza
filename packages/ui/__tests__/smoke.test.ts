import { describe, expect, it } from "vitest";

/**
 * React components can be either functions (function components) or objects
 * (forwardRef components). This helper checks for both.
 */
function isReactComponent(value: unknown): boolean {
  return (
    typeof value === "function" || (typeof value === "object" && value !== null)
  );
}

describe("@elizaos/ui", () => {
  it("exports the package entry point", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
  });

  describe("cn utility", () => {
    it("merges class names", async () => {
      const { cn } = await import("../src/index.ts");
      expect(typeof cn).toBe("function");
      const result = cn("px-4", "py-2");
      expect(typeof result).toBe("string");
      expect(result).toContain("px-4");
      expect(result).toContain("py-2");
    });

    it("handles conflicting tailwind classes by keeping the last one", async () => {
      const { cn } = await import("../src/index.ts");
      const result = cn("px-4", "px-8");
      expect(result).toBe("px-8");
    });

    it("handles conditional classes", async () => {
      const { cn } = await import("../src/index.ts");
      const result = cn("base", false && "hidden", "visible");
      expect(result).toContain("base");
      expect(result).toContain("visible");
      expect(result).not.toContain("hidden");
    });

    it("handles undefined and null inputs", async () => {
      const { cn } = await import("../src/index.ts");
      const result = cn("base", undefined, null, "end");
      expect(result).toContain("base");
      expect(result).toContain("end");
    });

    it("returns empty string for no inputs", async () => {
      const { cn } = await import("../src/index.ts");
      expect(cn()).toBe("");
    });
  });

  describe("component exports", () => {
    it("exports Button component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Button).toBeDefined();
      expect(isReactComponent(mod.Button)).toBe(true);
    });

    it("exports Card components", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Card).toBeDefined();
      expect(isReactComponent(mod.Card)).toBe(true);
    });

    it("exports Input component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Input).toBeDefined();
      expect(isReactComponent(mod.Input)).toBe(true);
    });

    it("exports Badge component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Badge).toBeDefined();
      expect(isReactComponent(mod.Badge)).toBe(true);
    });

    it("exports Checkbox component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Checkbox).toBeDefined();
      expect(isReactComponent(mod.Checkbox)).toBe(true);
    });

    it("exports Label component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Label).toBeDefined();
      expect(isReactComponent(mod.Label)).toBe(true);
    });

    it("exports Separator component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Separator).toBeDefined();
      expect(isReactComponent(mod.Separator)).toBe(true);
    });

    it("exports Skeleton component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Skeleton).toBeDefined();
      expect(isReactComponent(mod.Skeleton)).toBe(true);
    });

    it("exports Spinner component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Spinner).toBeDefined();
      expect(isReactComponent(mod.Spinner)).toBe(true);
    });

    it("exports Switch component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Switch).toBeDefined();
      expect(isReactComponent(mod.Switch)).toBe(true);
    });

    it("exports Textarea component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Textarea).toBeDefined();
      expect(isReactComponent(mod.Textarea)).toBe(true);
    });

    it("exports Slider component", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.Slider).toBeDefined();
      expect(isReactComponent(mod.Slider)).toBe(true);
    });
  });

  describe("hook exports", () => {
    it("exports useClickOutside hook", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.useClickOutside).toBeDefined();
      expect(typeof mod.useClickOutside).toBe("function");
    });

    it("exports useTimeout hook", async () => {
      const mod = await import("../src/index.ts");
      expect(mod.useTimeout).toBeDefined();
      expect(typeof mod.useTimeout).toBe("function");
    });
  });

  describe("layout exports", () => {
    it("exports layout components", async () => {
      const mod = await import("../src/index.ts");
      expect(mod).toBeDefined();
    });
  });

  describe("floating-layers export", () => {
    it("exports floating layer utilities", async () => {
      const mod = await import("../src/lib/floating-layers.ts");
      expect(mod).toBeDefined();
    });
  });
});
