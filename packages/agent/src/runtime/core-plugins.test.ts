/**
 * Guards the default plugin partition in core-plugins.ts: plugin-google-workspace and
 * plugin-personal-assistant (heavy native/cloud deps) stay out of the static
 * core and deferred load sets that every image shape shares. Personal-assistant
 * is default-loaded for full desktop/server boots by the collector gate in
 * plugin-collector.ts (#17023), which excludes the slim shapes; keeping it out
 * of CORE_PLUGINS is what protects those shapes (#8081). Pure assertions over
 * the exported name lists.
 */
import { describe, expect, it } from "vitest";

import {
  CORE_PLUGINS,
  DEFERRED_CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.ts";

describe("CORE_PLUGINS", () => {
  it("loads the documents route plugin for web and hosted agent defaults", () => {
    expect(CORE_PLUGINS).toContain("@elizaos/plugin-documents");
    expect(DEFERRED_CORE_PLUGINS).toContain("@elizaos/plugin-documents");
  });

  it("keeps plugin-google-workspace and plugin-personal-assistant out of the static core sets", () => {
    // These two plugins pull in heavy native/cloud deps (googleapis and
    // @capacitor/core) that the slim Docker runtime image intentionally does
    // not bundle. Loading them from the shared static sets crashed the boot
    // smoke / boot gate (#8081) with "Cannot find package 'googleapis' /
    // @capacitor/core". Personal-assistant is instead default-added for full
    // desktop/server boots by the collector gate (#17023), which skips
    // mobile, lean-chat, store, and provisioned-cloud shapes; the static
    // CORE/DEFERRED sets stay clean so those shapes never resolve it.
    expect(CORE_PLUGINS).not.toContain("@elizaos/plugin-google-workspace");
    expect(CORE_PLUGINS).not.toContain("@elizaos/plugin-personal-assistant");
    expect(DEFERRED_CORE_PLUGINS).not.toContain(
      "@elizaos/plugin-google-workspace",
    );
    expect(DEFERRED_CORE_PLUGINS).not.toContain(
      "@elizaos/plugin-personal-assistant",
    );
  });

  it("exposes plugin-google-workspace and plugin-personal-assistant as optional, explicitly-enabled plugins", () => {
    expect(OPTIONAL_CORE_PLUGINS).toContain("@elizaos/plugin-google-workspace");
    expect(OPTIONAL_CORE_PLUGINS).toContain(
      "@elizaos/plugin-personal-assistant",
    );
  });
});
