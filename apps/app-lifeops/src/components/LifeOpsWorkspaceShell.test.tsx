// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

vi.mock("./LifeOpsNavRail.js", () => ({
  LifeOpsNavRail: ({
    activeSection,
    collapsible,
    onNavigate,
  }: {
    activeSection: string;
    collapsible?: boolean;
    onNavigate: (section: "mail") => void;
  }) => (
    <div data-testid="mock-lifeops-nav-rail" data-collapsible={String(collapsible)}>
      <span>{activeSection}</span>
      <button type="button" onClick={() => onNavigate("mail")}>
        Go Mail
      </button>
    </div>
  ),
}));

vi.mock("./LifeOpsResizableSidebar.js", () => ({
  LifeOpsResizableSidebar: ({
    children,
  }: {
    children: ReactNode;
  }) => <div data-testid="mock-lifeops-resizable">{children}</div>,
}));

import { LifeOpsWorkspaceShell } from "./LifeOpsWorkspaceShell";

describe("LifeOpsWorkspaceShell", () => {
  it("opens the mobile drawer from the top-left button and closes after navigation", () => {
    const navigate = vi.fn();

    render(
      <LifeOpsWorkspaceShell compactLayout section="overview" navigate={navigate}>
        <div>Overview content</div>
      </LifeOpsWorkspaceShell>,
    );

    expect(screen.queryByTestId("lifeops-mobile-nav-drawer")).toBeNull();

    fireEvent.click(screen.getByTestId("lifeops-workspace-nav-toggle"));

    expect(screen.getByTestId("lifeops-mobile-nav-drawer")).toBeTruthy();
    expect(
      screen.getByTestId("mock-lifeops-nav-rail").getAttribute("data-collapsible"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Go Mail" }));

    expect(navigate).toHaveBeenCalledWith("mail");
    expect(screen.queryByTestId("lifeops-mobile-nav-drawer")).toBeNull();
  });

  it("keeps the desktop sidebar mounted without the mobile toggle", () => {
    render(
      <LifeOpsWorkspaceShell
        compactLayout={false}
        section="overview"
        navigate={vi.fn()}
      >
        <div>Overview content</div>
      </LifeOpsWorkspaceShell>,
    );

    expect(screen.queryByTestId("lifeops-workspace-nav-toggle")).toBeNull();
    expect(screen.getByTestId("mock-lifeops-resizable")).toBeTruthy();
  });
});
