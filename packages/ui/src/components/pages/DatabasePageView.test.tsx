// @vitest-environment jsdom
//
// Behavioral coverage for DatabasePageView (#10719). This is the thin tab-router
// for the Database surface — zero coverage before this. It reads
// `databaseSubTab` from app state and routes to the right heavy sub-view
// (Tables / Media / Vectors), and its SegmentedControl must drive
// setState("databaseSubTab", …). The tests mock the heavy children so a routing
// regression (wrong child for a subtab, wrong vectors bundle url, or a tab click
// that doesn't persist) fails here.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  value: {
    t: (key: string) =>
      (
        ({
          "databaseview.Tables": "Tables",
          "mediagalleryview.Media": "Media",
          "common.vectors": "Vectors",
          "aria.databaseViews": "Database views",
        }) as Record<string, string>
      )[key] ?? key,
    databaseSubTab: "tables" as "tables" | "media" | "vectors",
    setState: vi.fn(),
  },
}));

vi.mock("../../state", () => ({
  // Selector-based, mirroring the real useAppSelector((s) => s.x).
  useAppSelector: <T,>(selector: (s: typeof store.value) => T): T =>
    selector(store.value),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-surface">{children}</div>
  ),
}));

// The sub-views receive the shared `leftNav` (which holds the SegmentedControl
// tab switcher); render it so the tab UI is present to drive.
vi.mock("./DatabaseView", () => ({
  DatabaseView: ({ leftNav }: { leftNav?: React.ReactNode }) => (
    <div data-testid="stub-tables">{leftNav}</div>
  ),
}));
vi.mock("./MediaGalleryView", () => ({
  MediaGalleryView: ({ leftNav }: { leftNav?: React.ReactNode }) => (
    <div data-testid="stub-media">{leftNav}</div>
  ),
}));
vi.mock("../views/DynamicViewLoader", () => ({
  DynamicViewLoader: ({
    bundleUrl,
    viewProps,
  }: {
    bundleUrl: string;
    viewProps?: { leftNav?: React.ReactNode };
  }) => (
    <div data-testid="stub-vectors" data-bundle={bundleUrl}>
      {viewProps?.leftNav}
    </div>
  ),
}));

import { DatabasePageView } from "./DatabasePageView";

beforeEach(() => {
  store.value.databaseSubTab = "tables";
  store.value.setState = vi.fn();
});
afterEach(cleanup);

describe("DatabasePageView routing", () => {
  it("renders the Tables sub-view by default and not the others", () => {
    render(<DatabasePageView />);
    expect(screen.getByTestId("stub-tables")).toBeTruthy();
    expect(screen.queryByTestId("stub-media")).toBeNull();
    expect(screen.queryByTestId("stub-vectors")).toBeNull();
  });

  it("routes databaseSubTab='media' to the media gallery, not tables", () => {
    store.value.databaseSubTab = "media";
    render(<DatabasePageView />);
    expect(screen.getByTestId("stub-media")).toBeTruthy();
    expect(screen.queryByTestId("stub-tables")).toBeNull();
  });

  it("routes databaseSubTab='vectors' to the DynamicViewLoader with the vector bundle url", () => {
    store.value.databaseSubTab = "vectors";
    render(<DatabasePageView />);
    const vectors = screen.getByTestId("stub-vectors");
    expect(vectors).toBeTruthy();
    // The heavy three.js browser is loaded from its own plugin bundle, not the
    // always-loaded Database chunk — a wrong/missing url would break lazy loading.
    expect(vectors.getAttribute("data-bundle")).toBe(
      "/api/views/vector-browser/bundle.js",
    );
    expect(screen.queryByTestId("stub-tables")).toBeNull();
  });

  // The SegmentedControl renders one <button> per tab; the parent role="tablist"
  // trips getByRole("button"), so resolve the button via its label text.
  const tabButton = (label: string): HTMLButtonElement => {
    const el = screen.getByText(label).closest("button");
    if (!el) throw new Error(`no tab button for ${label}`);
    return el as HTMLButtonElement;
  };

  it("clicking a segmented tab persists the selection via setState('databaseSubTab', …)", () => {
    render(<DatabasePageView />);
    fireEvent.click(tabButton("Media"));
    expect(store.value.setState).toHaveBeenCalledWith("databaseSubTab", "media");

    fireEvent.click(tabButton("Vectors"));
    expect(store.value.setState).toHaveBeenCalledWith("databaseSubTab", "vectors");
    // Each click sends the exact tab id, so a mis-wired handler (hardcoded value /
    // wrong id) fails here — it never persists the current 'tables' by accident.
    expect(store.value.setState).not.toHaveBeenCalledWith(
      "databaseSubTab",
      "tables",
    );
  });

  it("marks the active tab pressed and the others not", () => {
    store.value.databaseSubTab = "media";
    render(<DatabasePageView />);
    expect(tabButton("Media").getAttribute("aria-pressed")).toBe("true");
    expect(tabButton("Tables").getAttribute("aria-pressed")).toBe("false");
  });
});
