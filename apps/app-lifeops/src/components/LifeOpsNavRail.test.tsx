// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/app-core", () => ({
  TooltipHint: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@elizaos/ui", () => ({
  Sidebar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarContent: {
    RailItem: ({
      children,
      onClick,
      ...props
    }: {
      children: ReactNode;
      onClick?: () => void;
    }) => (
      <button type="button" onClick={onClick} {...props}>
        {children}
      </button>
    ),
  },
  SidebarPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarScrollRegion: ({
    children,
  }: {
    children: ReactNode;
  }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

import { LifeOpsNavRail } from "./LifeOpsNavRail";

describe("LifeOpsNavRail", () => {
  it("renders sidebar items and routes item presses", () => {
    const onNavigate = vi.fn();

    render(<LifeOpsNavRail activeSection="overview" onNavigate={onNavigate} />);

    expect(screen.getByRole("button", { name: "Reminders" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Screen Time" }));

    expect(onNavigate).toHaveBeenCalledWith("screen-time");
  });
});
