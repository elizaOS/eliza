import { describe, expect, it } from "vitest";

import { CORE_PLUGINS } from "./core-plugins.ts";

describe("CORE_PLUGINS", () => {
  it("registers the Google connector before LifeOps uses it", () => {
    expect(CORE_PLUGINS).toContain("@elizaos/plugin-google");
    expect(CORE_PLUGINS.indexOf("@elizaos/plugin-google")).toBeLessThan(
      CORE_PLUGINS.indexOf("@elizaos/plugin-lifeops"),
    );
  });
});
