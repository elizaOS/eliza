// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../../../hooks/useActivityEvents";
import type { ChatSidebarWidgetProps } from "./types";

// useWidgetNavigation → reportUserViewSwitch (slash-command controller). The
// home card opens a builtin tab (no view-path event), so the click test asserts
// the tab switch through this spy.
const { reportUserViewSwitchSpy } = vi.hoisted(() => ({
  reportUserViewSwitchSpy: vi.fn(),
}));
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: reportUserViewSwitchSpy,
}));

import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "./agent-orchestrator";

const ActivityWidget = AGENT_ORCHESTRATOR_PLUGIN_WIDGETS.find(
  (w) => w.id === "agent-orchestrator.activity",
)?.Component;

if (!ActivityWidget) {
  throw new Error("agent-orchestrator.activity widget not registered");
}

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: "e1",
    timestamp: Date.now(),
    eventType: "task_complete",
    summary: "Task completed",
    ...overrides,
  };
}

function props(
  overrides: Partial<ChatSidebarWidgetProps>,
): ChatSidebarWidgetProps {
  return {
    events: [],
    clearEvents: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  reportUserViewSwitchSpy.mockReset();
});

// #9143 / consolidation — the orchestrator Activity widget renders icon-first on
// the home slot (one datum + count) but keeps its full list in the sidebar.
describe("OrchestratorActivityWidget (home slot)", () => {
  it("renders nothing when there are no events (both slots self-hide empty)", () => {
    const { container } = render(
      <ActivityWidget {...props({ events: [], slot: "home" })} />,
    );
    expect(screen.queryByTestId("chat-widget-events")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("home slot: ONE compact, icon-first card — latest event summary + count badge, whole card clickable", () => {
    render(
      <ActivityWidget
        {...props({
          slot: "home",
          events: [
            event({ id: "latest", summary: "Escalated — needs attention" }),
            event({ id: "older", summary: "Task started: build" }),
          ],
        })}
      />,
    );

    const card = screen.getByTestId("chat-widget-events");
    expect(card.tagName).toBe("BUTTON");
    // events[0] is the latest (the rail unshifts) — the single datum.
    expect(card.textContent).toContain("Escalated — needs attention");
    expect(card.textContent).not.toContain("Task started: build");
    // Count is a badge.
    expect(card.textContent).toContain("2");
    expect(card.getAttribute("aria-label")).toMatch(/Escalated/);
  });

  it("home slot: clicking the card opens the Tasks tab", () => {
    render(
      <ActivityWidget
        {...props({ slot: "home", events: [event({ summary: "Working" })] })}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-widget-events"));

    // openTab("tasks") reports the switch through the slash-command controller.
    expect(reportUserViewSwitchSpy).toHaveBeenCalledWith("tasks");
  });

  it("chat-sidebar slot: keeps the existing activity list (a row per event, not a single card button)", () => {
    render(
      <ActivityWidget
        {...props({
          slot: "chat-sidebar",
          events: [
            event({ id: "a", summary: "Alpha event" }),
            event({ id: "b", summary: "Beta event" }),
          ],
        })}
      />,
    );

    const widget = screen.getByTestId("chat-widget-events");
    expect(widget.tagName).not.toBe("BUTTON");
    // Both events render as rows in the sidebar list.
    expect(widget.textContent).toContain("Alpha event");
    expect(widget.textContent).toContain("Beta event");
  });

  it("home slot: applies the host-supplied spanClassName to its single root grid-item element (#11752)", () => {
    const { container } = render(
      <ActivityWidget
        {...props({
          slot: "home",
          events: [event({ summary: "Working" })],
          spanClassName: "col-span-2 row-span-1",
        })}
      />,
    );

    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-events"]'),
    ).not.toBeNull();
  });

  it("home slot: falls back to the default 2x1 span when no spanClassName is supplied (#11752)", () => {
    const { container } = render(
      <ActivityWidget
        {...props({ slot: "home", events: [event({ summary: "Working" })] })}
      />,
    );
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });

  it("chat-sidebar slot: does NOT wrap the section in a grid-span root (#11752)", () => {
    const { container } = render(
      <ActivityWidget
        {...props({
          slot: "chat-sidebar",
          events: [event({ summary: "Working" })],
        })}
      />,
    );
    expect(container.firstElementChild?.className ?? "").not.toContain(
      "col-span-2",
    );
  });
});
