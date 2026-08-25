import { describe, expect, it } from "vitest";

import * as blockerExports from "../src/index.ts";
import { blockerPlugin } from "../src/plugin.ts";

describe("blockerPlugin manifest", () => {
  it("keeps BLOCK host-adapted by personal-assistant", () => {
    expect(blockerPlugin.actions ?? []).toEqual([]);
    expect("blockAction" in blockerExports).toBe(false);
  });

  it("registers the focus view plus blocker providers and services", () => {
    expect(blockerPlugin.views?.map((view) => view.id)).toEqual(["focus"]);
    expect(blockerPlugin.providers?.map((provider) => provider.name)).toEqual([
      "websiteBlocker",
      "appBlocker",
    ]);
    expect(
      blockerPlugin.services?.map((service) => service.serviceType),
    ).toEqual(["website_blocker", "app-blocker"]);
  });
});
