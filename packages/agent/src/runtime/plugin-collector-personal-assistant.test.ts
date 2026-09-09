/**
 * Covers the LifeOps owner-chat gates in collectPluginNames() (#17023). Host
 * manifests opt into @elizaos/plugin-personal-assistant; a plain standalone
 * agent does not assume that unshipped dependency. Explicit operator and
 * constrained-profile gates still win. Deterministic — env-driven over an
 * in-memory ElizaConfig, no live model or runtime boot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  collectPluginNames,
  orderPersonalAssistantBeforeComposedPlugins,
} from "./plugin-collector.ts";

const PA = "@elizaos/plugin-personal-assistant";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_PLUGIN_SET",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DISABLE_PERSONAL_ASSISTANT",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const emptyConfig: ElizaConfig = {} as ElizaConfig;
const enabledConfig = (): ElizaConfig =>
  ({
    plugins: { entries: { "personal-assistant": { enabled: true } } },
  }) as ElizaConfig;

describe("collectPluginNames personal-assistant host gate (#17023)", () => {
  it("keeps personal-assistant out of a plain standalone agent boot", () => {
    const names = collectPluginNames(emptyConfig);

    expect(names.has(PA)).toBe(false);
    // The scheduling primitive the routine runner depends on stays core.
    expect(names.has("@elizaos/plugin-scheduling")).toBe(true);
  });

  it("honors explicit operator disablement via plugins.entries", () => {
    const names = collectPluginNames({
      plugins: { entries: { "personal-assistant": { enabled: false } } },
    } as ElizaConfig);

    expect(names.has(PA)).toBe(false);
  });

  it("keeps a persisted legacy explicit enable working", () => {
    const names = collectPluginNames({
      plugins: { entries: { "personal-assistant": { enabled: true } } },
    } as ElizaConfig);

    expect(names.has(PA)).toBe(true);
  });

  it("honors the ELIZA_DISABLE_PERSONAL_ASSISTANT env kill-switch", () => {
    process.env.ELIZA_DISABLE_PERSONAL_ASSISTANT = "1";
    expect(collectPluginNames(enabledConfig()).has(PA)).toBe(false);
  });

  it("stays out of the lean-chat set", () => {
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    expect(collectPluginNames(enabledConfig()).has(PA)).toBe(false);
  });

  it("stays out of mobile boots (no PA loader in the app sandbox)", () => {
    process.env.ELIZA_PLATFORM = "android";
    expect(collectPluginNames(enabledConfig()).has(PA)).toBe(false);
  });

  it("stays out of store builds", () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    expect(collectPluginNames(enabledConfig()).has(PA)).toBe(false);
  });

  it("stays out of slim provisioned cloud containers (#8081 image constraint)", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(collectPluginNames(enabledConfig()).has(PA)).toBe(false);
  });

  it("registers the assistant before the calendar and goals plugins it composes (#30943)", () => {
    const names = Array.from(collectPluginNames(enabledConfig()));
    const assistant = names.indexOf(PA);
    const calendar = names.indexOf("@elizaos/plugin-calendar");
    expect(assistant).toBeGreaterThanOrEqual(0);
    expect(calendar).toBeGreaterThanOrEqual(0);
    expect(assistant).toBeLessThan(calendar);
    const goals = names.indexOf("@elizaos/plugin-goals");
    if (goals !== -1) expect(assistant).toBeLessThan(goals);
  });

  it("keeps the calendar plugin in place when the assistant is absent", () => {
    const names = Array.from(collectPluginNames(emptyConfig));
    expect(names).not.toContain(PA);
    expect(names).toContain("@elizaos/plugin-calendar");
  });
});

describe("orderPersonalAssistantBeforeComposedPlugins", () => {
  it("moves the assistant ahead of the first composed plugin and keeps every other position", () => {
    const set = new Set([
      "@elizaos/plugin-sql",
      "@elizaos/plugin-calendar",
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-goals",
      PA,
      "@elizaos/plugin-finances",
    ]);
    orderPersonalAssistantBeforeComposedPlugins(set);
    expect(Array.from(set)).toEqual([
      "@elizaos/plugin-sql",
      PA,
      "@elizaos/plugin-calendar",
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-goals",
      "@elizaos/plugin-finances",
    ]);
  });

  it("is a no-op when the assistant already precedes them or is absent", () => {
    const already = new Set([PA, "@elizaos/plugin-calendar"]);
    orderPersonalAssistantBeforeComposedPlugins(already);
    expect(Array.from(already)).toEqual([PA, "@elizaos/plugin-calendar"]);
    const absent = new Set([
      "@elizaos/plugin-calendar",
      "@elizaos/plugin-goals",
    ]);
    orderPersonalAssistantBeforeComposedPlugins(absent);
    expect(Array.from(absent)).toEqual([
      "@elizaos/plugin-calendar",
      "@elizaos/plugin-goals",
    ]);
  });
});
