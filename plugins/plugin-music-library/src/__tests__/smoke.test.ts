import type { Plugin } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";

let mod: Record<string, unknown> & { default?: Plugin };
let plugin: Plugin;

beforeAll(async () => {
  mod = (await import("../index.ts")) as Record<string, unknown> & {
    default?: Plugin;
  };
  const candidate =
    mod.default ??
    (Object.values(mod).find(
      (value): value is Plugin =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { name?: unknown }).name === "string",
    ) as Plugin | undefined);
  if (!candidate) throw new Error("plugin export not found");
  plugin = candidate;
}, 120_000);

describe("@elizaos/plugin-music-library", () => {
  it("exports the plugin", () => {
    expect(mod).toBeDefined();
  });

  it("has required plugin properties", () => {
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name).toBe("music-library");
    expect(typeof plugin.description).toBe("string");
  });

  it("declares actions", () => {
    expect(Array.isArray(plugin.actions)).toBe(true);
    expect(plugin.actions?.length ?? 0).toBeGreaterThan(0);
  });

  it("declares services", () => {
    expect(Array.isArray(plugin.services)).toBe(true);
    expect(plugin.services?.length ?? 0).toBeGreaterThan(0);
  });

  it("declares providers", () => {
    expect(Array.isArray(plugin.providers)).toBe(true);
    expect(plugin.providers?.length ?? 0).toBeGreaterThan(0);
  });
});
