// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetHost } from "./WidgetHost";
import { WIDGET_UI_ACTION_EVENT } from "./WidgetHost.constants";

const mockAppState = {
  plugins: [{ id: "spec-plugin", enabled: true, isActive: true }],
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

vi.mock("./registry", () => ({
  resolveWidgetsForSlot: () => [
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
  ],
}));

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
});
