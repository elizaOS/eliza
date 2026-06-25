import { describe, expect, it } from "vitest";

import { simpleViewsPlugin } from "./plugin.js";

describe("simple views plugin descriptor", () => {
  it("declares developer-only notes and simple-calendar views", () => {
    expect(simpleViewsPlugin.views?.map((view) => view.id)).toEqual([
      "notes",
      "simple-calendar",
    ]);

    for (const view of simpleViewsPlugin.views ?? []) {
      expect(view.viewKind).toBe("developer");
      expect(view.modalities).toEqual(["gui", "xr"]);
      expect(view.bundlePath).toBe("dist/views/bundle.js");
      expect(view.visibleInManager).toBe(true);
      expect(view.desktopTabEnabled).toBe(true);
      expect(view.serverInteract).toBeTypeOf("function");
    }
  });

  it("keeps simple calendar separate from the production calendar view id", () => {
    const paths = new Set(simpleViewsPlugin.views?.map((view) => view.path));
    const ids = new Set(simpleViewsPlugin.views?.map((view) => view.id));

    expect(ids.has("calendar")).toBe(false);
    expect(paths.has("/calendar")).toBe(false);
    expect(ids.has("simple-calendar")).toBe(true);
    expect(paths.has("/simple-calendar")).toBe(true);
  });
});
