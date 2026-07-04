// @vitest-environment jsdom

/**
 * Behaviour coverage for DesktopTabBar: real render in jsdom with the Electrobun
 * runtime guard mocked on, driving tab switch/close and the view-manager trigger
 * through the actual buttons.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopTab } from "../../hooks/useDesktopTabs";
import { DesktopTabBar } from "./DesktopTabBar";

const runtimeMock = vi.hoisted(() => ({
  isElectrobunRuntime: vi.fn(),
}));

vi.mock("../../bridge/electrobun-runtime", () => runtimeMock);

const tabs: DesktopTab[] = [
  {
    viewId: "local.notes",
    label: "Local Notes",
    path: "/apps/local-notes",
    icon: "N",
    pinned: true,
  },
  {
    viewId: "remote.ledger",
    label: "Remote Ledger",
    path: "/apps/remote-ledger",
    icon: "R",
    pinned: false,
  },
];

describe("DesktopTabBar", () => {
  beforeEach(() => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("switches views, closes a tab, and opens Launcher through real tab buttons", () => {
    const onTabClick = vi.fn();
    const onTabClose = vi.fn();
    const onOpenViewManager = vi.fn();

    render(
      <DesktopTabBar
        tabs={tabs}
        activeViewId="remote.ledger"
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        onOpenViewManager={onOpenViewManager}
      />,
    );

    expect(
      screen.getByRole("tablist", { name: "Desktop view tabs" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Local Notes" }));
    expect(onTabClick).toHaveBeenCalledWith("local.notes");

    fireEvent.click(
      screen.getByRole("button", { name: "Close Remote Ledger" }),
    );
    expect(onTabClose).toHaveBeenCalledWith("remote.ledger");
    expect(onTabClick).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Launcher",
      }),
    );
    expect(onOpenViewManager).toHaveBeenCalledTimes(1);
  });

  it("does not render outside the Electrobun runtime", () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(false);

    render(
      <DesktopTabBar
        tabs={tabs}
        activeViewId="remote.ledger"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onOpenViewManager={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
