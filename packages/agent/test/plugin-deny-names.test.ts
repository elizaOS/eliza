/** `plugins.deny` and ELIZA_SKIP_PLUGINS accept the same ids as `plugins.allow`. */
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectDeniedPluginNames,
  collectPluginNames,
} from "../src/runtime/plugin-collector.ts";

it("denies a loaded plugin by short id, channel name or package name", () => {
  const config: ElizaConfig = {
    plugins: {
      allow: ["@elizaos/plugin-discord", "@elizaos/plugin-x", "openai"],
    },
  };
  const loaded = collectPluginNames(config);
  for (const name of [
    "@elizaos/plugin-discord",
    "@elizaos/plugin-x",
    "@elizaos/plugin-openai",
  ]) {
    expect(loaded.has(name)).toBe(true);
  }

  const denied = collectDeniedPluginNames([
    "discord",
    "twitter",
    "@elizaos/plugin-openai",
    "my-drop-in",
  ]);
  const remaining = [...loaded].filter((name) => !denied.has(name));

  expect(remaining).not.toContain("@elizaos/plugin-discord");
  expect(remaining).not.toContain("@elizaos/plugin-x");
  expect(remaining).not.toContain("@elizaos/plugin-openai");
  // Unscoped drop-in names are still matched as written.
  expect(denied.has("my-drop-in")).toBe(true);
});

afterEach(() => vi.unstubAllEnvs());

it("does not make reminder storage and actions mandatory in standalone or lean hosts", () => {
  vi.stubEnv("ELIZA_PLATFORM", "linux");
  for (const profile of ["", "lean-chat"]) {
    vi.stubEnv("ELIZA_PLUGIN_SET", profile);
    const selected = collectPluginNames({});
    expect(selected.has("@elizaos/plugin-goals")).toBe(false);
    expect(selected.has("@elizaos/plugin-reminders")).toBe(false);
    expect(
      selected.has("@elizaos/plugin-personal-assistant/reminders-plugin"),
    ).toBe(false);
  }
});

it("loads required storage for an explicitly selected reminder contribution", () => {
  vi.stubEnv("ELIZA_PLATFORM", "linux");
  vi.stubEnv("ELIZA_PLUGIN_SET", "lean-chat");
  const selected = collectPluginNames({
    plugins: { allow: ["@elizaos/plugin-personal-assistant/reminders-plugin"] },
  });
  for (const dependency of [
    "@elizaos/plugin-personal-assistant/reminders-plugin",
    "@elizaos/plugin-reminders",
    "@elizaos/plugin-goals",
    "@elizaos/plugin-scheduling",
  ])
    expect(selected.has(dependency)).toBe(true);
  expect(selected.has("@elizaos/plugin-personal-assistant")).toBe(false);
});

it("keeps the mobile full LifeOps owner without a second reminder contribution", () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  vi.stubEnv("ELIZA_PLUGIN_SET", "");
  vi.stubEnv("ELIZA_DISABLE_PERSONAL_ASSISTANT", "");
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "");
  const selected = collectPluginNames({});
  expect(selected.has("@elizaos/plugin-personal-assistant")).toBe(true);
  expect(
    selected.has("@elizaos/plugin-personal-assistant/reminders-plugin"),
  ).toBe(false);
  expect(selected.has("@elizaos/plugin-reminders")).toBe(true);
});

it("preserves explicit full PA selection and withholds its duplicate reminder owner", () => {
  vi.stubEnv("ELIZA_PLATFORM", "linux");
  vi.stubEnv("ELIZA_PLUGIN_SET", "");
  vi.stubEnv("ELIZA_DISABLE_PERSONAL_ASSISTANT", "");
  const selected = collectPluginNames({
    plugins: { entries: { "personal-assistant": { enabled: true } } },
  });
  expect(selected.has("@elizaos/plugin-personal-assistant")).toBe(true);
  expect(
    selected.has("@elizaos/plugin-personal-assistant/reminders-plugin"),
  ).toBe(false);
});

it("preserves selective mobile reminders when full PA is explicitly disabled", () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  vi.stubEnv("ELIZA_PLUGIN_SET", "");
  const selected = collectPluginNames({
    plugins: { entries: { "personal-assistant": { enabled: false } } },
  });
  expect(selected.has("@elizaos/plugin-personal-assistant")).toBe(false);
  for (const name of [
    "@elizaos/plugin-personal-assistant/reminders-plugin",
    "@elizaos/plugin-goals",
    "@elizaos/plugin-reminders",
    "@elizaos/plugin-scheduling",
  ])
    expect(selected.has(name)).toBe(true);
});

it("never resurrects an explicitly disabled selective reminder contribution", () => {
  vi.stubEnv("ELIZA_PLATFORM", "linux");
  vi.stubEnv("ELIZA_PLUGIN_SET", "lean-chat");
  const leaf = "@elizaos/plugin-personal-assistant/reminders-plugin";
  const selected = collectPluginNames({
    plugins: { allow: [leaf], entries: { [leaf]: { enabled: false } } },
  });
  for (const name of [
    leaf,
    "@elizaos/plugin-reminders",
    "@elizaos/plugin-goals",
  ])
    expect(selected.has(name)).toBe(false);
});

it("does not override explicitly disabled selective-owner dependencies", () => {
  vi.stubEnv("ELIZA_PLATFORM", "linux");
  vi.stubEnv("ELIZA_PLUGIN_SET", "lean-chat");
  const leaf = "@elizaos/plugin-personal-assistant/reminders-plugin";
  const selected = collectPluginNames({
    plugins: {
      allow: [leaf],
      entries: {
        calendar: { enabled: false },
        scheduling: { enabled: false },
        reminders: { enabled: false },
        goals: { enabled: false },
      },
    },
  });
  expect(selected.has(leaf)).toBe(true);
  for (const name of [
    "@elizaos/plugin-scheduling",
    "@elizaos/plugin-reminders",
    "@elizaos/plugin-goals",
  ])
    expect(selected.has(name)).toBe(false);
  // This asserts collection only; initialization with missing dependencies is
  // not qualified by this test.
});
