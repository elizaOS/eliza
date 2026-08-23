/**
 * Unit tests for WeChat connector configuration constants.
 */

import { describe, expect, it } from "vitest";
import { WECHAT_PLUGIN_PACKAGE } from "./wechat-config.js";

describe("WECHAT_PLUGIN_PACKAGE", () => {
  it("defines the canonical WeChat plugin package name", () => {
    expect(WECHAT_PLUGIN_PACKAGE).toBe("@elizaos/plugin-wechat");
  });

  it("follows the canonical @elizaos scoped package naming convention", () => {
    expect(WECHAT_PLUGIN_PACKAGE.startsWith("@elizaos/plugin-")).toBe(true);
  });
});
