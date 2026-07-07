import { describe, expect, it } from "vitest";

import { screensharePlugin } from "./index";

describe("screensharePlugin manifest", () => {
  it("registers ONE screenshare GUI view", () => {
    // Single source of truth: one declaration, modalities ["gui"],
    // the unified ScreenshareView spatial component. No per-viewType duplicates.
    const views = screensharePlugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("screenshare");
    expect(view.path).toBe("/screenshare");
    expect(view.componentExport).toBe("ScreenshareView");
    expect(view.bundlePath).toBe("dist/views/bundle.js");
    expect(view.modalities).toEqual(["gui"]);
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
  });
});
