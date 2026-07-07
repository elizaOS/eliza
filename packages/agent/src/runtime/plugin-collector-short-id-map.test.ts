/**
 * Verifies collectPluginNames() resolves optional short-id aliases (wallet, evm,
 * coding-agent, …) to their first-party plugin packages through the generated
 * OPTIONAL_PLUGIN_MAP, rejecting the un-namespaced literal-package fallback that
 * silently fails inside the loader's error boundary. The registry-owned aliases
 * are generated from each entry's `shortIds`; the legacy host-owned tail still
 * resolves too. Deterministic — plain in-memory ElizaConfig, no live model or fs.
 */
import { describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames, OPTIONAL_PLUGIN_MAP } from "./plugin-collector.ts";

describe("collectPluginNames optional short-id registry map", () => {
  it("exposes the registry-generated wallet aliases", () => {
    // Derived from plugins/plugin-wallet/registry-entry.json `shortIds`.
    expect(OPTIONAL_PLUGIN_MAP.evm).toBe("@elizaos/plugin-wallet");
    expect(OPTIONAL_PLUGIN_MAP.solana).toBe("@elizaos/plugin-wallet");
    expect(OPTIONAL_PLUGIN_MAP.wallet).toBe("@elizaos/plugin-wallet");
    expect(OPTIONAL_PLUGIN_MAP["agent-wallet"]).toBe("@elizaos/plugin-wallet");
  });

  it("still resolves the legacy host-owned tail (plugins without a registry entry)", () => {
    // These packages ship no registry-entry.json, so their aliases remain in the
    // explicitly-marked LEGACY_HOST_OWNED_SHORT_ID_MAP fallback.
    expect(OPTIONAL_PLUGIN_MAP.selfcontrol).toBe(
      "@elizaos/plugin-personal-assistant",
    );
    expect(OPTIONAL_PLUGIN_MAP.repoPrompt).toBe("@elizaos/plugin-repoprompt");
    expect(OPTIONAL_PLUGIN_MAP["stwd-eliza-plugin"]).toBe("@stwd/eliza-plugin");
  });

  it("resolves a short-id allow-list entry to the canonical package, not the literal", () => {
    const names = collectPluginNames({
      plugins: { allow: ["evm"] },
    } as unknown as ElizaConfig);

    expect(names.has("@elizaos/plugin-wallet")).toBe(true);
    // The un-namespaced literal must never be added — it would resolve to the
    // raw `evm` npm package (or nothing) and silently fail the loader.
    expect(names.has("evm")).toBe(false);
    expect(names.has("@elizaos/plugin-evm")).toBe(false);
  });

  it("resolves a short-id feature flag to the canonical package", () => {
    const names = collectPluginNames({
      features: { vision: true },
    } as unknown as ElizaConfig);

    expect(names.has("@elizaos/plugin-vision")).toBe(true);
    expect(names.has("vision")).toBe(false);
  });

  it("keeps a stable registry entry as the source of truth over drift", () => {
    // browser has the most aliases; all must point at the one canonical package.
    for (const alias of [
      "browser",
      "app-browser",
      "appBrowser",
      "eliza-browser",
      "elizaBrowser",
      "browser-bridge",
      "browserBridge",
    ]) {
      expect(OPTIONAL_PLUGIN_MAP[alias]).toBe("@elizaos/plugin-browser");
    }
  });
});
