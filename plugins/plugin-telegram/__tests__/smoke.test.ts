import { beforeAll, describe, expect, it } from "vitest";

describe("@elizaos/plugin-telegram", () => {
  let mod: typeof import("../src/index.ts");

  beforeAll(async () => {
    mod = await import("../src/index.ts");
  }, 120_000);

  it("exports the plugin as default", () => {
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("object");
  });

  describe("plugin registration contract", () => {
    it("has a name", () => {
      const { default: plugin } = mod;
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name.length).toBeGreaterThan(0);
    });

    it("has a description", () => {
      const { default: plugin } = mod;
      expect(typeof plugin.description).toBe("string");
      expect(plugin.description.length).toBeGreaterThan(0);
    });

    it("has services array with TelegramService", () => {
      const { default: plugin } = mod;
      expect(Array.isArray(plugin.services)).toBe(true);
      expect(plugin.services!.length).toBeGreaterThan(0);
    });

    it("has routes array", () => {
      const { default: plugin } = mod;
      expect(Array.isArray(plugin.routes)).toBe(true);
      expect(plugin.routes!.length).toBeGreaterThan(0);
    });

    it("has tests array", () => {
      const { default: plugin } = mod;
      expect(Array.isArray(plugin.tests)).toBe(true);
      expect(plugin.tests!.length).toBeGreaterThan(0);
    });

    it("has autoEnable with connectorKeys for telegram", () => {
      const { default: plugin } = mod;
      expect(plugin.autoEnable).toBeDefined();
      const autoEnable = plugin.autoEnable as { connectorKeys?: string[] };
      expect(Array.isArray(autoEnable.connectorKeys)).toBe(true);
      expect(autoEnable.connectorKeys).toContain("telegram");
    });
  });

  describe("named exports", () => {
    it("exports TelegramService class", () => {
      expect(mod.TelegramService).toBeDefined();
    });

    it("exports MessageManager class", () => {
      expect(mod.MessageManager).toBeDefined();
    });

    it("exports stopTelegramAccountAuthSession function", () => {
      expect(typeof mod.stopTelegramAccountAuthSession).toBe("function");
    });
  });
});
