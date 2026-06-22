import { describe, expect, it } from "vitest";

import { createAppDefenseOfTheAgentsPlugin } from "../src/index.ts";

describe("appDefenseOfTheAgentsPlugin manifest", () => {
  it("registers ONE defense view drawing all three modalities", () => {
    const plugin = createAppDefenseOfTheAgentsPlugin();

    // Single source of truth: one declaration, modalities ["gui","xr","tui"],
    // the unified DefenseAgentsView spatial component.
    const views = plugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("defense-of-the-agents");
    expect(view.path).toBe("/defense-of-the-agents");
    expect(view.componentExport).toBe("DefenseAgentsView");
    expect(view.modalities).toEqual(["gui", "xr", "tui"]);
    expect(view.bundlePath).toBe("dist/views/bundle.js");
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
  });

  it("keeps the game app metadata intact", () => {
    const plugin = createAppDefenseOfTheAgentsPlugin();
    expect(plugin.app?.category).toBe("game");
    expect(plugin.app?.runtimePlugin).toBe(
      "@elizaos/plugin-defense-of-the-agents",
    );
  });
});
