/**
 * Verifies collectPluginNames() resolves an enabled connector (WeChat) to its
 * first-party plugin package through the generated CHANNEL_PLUGIN_MAP, rejecting
 * the un-namespaced fallback name. Deterministic — a plain in-memory ElizaConfig,
 * no live model or filesystem.
 */
import { describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { CHANNEL_PLUGIN_MAP, collectPluginNames } from "./plugin-collector.ts";

describe("collectPluginNames channel registry map", () => {
  it("resolves WeChat from the generated first-party channel map", () => {
    expect(CHANNEL_PLUGIN_MAP.wechat).toBe("@elizaos/plugin-wechat");

    const names = collectPluginNames({
      connectors: {
        wechat: {
          enabled: true,
        },
      },
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-wechat")).toBe(true);
    expect(names.has("elizaoswechat")).toBe(false);
  });
});
