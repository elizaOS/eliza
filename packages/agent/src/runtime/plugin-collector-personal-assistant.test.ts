/**
 * Covers the default LifeOps owner-chat gate in collectPluginNames() (#17023):
 * a clean full desktop/server boot loads @elizaos/plugin-personal-assistant so
 * OWNER_ROUTINES registers for owner conversations, while explicit operator
 * disablement, the env kill-switch, mobile, lean-chat, store builds, and slim
 * cloud containers keep it out. Deterministic — env-driven over an in-memory
 * ElizaConfig, no live model or runtime boot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

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

describe("collectPluginNames personal-assistant default gate (#17023)", () => {
  it("loads personal-assistant on a clean default full boot", () => {
    const reasons = new Map<string, string>();
    const names = collectPluginNames(emptyConfig, reasons);

    expect(names.has(PA)).toBe(true);
    // The scheduling primitive the routine runner depends on stays core.
    expect(names.has("@elizaos/plugin-scheduling")).toBe(true);
    expect(reasons.get(PA)).toContain("#17023");
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
    expect(collectPluginNames(emptyConfig).has(PA)).toBe(false);
  });

  it("stays out of the lean-chat set", () => {
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    expect(collectPluginNames(emptyConfig).has(PA)).toBe(false);
  });

  it("stays out of mobile boots (no PA loader in the app sandbox)", () => {
    process.env.ELIZA_PLATFORM = "android";
    expect(collectPluginNames(emptyConfig).has(PA)).toBe(false);
  });

  it("stays out of store builds", () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    expect(collectPluginNames(emptyConfig).has(PA)).toBe(false);
  });

  it("stays out of slim provisioned cloud containers (#8081 image constraint)", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(collectPluginNames(emptyConfig).has(PA)).toBe(false);
  });
});
