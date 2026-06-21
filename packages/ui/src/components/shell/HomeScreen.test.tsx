// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the live data sources so the home renders deterministically.
vi.mock("../../hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({
    events: [
      {
        id: "e1",
        timestamp: Date.now() - 5000,
        eventType: "task_complete",
        summary: "Finished the build",
      },
      {
        id: "e2",
        timestamp: Date.now() - 60000,
        eventType: "tool_running",
        summary: "Running tests",
      },
    ],
    clearEvents: vi.fn(),
  }),
}));
vi.mock("../../api", () => ({
  client: {
    getInboxChats: vi.fn().mockResolvedValue({
      chats: [
        {
          id: "c1",
          source: "imessage",
          worldLabel: "iMessage",
          title: "Alex",
          lastMessageText: "see you at 5",
          lastMessageAt: Date.now() - 120000,
          messageCount: 3,
        },
      ],
      count: 1,
    }),
  },
}));
// The registered-view set drives which view-kind tiles render. Mutable so a
// test can simulate a build where a view isn't registered.
let mockViews: { id: string; path: string }[] = [
  { id: "orchestrator", path: "/orchestrator" },
  { id: "automations", path: "/automations" },
  { id: "inbox", path: "/inbox" },
];
vi.mock("../../hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({ views: mockViews, loading: false }),
}));
// Don't run real intervals (clock tick / inbox poll) in tests.
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: vi.fn(),
  useDocumentVisibility: () => true,
}));

import { HomeScreen } from "./HomeScreen";

afterEach(() => {
  cleanup();
  localStorage.clear();
  mockViews = [
    { id: "orchestrator", path: "/orchestrator" },
    { id: "automations", path: "/automations" },
    { id: "inbox", path: "/inbox" },
  ];
});

const NATIVE_OS_TILES = ["messages", "phone", "contacts", "camera"];

function tileIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="home-tile-"]'),
  ).map((el) => el.dataset.testid?.replace("home-tile-", "") ?? "");
}

describe("HomeScreen", () => {
  it("is minimal: no clock, activity + messages when present, NO pinned tiles off-AOSP", async () => {
    const { container } = render(<HomeScreen onOpenTile={vi.fn()} />);
    // The clock/date was removed — the home stays simple.
    expect(screen.queryByTestId("home-clock")).toBeNull();
    // Activity card shows because the mock has events.
    expect(screen.getByTestId("home-widget-activity")).toBeTruthy();
    expect(screen.getByText("Finished the build")).toBeTruthy();
    // Messages card appears once the (async) inbox fetch resolves with a chat.
    expect(await screen.findByTestId("home-widget-messages")).toBeTruthy();
    // Off-AOSP: zero tiles — Home/Views/Settings live in the chat nav now, and
    // the tile grid is omitted entirely (not an empty section).
    expect(tileIds(container)).toEqual([]);
    expect(screen.queryByTestId("home-tiles")).toBeNull();
  });

  it("shows only the 4 native-OS tiles on the AOSP fork; none off-AOSP", () => {
    const { rerender, container } = render(<HomeScreen onOpenTile={vi.fn()} />);
    // Off-AOSP: no tiles at all (default tiles removed; native-OS hidden).
    for (const id of NATIVE_OS_TILES) {
      expect(screen.queryByTestId(`home-tile-${id}`)).toBeNull();
    }
    expect(tileIds(container)).toHaveLength(0);

    rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    // AOSP: exactly the four native-OS surfaces.
    expect(tileIds(container)).toEqual(NATIVE_OS_TILES);
  });

  it("opens an AOSP native-OS tile with the right target", () => {
    const onOpenTile = vi.fn();
    render(<HomeScreen onOpenTile={onOpenTile} showNativeOsTiles />);
    fireEvent.click(screen.getByTestId("home-tile-camera"));
    expect(onOpenTile).toHaveBeenCalledWith({ kind: "tab", tab: "camera" });
    fireEvent.click(screen.getByTestId("home-tile-phone"));
    expect(onOpenTile).toHaveBeenCalledWith({ kind: "tab", tab: "phone" });
  });

  it("has no Edit button or Pinned label (clean, action-driven dashboard)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-edit-toggle")).toBeNull();
    expect(screen.queryByText("Pinned")).toBeNull();
  });
});
