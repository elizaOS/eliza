import { describe, expect, it } from "vitest";

import { createAppClawvillePlugin } from "../src/index.ts";

describe("appClawvillePlugin manifest", () => {
  it("registers ONE clawville view drawing all three modalities", () => {
    const plugin = createAppClawvillePlugin();

    // Single source of truth: one declaration, modalities ["gui","xr","tui"],
    // the unified ClawvilleView spatial component.
    const views = plugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("clawville");
    expect(view.path).toBe("/clawville");
    expect(view.componentExport).toBe("ClawvilleView");
    expect(view.modalities).toEqual(["gui", "xr", "tui"]);
    expect(view.bundlePath).toBe("dist/views/bundle.js");
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
  });

  it("keeps the game app metadata intact", () => {
    const plugin = createAppClawvillePlugin();
    expect(plugin.app?.category).toBe("game");
    expect(plugin.app?.runtimePlugin).toBe("@elizaos/plugin-clawville");
  });
});
