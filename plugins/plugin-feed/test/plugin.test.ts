import { describe, expect, it, vi } from "vitest";

// `src/index.ts` pulls in `./ui/index.ts`, whose module side effects register
// the operator surface + detail extension against the (heavy) app-core/ui-compat
// React registries. The manifest itself is a plain object, so stub the UI
// registries to keep this a boot-free assertion on the view declaration shape.
vi.mock("@elizaos/app-core/ui-compat", () => ({
  registerOperatorSurface: () => {},
  registerDetailExtension: () => {},
  client: {},
  selectLatestRunForApp: () => ({ run: null, matchingRuns: [] }),
  SurfaceCard: () => null,
  SurfaceSection: () => null,
  formatDetailTimestamp: () => "",
}));
vi.mock("@elizaos/ui", () => ({
  Button: () => null,
}));
vi.mock("@elizaos/ui/state", () => ({
  useAppSelector: () => ({ appRuns: [] }),
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import feedPlugin from "../src/index.ts";

describe("feedPlugin manifest", () => {
  it("registers ONE feed view drawing all three modalities from the unified FeedView", () => {
    // Single source of truth: one declaration, modalities ["gui","xr","tui"],
    // the unified FeedView spatial component — no per-viewType duplicates.
    const views = feedPlugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("feed");
    expect(view.path).toBe("/feed");
    expect(view.componentExport).toBe("FeedView");
    expect(view.bundlePath).toBe("dist/views/bundle.js");
    expect(view.modalities).toEqual(["gui", "xr", "tui"]);
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
    // Manager-visible + desktop tab metadata carries over to the single view.
    expect(view.visibleInManager).toBe(true);
    expect(view.desktopTabEnabled).toBe(true);
  });

  it("carries the four terminal capability descriptors on the single declaration", () => {
    const [view] = feedPlugin.views ?? [];
    const capabilityIds = (view?.capabilities ?? []).map((cap) => cap.id);
    expect(capabilityIds).toEqual([
      "get-state",
      "refresh-agent-status",
      "open-live-dashboard",
      "send-team-message",
    ]);
  });
});
