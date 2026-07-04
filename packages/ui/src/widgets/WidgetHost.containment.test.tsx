// @vitest-environment jsdom

/**
 * Layout-containment lock (#9304).
 *
 * When the home ranking reorders, the cards reshuffle. Without CSS containment a
 * reorder/resize inside the host can reflow the surrounding page (a layout jump).
 * `contain: layout` scopes layout work to the host so a reorder repaints within
 * the host and never jumps the page. This locks that the host carries it.
 *
 * Fails-when-broken: drop `style={{ contain: "layout" }}` from WidgetHost and
 * the assertion goes red.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginWidgetDeclaration } from "./types";
import { WidgetHost } from "./WidgetHost";

const mockAppState = {
  plugins: [{ id: "home-plugin", enabled: true, isActive: true }],
  t: (key: string) => key,
};

vi.mock("../state", () => ({
  useApp: () => mockAppState,
  useAppSelector: <T,>(selector: (s: typeof mockAppState) => T): T =>
    selector(mockAppState),
  useAppSelectorShallow: <T,>(selector: (s: typeof mockAppState) => T): T =>
    selector(mockAppState),
}));

vi.mock("../state/useDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

function homeDecl(id: string, order: number): PluginWidgetDeclaration {
  return {
    id,
    pluginId: "home-plugin",
    slot: "home",
    label: id,
    order,
    uiSpec: {
      root: "root",
      state: {},
      elements: { root: { type: "Text", props: { text: id }, children: [] } },
    },
  };
}

vi.mock("./registry", () => ({
  resolveWidgetsForSlot: (slot: string) =>
    (slot === "home" ? [homeDecl("a", 10), homeDecl("b", 20)] : []).map(
      (declaration) => ({ declaration, Component: null }),
    ),
  subscribeWidgetRegistry: () => () => {},
  getWidgetRegistryVersion: () => 0,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WidgetHost layout containment lock (#9304)", () => {
  it("applies `contain: layout` to the host so a reorder doesn't reflow the page", () => {
    render(<WidgetHost slot="home" layout="grid" />);
    const host = screen.getByTestId("widget-host-home");
    expect(host.style.contain).toBe("layout");
  });
});
