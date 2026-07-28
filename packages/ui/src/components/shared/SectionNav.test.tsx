// @vitest-environment jsdom

/**
 * jsdom tests for the generalized `SectionNav` primitive and `isSectionPath`
 * predicate (#13586). Exercises the real app-shell page registry to confirm:
 *  - one ghost tab per registered group page, sorted by order → label → id,
 *  - active-tab marking from `activePath` (incl. path rewrites/aliases),
 *  - a single-member section renders NO strip (one tab is not a nav),
 *  - `isSectionPath` matches the section's tabs + aliases and rejects others.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentSurfaceProvider,
  getViewRegistry,
  handleAgentSurfaceCapability,
} from "../../agent-surface";
import { registerAppShellPage } from "../../app-shell-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import {
  isSectionPath,
  SectionNav,
  type SectionPathRewrite,
  SectionTabStrip,
} from "./SectionNav";

const GROUP = "wallet";

/** Rewrite the inventory root to a canonical `/wallet` path with an alias. */
const rootRewrite: SectionPathRewrite = (registration) => {
  if (registration.path === "/inventory") {
    return {
      id: registration.id,
      label: registration.label,
      path: "/wallet",
      aliases: ["/inventory"],
    };
  }
  return null;
};

function registerPages(): void {
  registerAppShellPage({
    id: "test.wallet",
    pluginId: "test-wallet",
    label: "Wallet",
    path: "/inventory",
    group: GROUP,
    order: 10,
    loader: async () => ({ default: () => null }),
  });
  registerAppShellPage({
    id: "test.perps",
    pluginId: "test-perps",
    label: "Perps",
    path: "/perps",
    group: GROUP,
    order: 20,
    loader: async () => ({ default: () => null }),
  });
  registerAppShellPage({
    id: "test.predictions",
    pluginId: "test-predictions",
    label: "Predictions",
    path: "/predictions",
    group: GROUP,
    order: 30,
    loader: async () => ({ default: () => null }),
  });
}

beforeEach(() => {
  resetUiRegistryHostForTests();
  registerPages();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  resetUiRegistryHostForTests();
});

describe("isSectionPath", () => {
  it("matches the section's tab + alias routes", () => {
    for (const path of [
      "/wallet",
      "/inventory",
      "/perps",
      "/predictions",
      "/perps?tab=positions",
    ]) {
      expect(isSectionPath(GROUP, path, rootRewrite)).toBe(true);
    }
  });

  it("rejects routes outside the section", () => {
    for (const path of ["/browser", "/automations", "/apps/logs", "/"]) {
      expect(isSectionPath(GROUP, path, rootRewrite)).toBe(false);
    }
  });

  it("stops matching a member once its registration is absent", () => {
    resetUiRegistryHostForTests();
    registerAppShellPage({
      id: "test.wallet",
      pluginId: "test-wallet",
      label: "Wallet",
      path: "/inventory",
      group: GROUP,
      order: 10,
      loader: async () => ({ default: () => null }),
    });
    registerAppShellPage({
      id: "test.perps",
      pluginId: "test-perps",
      label: "Perps",
      path: "/perps",
      group: GROUP,
      order: 20,
      loader: async () => ({ default: () => null }),
    });
    // /predictions is no longer registered → not part of the section.
    expect(isSectionPath(GROUP, "/predictions", rootRewrite)).toBe(false);
    expect(isSectionPath(GROUP, "/perps", rootRewrite)).toBe(true);
  });
});

describe("SectionNav", () => {
  it("renders one ghost tab per group page, sorted by order", () => {
    render(
      <SectionNav group={GROUP} activePath="/wallet" rewrite={rootRewrite} />,
    );
    const nav = screen.getByTestId(`section-nav-${GROUP}`);
    const labels = Array.from(nav.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(["Wallet", "Perps", "Predictions"]);
  });

  it("marks the active tab from activePath (alias resolves to root)", () => {
    render(
      <SectionNav
        group={GROUP}
        activePath="/inventory"
        rewrite={rootRewrite}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Wallet" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "Perps" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("navigates to the tab route on click", () => {
    render(
      <SectionNav group={GROUP} activePath="/wallet" rewrite={rootRewrite} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Predictions" }));
    expect(window.location.pathname).toBe("/predictions");
  });

  it("does not renavigate when the active tab is clicked", () => {
    window.history.replaceState(null, "", "/perps");
    render(
      <SectionNav group={GROUP} activePath="/perps" rewrite={rootRewrite} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Perps" }));
    expect(window.location.pathname).toBe("/perps");
  });

  it("renders no strip when the section has a single member", () => {
    resetUiRegistryHostForTests();
    registerAppShellPage({
      id: "test.only",
      pluginId: "test-only",
      label: "Solo",
      path: "/solo",
      group: GROUP,
      order: 10,
      loader: async () => ({ default: () => null }),
    });
    const { container } = render(
      <SectionNav group={GROUP} activePath="/solo" />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId(`section-nav-${GROUP}`)).toBeNull();
  });

  it("renders no strip for an empty section", () => {
    resetUiRegistryHostForTests();
    const { container } = render(
      <SectionNav group="nonexistent" activePath="/x" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("SectionTabStrip agent surface", () => {
  it("registers scope tabs and activates them through the live bridge", () => {
    function ScopeFixture() {
      const [activeId, setActiveId] = useState("all");
      return (
        <AgentSurfaceProvider viewId="documents" viewType="gui">
          <SectionTabStrip
            entries={[
              { id: "all", label: "All", agentLabel: "All knowledge" },
              {
                id: "shared",
                label: "Shared",
                agentLabel: "Shared knowledge",
              },
            ]}
            activeId={activeId}
            onSelect={setActiveId}
            ariaLabel="Knowledge scope"
            agentIdPrefix="scope"
          />
        </AgentSurfaceProvider>
      );
    }

    render(<ScopeFixture />);
    const registry = getViewRegistry("documents", "gui");
    if (!registry) throw new Error("documents registry missing");

    const elements = handleAgentSurfaceCapability(
      registry,
      "list-elements",
      undefined,
    ) as Array<{ id: string; role: string; status?: string }>;
    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "scope-all",
          role: "tab",
          status: "active",
        }),
        expect.objectContaining({
          id: "scope-shared",
          role: "tab",
          status: "inactive",
        }),
      ]),
    );

    act(() => {
      handleAgentSurfaceCapability(registry, "agent-click", {
        id: "scope-shared",
      });
    });
    expect(
      screen
        .getByRole("button", { name: "Shared" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
