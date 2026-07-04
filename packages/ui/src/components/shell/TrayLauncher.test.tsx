// @vitest-environment jsdom
//
// TrayLauncher: one row per desktop launcher entry, and a click dispatches
// TRAY_ACTION_EVENT with that row's itemId (the shared tray-handling path).
// Deterministic jsdom render via testing-library — no desktop bridge, no runtime.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRAY_ACTION_EVENT } from "../../events";
import type { DesktopLauncherEntry } from "../../state/desktop-tray-launcher";
import { setDesktopLauncherEntries } from "../../state/desktop-tray-launcher";
import { TrayLauncher } from "./TrayLauncher";

const ENTRIES: DesktopLauncherEntry[] = [
  { itemId: "tray-show-window", label: "Open Eliza", icon: "home" },
  { itemId: "tray-open-view-chat", label: "Messages", icon: "chat" },
  { itemId: "tray-open-view-settings", label: "Settings", icon: "settings" },
];

afterEach(() => {
  cleanup();
  setDesktopLauncherEntries([]);
});

describe("TrayLauncher", () => {
  it("renders a row per entry with its label", () => {
    render(<TrayLauncher entries={ENTRIES} />);
    expect(screen.getByText("Open Eliza")).toBeTruthy();
    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("dispatches TRAY_ACTION_EVENT with the row's item id on click (shared tray handling)", async () => {
    const events: string[] = [];
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ itemId?: string }>).detail;
      if (detail?.itemId) events.push(detail.itemId);
    };
    document.addEventListener(TRAY_ACTION_EVENT, onEvent);
    try {
      render(<TrayLauncher entries={ENTRIES} />);
      await userEvent.click(
        screen.getByTestId("tray-launcher-row-tray-open-view-chat"),
      );
      await userEvent.click(
        screen.getByTestId("tray-launcher-row-tray-show-window"),
      );
    } finally {
      document.removeEventListener(TRAY_ACTION_EVENT, onEvent);
    }
    expect(events).toEqual(["tray-open-view-chat", "tray-show-window"]);
  });

  it("prefers an explicit onSelect handler over dispatching", async () => {
    const onSelect = vi.fn();
    render(<TrayLauncher entries={ENTRIES} onSelect={onSelect} />);
    await userEvent.click(
      screen.getByTestId("tray-launcher-row-tray-open-view-settings"),
    );
    expect(onSelect).toHaveBeenCalledWith("tray-open-view-settings");
  });

  it("reads the registered catalog when no entries prop is given", () => {
    setDesktopLauncherEntries([
      { itemId: "tray-open-view-help", label: "Help", icon: "help" },
    ]);
    render(<TrayLauncher />);
    expect(screen.getByText("Help")).toBeTruthy();
  });

  it("renders nothing when there are no rows", () => {
    const { container } = render(<TrayLauncher entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
