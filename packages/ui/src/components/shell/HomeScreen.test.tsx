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
// Don't run real intervals (clock tick / inbox poll) in tests.
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: vi.fn(),
  useDocumentVisibility: () => true,
}));

import { HomeScreen } from "./HomeScreen";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("HomeScreen", () => {
  it("renders the clock, activity (when present), messages, and pinned tiles", async () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.getByTestId("home-clock")).toBeTruthy();
    // Activity card shows because the mock has events.
    expect(screen.getByTestId("home-widget-activity")).toBeTruthy();
    expect(screen.getByText("Finished the build")).toBeTruthy();
    // Messages card appears once the (async) inbox fetch resolves with a chat.
    expect(await screen.findByTestId("home-widget-messages")).toBeTruthy();
    // The 6 non-native tiles always show.
    for (const id of [
      "settings",
      "orchestrator",
      "workflows",
      "views",
      "inbox",
      "messages",
    ]) {
      expect(screen.getByTestId(`home-tile-${id}`)).toBeTruthy();
    }
  });

  it("hides phone + contacts tiles unless native-OS tiles are enabled", () => {
    const { rerender } = render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-tile-phone")).toBeNull();
    expect(screen.queryByTestId("home-tile-contacts")).toBeNull();
    rerender(<HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />);
    expect(screen.getByTestId("home-tile-phone")).toBeTruthy();
    expect(screen.getByTestId("home-tile-contacts")).toBeTruthy();
  });

  it("opens a builtin-tab tile and a view tile with the right target", () => {
    const onOpenTile = vi.fn();
    render(<HomeScreen onOpenTile={onOpenTile} />);
    fireEvent.click(screen.getByTestId("home-tile-settings"));
    expect(onOpenTile).toHaveBeenCalledWith({ kind: "tab", tab: "settings" });
    fireEvent.click(screen.getByTestId("home-tile-orchestrator"));
    expect(onOpenTile).toHaveBeenCalledWith({
      kind: "view",
      path: "/orchestrator",
    });
  });

  it("has no Edit button or Pinned label (clean, action-driven dashboard)", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(screen.queryByTestId("home-edit-toggle")).toBeNull();
    expect(screen.queryByText("Pinned")).toBeNull();
  });
});
