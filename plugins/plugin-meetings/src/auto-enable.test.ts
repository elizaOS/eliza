/**
 * Guards plugin-meetings auto-enable: the package.json manifest wiring and the
 * config-driven `shouldEnable` predicate. Deterministic — reads the real
 * package.json, no runtime.
 */
import { readFileSync } from "node:fs";
import type { PluginAutoEnableContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable.ts";

// The auto-enable engine loads a plugin ONLY when its package.json declares
// `elizaos.plugin.autoEnableModule` and that module exports `shouldEnable(ctx)`
// (packages/agent/src/runtime/plugin-resolver.ts — "sourced exclusively from
// per-plugin manifests"). These tests guard the manifest wiring and the
// config-driven enable predicate (no bespoke ELIZA_MEETINGS_* on/off flag).

function ctx(
  config: Record<string, unknown>,
  isNativePlatform = false,
): PluginAutoEnableContext {
  return { env: {}, config, isNativePlatform };
}

const withMeetings = (value: unknown) => ({ features: { meetings: value } });

describe("plugin-meetings auto-enable manifest wiring", () => {
  it("declares autoEnableModule pointing at the shipped root module", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.elizaos?.plugin?.autoEnableModule).toBe("./auto-enable.ts");
    // The referenced module must ship (files) and export shouldEnable — the
    // import at the top of this file already proves the export exists.
    expect(pkg.files).toContain("auto-enable.ts");
    expect(typeof shouldEnable).toBe("function");
  });
});

describe("plugin-meetings shouldEnable", () => {
  it("does NOT enable when the meetings feature is absent or turned off", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ features: {} }))).toBe(false);
    expect(shouldEnable(ctx(withMeetings(false)))).toBe(false);
    expect(shouldEnable(ctx(withMeetings({ enabled: false })))).toBe(false);
  });

  it("enables when the meetings feature is on in config", () => {
    expect(shouldEnable(ctx(withMeetings(true)))).toBe(true);
    expect(shouldEnable(ctx(withMeetings({ enabled: true })))).toBe(true);
    // A feature object without an explicit `enabled: false` is treated as on.
    expect(shouldEnable(ctx(withMeetings({ botName: "Notetaker" })))).toBe(
      true,
    );
  });

  it("does NOT key off any ELIZA_MEETINGS_* env flag (no bespoke switch)", () => {
    const withEnvOnly: PluginAutoEnableContext = {
      env: { ELIZA_MEETINGS_ENABLED: "1", ELIZA_MEETINGS_CHROMIUM_PATH: "/x" },
      config: {},
      isNativePlatform: false,
    };
    expect(shouldEnable(withEnvOnly)).toBe(false);
  });

  it("vetoes mobile even when the feature is on (no browser sandbox)", () => {
    expect(shouldEnable(ctx(withMeetings(true), true))).toBe(false);
  });
});
