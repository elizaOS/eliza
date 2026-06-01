import { describe, expect, it } from "vitest";

import {
  CORE_PLUGINS,
  DEFERRED_CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.ts";

describe("CORE_PLUGINS", () => {
  it("does not load plugin-google or plugin-lifeops by default", () => {
    // These two plugins pull in heavy native/cloud deps (googleapis and
    // @capacitor/core) that the slim Docker runtime image intentionally does
    // not bundle. Loading them by default crashed the boot smoke / boot gate
    // (#8081) with "Cannot find package 'googleapis' / @capacitor/core". They
    // require explicit configuration (Google OAuth, LifeOps enablement), so
    // they belong in OPTIONAL_CORE_PLUGINS, never the default core load set.
    expect(CORE_PLUGINS).not.toContain("@elizaos/plugin-google");
    expect(CORE_PLUGINS).not.toContain("@elizaos/plugin-lifeops");
    expect(DEFERRED_CORE_PLUGINS).not.toContain("@elizaos/plugin-google");
    expect(DEFERRED_CORE_PLUGINS).not.toContain("@elizaos/plugin-lifeops");
  });

  it("exposes plugin-google and plugin-lifeops as optional, explicitly-enabled plugins", () => {
    expect(OPTIONAL_CORE_PLUGINS).toContain("@elizaos/plugin-google");
    expect(OPTIONAL_CORE_PLUGINS).toContain("@elizaos/plugin-lifeops");
  });
});
