// @vitest-environment jsdom

/**
 * Renders WidgetHost against mocked app state + a stubbed widget resolver to
 * verify it mounts the resolved widgets for a slot and forwards widget UI
 * actions via the WIDGET_UI_ACTION_EVENT. jsdom render (no real backend).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetHost } from "./WidgetHost";
import { WIDGET_UI_ACTION_EVENT } from "./WidgetHost.constants";

const { clientMock, resolveWidgetsForSlotMock } = vi.hoisted(() => ({
  clientMock: {
    getBaseUrl: vi.fn(() => ""),
  },
  resolveWidgetsForSlotMock: vi.fn(),
}));

const mockAppState = {
  plugins: [
    {
      id: "spec-plugin",
      enabled: true,
      isActive: true,
      widgets: [
        {
          id: "server-home",
          pluginId: "spec-plugin",
          slot: "home",
          label: "Server Home",
        },
      ],
    },
  ],
  t: (key: string) => key,
};

vi.mock("../state", () => ({
  useApp: () => mockAppState,
  useAppSelector: <T,>(selector: (s: typeof mockAppState) => T): T =>
    selector(mockAppState),
  useAppSelectorShallow: <T,>(selector: (s: typeof mockAppState) => T): T =>
    selector(mockAppState),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../state/useDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

vi.mock("./registry", () => ({
  resolveWidgetsForSlot: resolveWidgetsForSlotMock,
  subscribeWidgetRegistry: () => () => {},
  getWidgetRegistryVersion: () => 0,
}));

beforeEach(() => {
  clientMock.getBaseUrl.mockReturnValue("");
  resolveWidgetsForSlotMock.mockReturnValue([
    {
      declaration: {
        id: "overview",
        pluginId: "spec-plugin",
        slot: "chat-sidebar",
        label: "Spec Widget",
        uiSpec: {
          root: "root",
          state: {},
          elements: {
            root: {
              type: "Card",
              props: { title: "Spec Widget" },
              children: ["body", "button"],
            },
            body: {
              type: "Text",
              props: { text: "Rendered from uiSpec" },
              children: [],
            },
            button: {
              type: "Button",
              props: { label: "Run action" },
              children: [],
              on: {
                press: {
                  action: "widget.run",
                  params: { value: "ok" },
                },
              },
            },
          },
        },
      },
      Component: null,
    },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WidgetHost", () => {
  it("defaults to a vertical stack but renders a responsive grid when layout=grid (#9143)", () => {
    const { rerender } = render(<WidgetHost slot="chat-sidebar" />);
    const stack = screen.getByTestId("widget-host-chat-sidebar");
    expect(stack.getAttribute("data-layout")).toBe("stack");
    expect(stack.className).toContain("flex-col");

    rerender(<WidgetHost slot="chat-sidebar" layout="grid" />);
    const grid = screen.getByTestId("widget-host-chat-sidebar");
    expect(grid.getAttribute("data-layout")).toBe("grid");
    expect(grid.className).toContain("sm:grid-cols-2");
  });

  it("renders the fallback in place of an empty host (home default widgets)", () => {
    resolveWidgetsForSlotMock.mockReturnValue([]);
    render(
      <WidgetHost
        slot="chat-sidebar"
        fallback={<div data-testid="hw-fallback">defaults</div>}
      />,
    );
    // The host itself renders nothing, but the fallback shows so the surface is
    // never blank.
    expect(screen.queryByTestId("widget-host-chat-sidebar")).toBeNull();
    expect(screen.getByTestId("hw-fallback")).toBeTruthy();
  });

  it("hides entirely when empty with no fallback", () => {
    resolveWidgetsForSlotMock.mockReturnValue([]);
    const { container } = render(<WidgetHost slot="chat-sidebar" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the fallback when resolved widgets all self-hide (render nothing)", () => {
    // A widget that resolves but renders null (no data) — the host container is
    // present but paints nothing, so the fallback must still show.
    resolveWidgetsForSlotMock.mockReturnValue([
      {
        declaration: {
          id: "empty-widget",
          pluginId: "spec-plugin",
          slot: "chat-sidebar",
          label: "Empty",
        },
        Component: () => null,
      },
    ]);
    render(
      <WidgetHost
        slot="chat-sidebar"
        fallback={<div data-testid="hw-fallback">defaults</div>}
      />,
    );
    const host = screen.getByTestId("widget-host-chat-sidebar");
    expect(host.childElementCount).toBe(0); // widget painted nothing
    expect(screen.getByTestId("hw-fallback")).toBeTruthy(); // fallback shows
  });

  it("renders uiSpec widgets and dispatches their actions", () => {
    const seen: unknown[] = [];
    window.addEventListener(WIDGET_UI_ACTION_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });

    render(<WidgetHost slot="chat-sidebar" />);

    expect(screen.getByTestId("widget-uispec-overview")).toBeTruthy();
    expect(screen.getByText("Rendered from uiSpec")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run action" }));

    expect(seen).toEqual([
      {
        pluginId: "spec-plugin",
        widgetId: "overview",
        slot: "chat-sidebar",
        action: "widget.run",
        params: { value: "ok" },
      },
    ]);
  });

  it("passes server-declared plugin widgets into the registry resolver", () => {
    render(<WidgetHost slot="home" />);

    expect(resolveWidgetsForSlotMock).toHaveBeenCalledWith(
      "home",
      mockAppState.plugins,
      [
        {
          id: "server-home",
          pluginId: "spec-plugin",
          slot: "home",
          label: "Server Home",
        },
      ],
    );
  });

  it("hides full app-shell widgets on limited cloud agent bases", () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://37911a1e-ed40-4626-88f5-0e4dcf249a34.elizacloud.ai",
    );
    resolveWidgetsForSlotMock.mockReturnValue([
      {
        declaration: {
          id: "agent-orchestrator.apps",
          pluginId: "agent-orchestrator",
          slot: "home",
          label: "Apps",
        },
        Component: () => <div>Apps widget</div>,
      },
      {
        // wallet is NOT in FULL_APP_SHELL_WIDGET_PLUGIN_IDS, so it must keep
        // rendering on the limited base while the shell-bound widgets hide.
        declaration: {
          id: "wallet.balance",
          pluginId: "wallet",
          slot: "home",
          label: "Wallet",
        },
        Component: () => <div>Wallet widget</div>,
      },
    ]);

    render(<WidgetHost slot="home" />);

    expect(screen.queryByText("Apps widget")).toBeNull();
    expect(screen.getByText("Wallet widget")).toBeTruthy();
  });
});
