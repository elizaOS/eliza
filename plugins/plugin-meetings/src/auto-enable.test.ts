import { readFileSync } from "node:fs";
import type { PluginAutoEnableContext } from "@elizaos/core";
import { isMobilePlatform } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable.ts";
import { meetingsPlugin } from "./index.js";

// The auto-enable engine loads a plugin ONLY when its package.json declares
// `elizaos.plugin.autoEnableModule` and that module exports `shouldEnable(ctx)`
// (packages/agent/src/runtime/plugin-resolver.ts — "sourced exclusively from
// per-plugin manifests"). The runtime `Plugin.autoEnable` field is NOT read by
// the loader. These tests guard the manifest wiring so the plugin can never
// regress back to being undiscoverable.

function ctx(
  env: Record<string, string | undefined>,
  isNativePlatform = false,
): PluginAutoEnableContext {
  return { env, config: {}, isNativePlatform };
}

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
  it("does NOT enable when no opt-in env is set", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ ELIZA_MEETINGS_ENABLED: "   " }))).toBe(false);
  });

  it("enables on the explicit opt-in flag", () => {
    expect(shouldEnable(ctx({ ELIZA_MEETINGS_ENABLED: "1" }))).toBe(true);
    expect(shouldEnable(ctx({ ELIZA_MEETINGS_ENABLED: "true" }))).toBe(true);
  });

  it("enables when a Chromium binary is provided", () => {
    expect(
      shouldEnable(ctx({ ELIZA_MEETINGS_CHROMIUM_PATH: "/usr/bin/chromium" })),
    ).toBe(true);
  });

  it("vetoes mobile even when the opt-in flag is set (no browser sandbox)", () => {
    expect(
      shouldEnable(
        ctx(
          {
            ELIZA_MEETINGS_ENABLED: "1",
            ELIZA_MEETINGS_CHROMIUM_PATH: "/usr/bin/chromium",
          },
          true,
        ),
      ),
    ).toBe(false);
  });

  it("stays in lockstep with the declarative Plugin.autoEnable predicate", () => {
    const envs: Record<string, string | undefined>[] = [
      {},
      { ELIZA_MEETINGS_ENABLED: "1" },
      { ELIZA_MEETINGS_CHROMIUM_PATH: "/usr/bin/chromium" },
      { ELIZA_PLATFORM: "ios", ELIZA_MEETINGS_ENABLED: "1" },
      { ELIZA_PLATFORM: "android", ELIZA_MEETINGS_CHROMIUM_PATH: "/x" },
    ];
    for (const env of envs) {
      const viaModule = shouldEnable(ctx(env, isMobilePlatform(env)));
      const viaField = meetingsPlugin.autoEnable?.shouldEnable?.(env, {});
      expect(viaModule).toBe(viaField);
    }
  });
});
