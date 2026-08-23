/**
 * Unit tests for advanced-capabilities toggle helpers. Drives the real module:
 * plugin-id membership, first-set-wins resolve order across experience/todos/
 * personality, in-place config writes, and the character-settings mirror.
 */
import { describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  ADVANCED_CAPABILITY_PLUGIN_IDS,
  applyAdvancedCapabilitiesConfig,
  applyAdvancedCapabilitySettings,
  isAdvancedCapabilityPluginId,
  resolveAdvancedCapabilitiesEnabled,
} from "./advanced-capabilities-config.ts";

describe("ADVANCED_CAPABILITY_PLUGIN_IDS", () => {
  it("is the ordered experience, todos, personality triplet", () => {
    expect(ADVANCED_CAPABILITY_PLUGIN_IDS).toEqual([
      "experience",
      "todos",
      "personality",
    ]);
  });
});

describe("isAdvancedCapabilityPluginId", () => {
  it("accepts each canonical plugin id", () => {
    for (const pluginId of ADVANCED_CAPABILITY_PLUGIN_IDS) {
      expect(isAdvancedCapabilityPluginId(pluginId)).toBe(true);
    }
  });

  it("rejects missing, empty, and near-miss ids", () => {
    expect(isAdvancedCapabilityPluginId("")).toBe(false);
    expect(isAdvancedCapabilityPluginId("todo")).toBe(false);
    expect(isAdvancedCapabilityPluginId("Experience")).toBe(false);
    expect(isAdvancedCapabilityPluginId("personality ")).toBe(false);
    expect(isAdvancedCapabilityPluginId("plugin-experience")).toBe(false);
  });
});

describe("resolveAdvancedCapabilitiesEnabled", () => {
  it("defaults on for an empty queue: null, undefined, or no plugin entries", () => {
    expect(resolveAdvancedCapabilitiesEnabled(null)).toBe(true);
    expect(resolveAdvancedCapabilitiesEnabled(undefined)).toBe(true);
    expect(resolveAdvancedCapabilitiesEnabled({})).toBe(true);
    expect(resolveAdvancedCapabilitiesEnabled({ plugins: {} })).toBe(true);
    expect(
      resolveAdvancedCapabilitiesEnabled({ plugins: { entries: {} } }),
    ).toBe(true);
  });

  it("returns the first set boolean in experience → todos → personality order", () => {
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: { entries: { experience: { enabled: true } } },
      }),
    ).toBe(true);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: { entries: { experience: { enabled: false } } },
      }),
    ).toBe(false);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: { entries: { todos: { enabled: true } } },
      }),
    ).toBe(true);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: { entries: { todos: { enabled: false } } },
      }),
    ).toBe(false);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: { entries: { personality: { enabled: true } } },
      }),
    ).toBe(true);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: { entries: { personality: { enabled: false } } },
      }),
    ).toBe(false);
  });

  it("lets an earlier set flag win over later disagreeing entries", () => {
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            experience: { enabled: false },
            todos: { enabled: true },
            personality: { enabled: true },
          },
        },
      }),
    ).toBe(false);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            todos: { enabled: false },
            personality: { enabled: true },
          },
        },
      }),
    ).toBe(false);
  });

  it("treats a tied triplet as that shared boolean", () => {
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            experience: { enabled: true },
            todos: { enabled: true },
            personality: { enabled: true },
          },
        },
      }),
    ).toBe(true);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            experience: { enabled: false },
            todos: { enabled: false },
            personality: { enabled: false },
          },
        },
      }),
    ).toBe(false);
  });

  it("skips a missing or non-boolean enabled field and keeps scanning", () => {
    const malformed = {
      plugins: {
        entries: {
          experience: { enabled: "true" },
          todos: { enabled: 0 },
          personality: { enabled: false },
        },
      },
    } as unknown as Pick<ElizaConfig, "plugins">;

    expect(resolveAdvancedCapabilitiesEnabled(malformed)).toBe(false);
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            experience: {},
            todos: { enabled: true },
          },
        },
      }),
    ).toBe(true);
  });

  it("ignores unrelated plugin entries when the triplet is unset", () => {
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            discord: { enabled: false },
            slack: { enabled: false },
          },
        },
      }),
    ).toBe(true);
  });
});

describe("applyAdvancedCapabilitiesConfig", () => {
  it("creates plugins.entries and writes enabled across the whole triplet", () => {
    const config: ElizaConfig = {};
    applyAdvancedCapabilitiesConfig(config, true);

    expect(config.plugins?.entries?.experience?.enabled).toBe(true);
    expect(config.plugins?.entries?.todos?.enabled).toBe(true);
    expect(config.plugins?.entries?.personality?.enabled).toBe(true);
  });

  it("overwrites existing triplet flags without dropping extra entry fields", () => {
    const config: ElizaConfig = {
      plugins: {
        allow: ["experience"],
        entries: {
          experience: { enabled: true, config: { retentionDays: 7 } },
          discord: { enabled: true, config: { token: "keep-me" } },
        },
      },
    };

    applyAdvancedCapabilitiesConfig(config, false);

    expect(config.plugins?.allow).toEqual(["experience"]);
    expect(config.plugins?.entries?.experience).toEqual({
      enabled: false,
      config: { retentionDays: 7 },
    });
    expect(config.plugins?.entries?.todos?.enabled).toBe(false);
    expect(config.plugins?.entries?.personality?.enabled).toBe(false);
    expect(config.plugins?.entries?.discord).toEqual({
      enabled: true,
      config: { token: "keep-me" },
    });
  });

  it("mutates the given config object in place", () => {
    const config: ElizaConfig = { plugins: { entries: {} } };
    const pluginsBefore = config.plugins;
    applyAdvancedCapabilitiesConfig(config, true);
    expect(config.plugins).toBe(pluginsBefore);
    expect(config.plugins?.entries).not.toBeUndefined();
  });
});

describe("applyAdvancedCapabilitySettings", () => {
  it("mirrors enabled as string flags and preserves unrelated settings", () => {
    const original = { OWNER_NAME: "ada", ADVANCED_CAPABILITIES: "stale" };
    const next = applyAdvancedCapabilitySettings(original, true);

    expect(next).toEqual({
      OWNER_NAME: "ada",
      ADVANCED_CAPABILITIES: "true",
      ENABLE_EXTENDED_CAPABILITIES: "true",
    });
    expect(original).toEqual({
      OWNER_NAME: "ada",
      ADVANCED_CAPABILITIES: "stale",
    });
    expect(next).not.toBe(original);
  });

  it("writes false string flags over an empty settings map", () => {
    expect(applyAdvancedCapabilitySettings({}, false)).toEqual({
      ADVANCED_CAPABILITIES: "false",
      ENABLE_EXTENDED_CAPABILITIES: "false",
    });
  });
});
