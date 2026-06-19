// @vitest-environment jsdom
//
// FacewearTuiView and SmartglassesTuiView are thin wrappers over the shared
// @elizaos/ui TerminalPluginView. They own no data display or interact() export
// of their own, but they DO declare the exact endpoint lists the generic TUI
// surface advertises. These tests guard those declared endpoints (the documented
// data sources per TUI view) by rendering the wrappers and asserting the rendered
// endpoint chips + the TerminalPluginView view-state payload.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FacewearTuiView, SmartglassesTuiView } from "../ui/FacewearView.tsx";

afterEach(() => {
  cleanup();
});

function viewState(container: HTMLElement): {
  viewType: string;
  viewId: string;
  label: string;
  endpointCount: number;
  commandCount: number;
} {
  const node = container.querySelector("[data-view-state]");
  expect(node).toBeTruthy();
  return JSON.parse(node?.getAttribute("data-view-state") ?? "{}");
}

function endpointChips(): string[] {
  // TerminalPluginView renders each endpoint as a chip: a nested <span>GET</span>
  // plus the endpoint path text node. testing-library matches the chip element by
  // its own text node (the path), but textContent concatenates the "GET" child —
  // so match on the path and normalize the "GET" prefix back out.
  return screen
    .getAllByText(/^\/api\/facewear\//)
    .map((node) => (node.textContent ?? "").replace(/^GET/, ""));
}

describe("FacewearTuiView", () => {
  it("renders TerminalPluginView with the declared facewear status/devices/views endpoints", () => {
    const { container } = render(<FacewearTuiView />);

    const state = viewState(container);
    expect(state.viewId).toBe("facewear");
    expect(state.viewType).toBe("tui");
    expect(state.label).toBe("Facewear TUI");
    // No plugin-owned commands -> generic command set (TerminalPluginView default
    // is 3 capabilities when commands=[]).
    expect(state.endpointCount).toBe(3);

    const endpoints = endpointChips();
    expect(endpoints).toContain("/api/facewear/status");
    expect(endpoints).toContain("/api/facewear/devices");
    expect(endpoints).toContain("/api/facewear/views");
    expect(endpoints).toHaveLength(3);
  });
});

describe("SmartglassesTuiView", () => {
  it("renders TerminalPluginView with the declared smartglasses status/devices endpoints", () => {
    const { container } = render(<SmartglassesTuiView />);

    const state = viewState(container);
    expect(state.viewId).toBe("smartglasses");
    expect(state.viewType).toBe("tui");
    expect(state.label).toBe("Smartglasses TUI");
    expect(state.endpointCount).toBe(2);

    const endpoints = endpointChips();
    expect(endpoints).toContain("/api/facewear/status");
    expect(endpoints).toContain("/api/facewear/devices");
    expect(endpoints).not.toContain("/api/facewear/views");
    expect(endpoints).toHaveLength(2);
  });
});
