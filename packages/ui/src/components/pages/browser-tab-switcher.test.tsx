// @vitest-environment jsdom

/**
 * Folded browser tab switcher (#13596). Covers the two contracts the redesign
 * turns on: the pure `foldBrowserTabs` model (grouping, count, active
 * resolution) and the real rendered switcher/control — many-tabs fold, active
 * tab always visible, agent-tab distinction, open/select/close wiring, and the
 * ≥44px touch targets the mobile pass requires. Radix Dialog mounts for real in
 * jsdom; `useAgentElement` is stubbed to a passthrough so the tests exercise the
 * component's own markup, not the agent-surface registry.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import {
  type BrowserSwitcherSection,
  type BrowserSwitcherTab,
  BrowserTabFoldControl,
  BrowserTabSwitcher,
  foldBrowserTabs,
} from "./BrowserTabSwitcher";

afterEach(() => {
  cleanup();
});

const SECTION_LABELS: Record<BrowserSwitcherSection, string> = {
  user: "User Tabs",
  agent: "Agent Tabs",
  app: "App Tabs",
};

function tab(
  overrides: Partial<BrowserSwitcherTab> & { id: string },
): BrowserSwitcherTab {
  return {
    label: overrides.id,
    description: `https://${overrides.id}.example`,
    monogram: overrides.id[0]?.toUpperCase() ?? "B",
    section: "user",
    closable: true,
    hasSessionFocus: false,
    ...overrides,
  };
}

/** 12 tabs spread across all three sections — the "many tabs" fold case. */
function manyTabs(): BrowserSwitcherTab[] {
  const tabs: BrowserSwitcherTab[] = [];
  for (let i = 0; i < 8; i += 1)
    tabs.push(tab({ id: `user-${i}`, section: "user" }));
  for (let i = 0; i < 3; i += 1)
    tabs.push(tab({ id: `agent-${i}`, section: "agent" }));
  tabs.push(tab({ id: "app-0", section: "app", closable: false }));
  return tabs;
}

describe("foldBrowserTabs", () => {
  it("groups tabs by section in user → agent → app order and counts all", () => {
    const folded = foldBrowserTabs(manyTabs(), "user-3", SECTION_LABELS);
    expect(folded.count).toBe(12);
    expect(folded.sections.map((s) => s.key)).toEqual(["user", "agent", "app"]);
    expect(folded.sections[0]?.tabs).toHaveLength(8);
    expect(folded.sections[1]?.tabs).toHaveLength(3);
    expect(folded.sections[2]?.tabs).toHaveLength(1);
  });

  it("resolves the active tab so it is never folded out of reach", () => {
    const folded = foldBrowserTabs(manyTabs(), "agent-2", SECTION_LABELS);
    expect(folded.activeTab?.id).toBe("agent-2");
    // The active tab is still present in its section group.
    const agentGroup = folded.sections.find((s) => s.key === "agent");
    expect(agentGroup?.tabs.some((t) => t.id === "agent-2")).toBe(true);
  });

  it("omits empty sections and reports no active tab for an unknown id", () => {
    const folded = foldBrowserTabs(
      [tab({ id: "only", section: "user" })],
      "does-not-exist",
      SECTION_LABELS,
    );
    expect(folded.sections.map((s) => s.key)).toEqual(["user"]);
    expect(folded.activeTab).toBeNull();
  });

  it("folds a single tab without error (count 1, active resolved)", () => {
    const folded = foldBrowserTabs(
      [tab({ id: "solo", label: "DuckDuckGo", section: "user" })],
      "solo",
      SECTION_LABELS,
    );
    expect(folded.count).toBe(1);
    expect(folded.activeTab?.label).toBe("DuckDuckGo");
  });
});

describe("BrowserTabFoldControl", () => {
  it("shows the active label + total count and opens on click", () => {
    const onOpen = vi.fn();
    render(
      <BrowserTabFoldControl
        activeLabel="DuckDuckGo"
        count={12}
        openLabel="Show 12 tabs"
        onOpen={onOpen}
      />,
    );
    const control = screen.getByTestId("browser-workspace-tab-fold-control");
    expect(control.textContent).toContain("DuckDuckGo");
    expect(
      screen.getByTestId("browser-workspace-tab-count").textContent,
    ).toContain("12");
    fireEvent.click(control);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is a ≥44px touch target (min-h-11)", () => {
    render(
      <BrowserTabFoldControl
        activeLabel="Tab"
        count={1}
        openLabel="Show 1 tab"
        onOpen={vi.fn()}
      />,
    );
    const control = screen.getByTestId("browser-workspace-tab-fold-control");
    expect(control.className).toContain("min-h-11");
    expect(control.className).toContain("h-11");
  });
});

describe("BrowserTabSwitcher", () => {
  function renderSwitcher(
    props: Partial<ComponentProps<typeof BrowserTabSwitcher>> = {},
  ) {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    const onNewTab = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <BrowserTabSwitcher
        open
        onOpenChange={onOpenChange}
        folded={foldBrowserTabs(manyTabs(), "user-3", SECTION_LABELS)}
        activeTabId="user-3"
        title="Tabs"
        closeLabel="Close tab"
        agentActiveLabel="Agent is on this tab"
        newTabLabel="New tab"
        emptyLabel="No tabs open yet"
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        {...props}
      />,
    );
    return { onActivateTab, onCloseTab, onNewTab, onOpenChange };
  }

  it("renders a card per tab with its title, across all sections", () => {
    renderSwitcher();
    const dialog = screen.getByTestId("browser-workspace-tab-switcher");
    // 12 tab cards present (8 user + 3 agent + 1 app).
    for (const id of ["user-0", "user-7", "agent-0", "agent-2", "app-0"]) {
      expect(within(dialog).getByTestId(`browser-tab-card-${id}`)).toBeTruthy();
    }
    // Section headers render.
    expect(
      within(dialog).getByRole("tablist", { name: "User Tabs" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("tablist", { name: "Agent Tabs" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("tablist", { name: "App Tabs" }),
    ).toBeTruthy();
  });

  it("keeps the active tab visible and marked aria-selected", () => {
    renderSwitcher();
    const activeCard = screen.getByTestId("browser-tab-card-user-3");
    const activeTab = within(activeCard).getByRole("tab");
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    expect(activeTab.getAttribute("aria-current")).toBe("page");
  });

  it("selecting a tab activates it and closes the switcher", () => {
    const { onActivateTab, onOpenChange } = renderSwitcher();
    const card = screen.getByTestId("browser-tab-card-agent-1");
    fireEvent.click(within(card).getByRole("tab"));
    expect(onActivateTab).toHaveBeenCalledWith("agent-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closing a tab fires onCloseTab and does NOT close the switcher", () => {
    const { onCloseTab, onOpenChange } = renderSwitcher();
    const closeBtn = screen.getByTestId("browser-tab-card-close-user-2");
    fireEvent.click(closeBtn);
    expect(onCloseTab).toHaveBeenCalledWith("user-2");
    // Close stays in the switcher so the user can close several in a row.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("renders no close affordance for internal (non-closable) tabs", () => {
    renderSwitcher();
    expect(screen.queryByTestId("browser-tab-card-close-app-0")).toBeNull();
  });

  it("distinguishes agent-session tabs with an accent monogram", () => {
    renderSwitcher();
    const agentCard = screen.getByTestId("browser-tab-card-agent-0");
    const userCard = screen.getByTestId("browser-tab-card-user-0");
    // Agent tabs carry the accent tint; user tabs use the neutral muted tint.
    expect(agentCard.innerHTML).toContain("text-accent");
    expect(userCard.innerHTML).not.toContain("bg-accent/15");
  });

  it("shows an accent session dot (not the monogram) for the focused tab", () => {
    render(
      <BrowserTabSwitcher
        open
        onOpenChange={vi.fn()}
        folded={foldBrowserTabs(
          [tab({ id: "focused", section: "user", hasSessionFocus: true })],
          "focused",
          SECTION_LABELS,
        )}
        activeTabId="focused"
        title="Tabs"
        closeLabel="Close tab"
        agentActiveLabel="Agent is on this tab"
        newTabLabel="New tab"
        emptyLabel="No tabs open yet"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    const card = screen.getByTestId("browser-tab-card-focused");
    expect(within(card).getByText("Agent is on this tab")).toBeTruthy();
  });

  it('"new tab" opens a tab and closes the switcher', () => {
    const { onNewTab, onOpenChange } = renderSwitcher();
    fireEvent.click(
      screen.getByTestId("browser-workspace-tab-switcher-new-tab"),
    );
    expect(onNewTab).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders a designed empty state when there are no tabs", () => {
    renderSwitcher({
      folded: foldBrowserTabs([], null, SECTION_LABELS),
    });
    const dialog = screen.getByTestId("browser-workspace-tab-switcher");
    expect(within(dialog).getByText("No tabs open yet")).toBeTruthy();
  });

  it("tab cards and close buttons are ≥44px / ≥36px touch targets", () => {
    renderSwitcher();
    const card = screen.getByTestId("browser-tab-card-user-0");
    const activateTarget = within(card).getByRole("tab");
    // min-h-11 = 2.75rem = 44px activate surface.
    expect(activateTarget.className).toContain("min-h-11");
    const closeBtn = screen.getByTestId("browser-tab-card-close-user-0");
    // h-9 = 2.25rem = 36px close hit-area inside the card corner.
    expect(closeBtn.className).toContain("h-9");
    expect(closeBtn.className).toContain("w-9");
  });
});
