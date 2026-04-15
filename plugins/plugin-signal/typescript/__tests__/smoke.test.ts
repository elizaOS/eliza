import { beforeAll, describe, expect, it } from "vitest";

type SignalPluginShape = {
  actions?: unknown[];
  description: string;
  name: string;
  providers?: unknown[];
  services?: unknown[];
};

type SignalPluginModule = typeof import("../src/index.ts");

function isSignalPlugin(value: unknown): value is SignalPluginShape {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { description?: unknown; name?: unknown };
  return candidate.name === "signal" && typeof candidate.description === "string";
}

let mod: SignalPluginModule;
let plugin: SignalPluginShape | undefined;

describe("@elizaos/plugin-signal", () => {
  beforeAll(async () => {
    mod = await import("../src/index.ts");
    const defaultPlugin = isSignalPlugin(mod.default) ? mod.default : undefined;
    const namedPlugin =
      "plugin" in mod && isSignalPlugin(mod.plugin) ? mod.plugin : undefined;

    plugin = defaultPlugin ?? namedPlugin ?? Object.values(mod).find(isSignalPlugin);
  });

  it("exports the plugin", () => {
    expect(mod).toBeDefined();
  });

  it("has required plugin properties", () => {
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name).toBe("signal");
      expect(typeof plugin.description).toBe("string");
    }
  });

  it("declares actions", () => {
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.actions)).toBe(true);
      expect(plugin.actions.length).toBeGreaterThan(0);
    }
  });

  it("declares services", () => {
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.services)).toBe(true);
      expect(plugin.services.length).toBeGreaterThan(0);
    }
  });

  it("declares providers", () => {
    expect(plugin).toBeDefined();
    if (plugin) {
      expect(Array.isArray(plugin.providers)).toBe(true);
      expect(plugin.providers.length).toBeGreaterThan(0);
    }
  });
});
