// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_GROUPS } from "./LifeOpsNavRail.js";

vi.mock("@elizaos/ui", () => ({
  Sidebar: ({ children }: { children: ReactNode }) => (
    <nav>{children}</nav>
  ),
  SidebarContent: {
    RailItem: ({ children }: { children: ReactNode }) => (
      <button type="button">{children}</button>
    ),
  },
  SidebarPanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarScrollRegion: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipHint: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  Sidebar: ({ children }: { children: ReactNode }) => <nav>{children}</nav>,
  SidebarContent: {
    RailItem: ({ children }: { children: ReactNode }) => (
      <button type="button">{children}</button>
    ),
  },
  SidebarPanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarScrollRegion: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipHint: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
}));

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

import { LifeOpsNavRail } from "./LifeOpsNavRail.js";

afterEach(() => {
  cleanup();
});

describe("LifeOpsNavRail", () => {
  it("keeps health plugin pages out of primary LifeOps navigation", () => {
    const labels = NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => item.label),
    );

    expect(labels).toContain("Assistant");
    expect(labels).toContain("Overview");
    expect(labels).not.toContain("Sleep");
    expect(labels).not.toContain("Screen Time");
  });

  it("renders assistant and personal-ops destinations", () => {
    render(
      <LifeOpsNavRail
        activeSection="assistant"
        onNavigate={() => undefined}
        collapsible={false}
      />,
    );

    for (const label of [
      "Assistant",
      "Overview",
      "Messages",
      "Mail",
      "Calendar",
      "Reminders",
      "Money",
      "Documents",
      "Settings",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("keeps compact mode icon-led while preserving accessible destinations", () => {
    const { container } = render(
      <LifeOpsNavRail
        activeSection="assistant"
        onNavigate={() => undefined}
        collapsible={false}
        labelMode="active"
      />,
    );

    expect(screen.getByRole("button", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Overview" })).toBeTruthy();
    expect(container.textContent).toContain("Assistant");
    expect(container.textContent).not.toContain("Overview");
    expect(container.textContent).not.toContain("Calendar");
    expect(container.textContent).not.toContain("Settings");
  });
});
