import { describe, expect, it, vi } from "vitest";

// `src/index.ts` is a plain view-manifest object that re-exports the pure
// proxy/data layers (`./routes`, `./ui/feed-data`). Stub the (heavy) app-core
// UI registries those paths can transitively reach so this stays a boot-free
// assertion on the view declaration shape.
vi.mock("@elizaos/app-core/ui-compat", () => ({
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
  it("registers ONE GUI feed view from the unified FeedView", () => {
    // Single source of truth: one GUI declaration, the unified FeedView
    // spatial component — no per-viewType duplicates.
    const views = feedPlugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("feed");
    expect(view.path).toBe("/feed");
    expect(view.componentExport).toBe("FeedView");
    expect(view.bundlePath).toBe("dist/views/bundle.js");
    expect(view.modalities).toEqual(["gui"]);
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
    // Manager-visible + desktop tab metadata carries over to the single view.
    expect(view.visibleInManager).toBe(true);
    expect(view.desktopTabEnabled).toBe(true);
    // Preview-gated: an early-stage, non-MVP operator surface, hidden from a
    // fresh user's launcher AND manager grid until the Preview toggle is on.
    // Declaring `system` here leaked it into the fresh-user manager grid while
    // the launcher hid it (the divergence #14356 closed).
    expect(view.viewKind).toBe("preview");
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
