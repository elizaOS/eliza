import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-computeruse", () => {
  it("exports the plugin", async () => {
    const mod = await import("../index.ts");
    expect(mod).toBeDefined();
  });

  it("has required plugin properties", async () => {
    const mod = await import("../index.ts");
    const plugin = mod.default ?? mod.computerUsePlugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name).toBe("@elizaos/plugin-computeruse");
      expect(typeof plugin.description).toBe("string");
    }
  });

  it("declares actions", async () => {
    const mod = await import("../index.ts");
    const plugin = mod.default ?? mod.computerUsePlugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.actions)).toBe(true);
      expect(plugin.actions.length).toBeGreaterThan(0);
    }
  });

  it("declares services", async () => {
    const mod = await import("../index.ts");
    const plugin = mod.default ?? mod.computerUsePlugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.services)).toBe(true);
      expect(plugin.services.length).toBeGreaterThan(0);
    }
  });

  it("declares providers", async () => {
    const mod = await import("../index.ts");
    const plugin = mod.default ?? mod.computerUsePlugin ?? Object.values(mod).find((v: any) => v?.name);
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.providers)).toBe(true);
      expect(plugin.providers.length).toBeGreaterThan(0);
    }
  });
});
