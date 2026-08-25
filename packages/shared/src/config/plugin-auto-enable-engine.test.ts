/**
 * Unit test asserting CONNECTOR_PLUGINS is sourced from the generated
 * first-party channel-plugin-map (e.g. wechat → @elizaos/plugin-wechat) rather
 * than a stale hand-maintained value.
 */
import { describe, expect, it } from "vitest";

import { CONNECTOR_PLUGINS } from "./plugin-auto-enable-engine";

describe("CONNECTOR_PLUGINS", () => {
  it("uses the generated first-party channel map for WeChat", () => {
    expect(CONNECTOR_PLUGINS.wechat).toBe("@elizaos/plugin-wechat");
    expect(Object.values(CONNECTOR_PLUGINS)).not.toContain("elizaoswechat");
  });
});
