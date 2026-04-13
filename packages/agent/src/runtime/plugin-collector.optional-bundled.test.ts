/**
 * Optional bundled plugins (plugin-manager, secrets-manager, trust) are
 * listed in OPTIONAL_CORE_PLUGINS and must stay off unless explicitly enabled.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../../config/types.js";
import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins.js";
import { collectPluginNames } from "./plugin-collector.js";

const OPTIONAL_BUNDLED_ADMIN = [
  "@elizaos/plugin-plugin-manager",
  "@elizaos/plugin-secrets-manager",
  "@elizaos/plugin-trust",
] as const;

describe("optional bundled plugins (default off)", () => {
  const prevCloudKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const prevCloudEnabled = process.env.ELIZAOS_CLOUD_ENABLED;

  beforeEach(() => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  });

  afterEach(() => {
    if (prevCloudKey !== undefined) {
      process.env.ELIZAOS_CLOUD_API_KEY = prevCloudKey;
    } else {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    }
    if (prevCloudEnabled !== undefined) {
      process.env.ELIZAOS_CLOUD_ENABLED = prevCloudEnabled;
    } else {
      delete process.env.ELIZAOS_CLOUD_ENABLED;
    }
  });

  it("lists the three packages in OPTIONAL_CORE_PLUGINS (bundled, toggled off by default)", () => {
    for (const pkg of OPTIONAL_BUNDLED_ADMIN) {
      expect(OPTIONAL_CORE_PLUGINS).toContain(pkg);
    }
    for (const pkg of OPTIONAL_BUNDLED_ADMIN) {
      expect(CORE_PLUGINS).not.toContain(pkg);
    }
  });

  it("does not load optional bundled plugins with minimal config", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {},
    } as ElizaConfig);
    for (const pkg of OPTIONAL_BUNDLED_ADMIN) {
      expect(names.has(pkg)).toBe(false);
    }
  });

  it("loads each optional bundled plugin when listed in plugins.allow", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {
        allow: [...OPTIONAL_BUNDLED_ADMIN],
      },
    } as ElizaConfig);
    for (const pkg of OPTIONAL_BUNDLED_ADMIN) {
      expect(names.has(pkg)).toBe(true);
    }
  });

  it("loads optional bundled plugins only when plugins.entries has enabled: true (not empty entry)", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {
        entries: {
          "plugin-manager": {},
          "secrets-manager": { enabled: false },
          trust: { enabled: true },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-plugin-manager")).toBe(false);
    expect(names.has("@elizaos/plugin-secrets-manager")).toBe(false);
    expect(names.has("@elizaos/plugin-trust")).toBe(true);
  });

  it("respects plugins.entries enabled: false for optional bundled plugins", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {
        allow: ["@elizaos/plugin-trust"],
        entries: {
          trust: { enabled: false },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-trust")).toBe(false);
  });
});
