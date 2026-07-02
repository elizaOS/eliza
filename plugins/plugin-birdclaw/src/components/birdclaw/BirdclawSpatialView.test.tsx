import { SpatialSurface } from "@elizaos/ui/spatial";
import { renderViewToLines } from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BIRDCLAW_TABS,
  type BirdclawSnapshot,
  BirdclawSpatialView,
  EMPTY_BIRDCLAW_SNAPSHOT,
} from "./BirdclawSpatialView.tsx";

function tabs(active = "home") {
  return BIRDCLAW_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    active: tab.id === active,
  }));
}

const ready: BirdclawSnapshot = {
  status: "ready",
  tabs: tabs("mentions"),
  rows: [
    {
      id: "m1",
      title: "@amelia",
      body: "curious how you decide when a local tool deserves a real sync engine.",
      meta: "mention · needs reply",
      time: "2026-03-08T11:48:00.000Z",
      accent: true,
    },
    {
      id: "t2",
      title: "@destraynor",
      body: "The best product teams prune scope.",
      meta: "♥382",
      time: "2026-03-08T11:18:00.000Z",
      accent: false,
    },
  ],
  transportText: "xurl not installed. local mode active.",
  syncing: false,
  canSync: false,
  nudge: "1 item still needs a reply.",
  error: null,
  setupHint: null,
};

function renderGui(snapshot: BirdclawSnapshot): string {
  return renderToStaticMarkup(
    <SpatialSurface modality="gui">
      <BirdclawSpatialView snapshot={snapshot} />
    </SpatialSurface>,
  );
}

describe("BirdclawSpatialView (GUI)", () => {
  it("renders rows, nudge, and transport in the ready state", () => {
    const html = renderGui(ready);
    expect(html).toContain("@amelia");
    expect(html).toContain("@destraynor");
    expect(html).toContain("1 item still needs a reply.");
    expect(html).toContain("xurl not installed. local mode active.");
    expect(html).toContain("2 items");
  });

  it("renders every tab chip", () => {
    const html = renderGui(ready);
    for (const tab of BIRDCLAW_TABS) {
      expect(html).toContain(tab.label);
    }
  });

  it("renders the setup state with install guidance", () => {
    const html = renderGui({
      ...EMPTY_BIRDCLAW_SNAPSHOT,
      status: "setup",
      setupHint: 'birdclaw is not installed (looked for "birdclaw").',
    });
    expect(html).toContain("Birdclaw is not set up yet");
    expect(html).toContain("brew install steipete/tap/birdclaw");
    expect(html).toContain("Check again");
  });

  it("renders the error state with a retry affordance", () => {
    const html = renderGui({
      ...EMPTY_BIRDCLAW_SNAPSHOT,
      status: "error",
      error: "database is locked",
    });
    // renderToStaticMarkup escapes the apostrophe, so match around it.
    expect(html).toContain("load the archive");
    expect(html).toContain("database is locked");
    expect(html).toContain("Retry");
  });

  it("renders the empty state", () => {
    const html = renderGui({
      ...ready,
      status: "empty",
      rows: [],
      nudge: null,
    });
    expect(html).toContain("Nothing here yet");
  });

  it("shows the sync button only when a transport can sync", () => {
    expect(renderGui(ready)).not.toContain(">Sync<");
    const syncable = renderGui({ ...ready, canSync: true });
    expect(syncable).toContain("Sync");
    const syncing = renderGui({ ...ready, canSync: true, syncing: true });
    expect(syncing).toContain("Syncing…");
  });
});

describe("BirdclawSpatialView (TUI)", () => {
  it("renders the same component to terminal lines", () => {
    const lines = renderViewToLines(
      <BirdclawSpatialView snapshot={ready} />,
      60,
    );
    const text = lines.join("\n");
    expect(text).toContain("@amelia");
    expect(text).toContain("Mentions");
  });
});
