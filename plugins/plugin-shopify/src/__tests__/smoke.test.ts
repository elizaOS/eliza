import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-shopify", () => {
  it("exports the plugin", { timeout: 60_000 }, async () => {
    const mod = await import("../index.ts");
    expect(mod).toBeDefined();
  });

  it("has required plugin properties", async () => {
    const mod = await import("../index.ts");
    const plugin =
      mod.default ?? mod.plugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name).toBe("shopify");
      expect(typeof plugin.description).toBe("string");
    }
  });

  it("declares actions", async () => {
    const mod = await import("../index.ts");
    const plugin =
      mod.default ?? mod.plugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.actions)).toBe(true);
      expect(plugin.actions.length).toBeGreaterThan(0);
    }
  });

  it("declares services", async () => {
    const mod = await import("../index.ts");
    const plugin =
      mod.default ?? mod.plugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.services)).toBe(true);
      expect(plugin.services.length).toBeGreaterThan(0);
    }
  });

  it("declares providers", async () => {
    const mod = await import("../index.ts");
    const plugin =
      mod.default ?? mod.plugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.providers)).toBe(true);
      expect(plugin.providers.length).toBeGreaterThan(0);
    }
  });
});
