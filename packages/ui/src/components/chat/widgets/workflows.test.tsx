// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listAutomationsMock, listScheduledTasksMock } = vi.hoisted(() => ({
  listAutomationsMock: vi.fn(),
  listScheduledTasksMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    listAutomations: listAutomationsMock,
    listScheduledTasks: listScheduledTasksMock,
  },
}));

// useWidgetNavigation → reportUserViewSwitch (from the slash-command
// controller); stub it so the click test isolates the navigation rail (the
// CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import { WorkflowsWidget } from "./workflows";

function automation(overrides: Record<string, unknown>) {
  return {
    id: "auto-1",
    type: "workflow",
    source: "workflow",
    title: "Untitled",
    description: "",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: null,
    schedules: [],
    ...overrides,
  };
}

function listResponse(automations: ReturnType<typeof automation>[]) {
  return {
    automations,
    summary: {
      total: automations.length,
      coordinatorCount: 0,
      workflowCount: automations.length,
      scheduledCount: 0,
      draftCount: 0,
    },
    workflowStatus: null,
    workflowFetchError: null,
  };
}

function scheduledTask(overrides: Record<string, unknown>) {
  return {
    taskId: "st-1",
    kind: "reminder",
    promptInstructions: "Say good morning",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 0,
    },
    priority: "low",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "daily-rhythm",
    ownerVisible: true,
    metadata: { recordKey: "gm" },
    ...overrides,
  };
}

function scheduledResponse(tasks: ReturnType<typeof scheduledTask>[]) {
  return { tasks };
}

describe("WorkflowsWidget", () => {
  beforeEach(() => {
    listAutomationsMock.mockReset();
    listScheduledTasksMock.mockReset();
    // Default: no scheduled tasks so existing assertions are unaffected.
    listScheduledTasksMock.mockResolvedValue(scheduledResponse([]));
  });
  afterEach(() => cleanup());

  it("renders a loading card before the fetch resolves", () => {
    listAutomationsMock.mockReturnValue(new Promise(() => {}));
    render(<WorkflowsWidget />);
    expect(screen.getByTestId("chat-widget-workflows")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("surfaces a boot-seeded scheduled task as the running task", async () => {
    // Fresh install: no workflows, but the seeded gm scheduled task exists.
    listAutomationsMock.mockResolvedValue(listResponse([]));
    listScheduledTasksMock.mockResolvedValue(
      scheduledResponse([scheduledTask({ metadata: { recordKey: "gm" } })]),
    );
    render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.getByText("Good morning")).toBeTruthy());
  });

  it("excludes a paused (manual-trigger) seeded recap from the running top-line", async () => {
    listAutomationsMock.mockResolvedValue(listResponse([]));
    listScheduledTasksMock.mockResolvedValue(
      scheduledResponse([
        scheduledTask({
          taskId: "weekly",
          kind: "recap",
          trigger: { kind: "manual" },
          metadata: { recordKey: "weekly-review" },
        }),
      ]),
    );
    const { container } = render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    // Manual trigger → paused → not "running" → self-hides.
    expect(container.firstElementChild).toBeNull();
  });

  it("shows the top running workflow and a +N badge for the rest", async () => {
    listAutomationsMock.mockResolvedValue(
      listResponse([
        automation({ id: "w-1", title: "Daily digest" }),
        automation({ id: "w-2", title: "Inbox triage" }),
        automation({
          id: "sys-1",
          title: "Assistant",
          system: true,
          status: "system",
        }),
      ]),
    );
    render(<WorkflowsWidget />);
    // System automations sort first.
    await waitFor(() => expect(screen.getByText("Assistant")).toBeTruthy());
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("excludes paused, draft, and completed automations", async () => {
    listAutomationsMock.mockResolvedValue(
      listResponse([
        automation({ id: "p", title: "Paused", status: "paused" }),
        automation({
          id: "d",
          title: "Draft",
          status: "draft",
          isDraft: true,
        }),
        automation({
          id: "c",
          title: "Done",
          status: "completed",
          enabled: false,
        }),
        automation({ id: "a", title: "Live one" }),
      ]),
    );
    render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.getByText("Live one")).toBeTruthy());
    // No badge: only one running automation survives the filter.
    expect(screen.queryByText("+1")).toBeNull();
  });

  it("self-hides when nothing is running", async () => {
    listAutomationsMock.mockResolvedValue(listResponse([]));
    const { container } = render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(container.firstElementChild).toBeNull();
  });

  it("self-hides when the automations endpoint fails", async () => {
    listAutomationsMock.mockRejectedValue(new Error("404"));
    const { container } = render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(container.firstElementChild).toBeNull();
  });

  it("navigates to the automations view on activate", async () => {
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    const navSpy = vi.fn();
    window.addEventListener("eliza:navigate:view", navSpy);
    render(<WorkflowsWidget />);
    const card = await screen.findByTestId("chat-widget-workflows");
    fireEvent.click(card);
    expect(navSpy).toHaveBeenCalledTimes(1);
    const detail = (navSpy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ viewPath: "/automations" });
    window.removeEventListener("eliza:navigate:view", navSpy);
  });

  it("applies the provided span class to the root grid item", async () => {
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    const { container } = render(
      <WorkflowsWidget spanClassName="col-span-2 row-span-1" />,
    );
    await screen.findByTestId("chat-widget-workflows");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("col-span-2");
    expect(root.className).toContain("row-span-1");
  });

  it("counts running tasks across BOTH sources for the +N badge", async () => {
    // One active automation + one boot-seeded gm scheduled task = 2 running,
    // merged client-side. "Daily digest" sorts before "Good morning" so it is
    // the top line and the seeded task becomes the +1.
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    listScheduledTasksMock.mockResolvedValue(
      scheduledResponse([scheduledTask({ metadata: { recordKey: "gm" } })]),
    );
    render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.getByText("Daily digest")).toBeTruthy());
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("fires one nav event per rapid-fire click with a stable payload", async () => {
    // The card's onActivate is memoized (useCallback over a stable nav), so
    // rapid double/triple taps must each dispatch exactly one nav with an
    // identical detail — no dropped or duplicated events, no crash.
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    const navSpy = vi.fn();
    window.addEventListener("eliza:navigate:view", navSpy);
    render(<WorkflowsWidget />);
    const card = await screen.findByTestId("chat-widget-workflows");
    fireEvent.click(card);
    fireEvent.click(card);
    fireEvent.click(card);
    expect(navSpy).toHaveBeenCalledTimes(3);
    for (const call of navSpy.mock.calls) {
      expect((call[0] as CustomEvent).detail).toEqual({
        viewPath: "/automations",
      });
    }
    window.removeEventListener("eliza:navigate:view", navSpy);
  });

  it("exposes exactly one control — navigate — and no stop/cancel affordance", async () => {
    // This is a glanceable card, not a controller: the ONLY interactive
    // element is the whole-card nav button. There is no inline stop/cancel of a
    // running workflow here (that lives in the full Tasks view). Pin that so a
    // regression adding a hidden destructive control is caught.
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    const { container } = render(<WorkflowsWidget />);
    const card = await screen.findByTestId("chat-widget-workflows");
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]).toBe(card);
    // No stop/cancel/delete labelling anywhere in the rendered subtree.
    expect(container.textContent).not.toMatch(/stop|cancel|delete/i);
  });

  it("self-hides (no throw) when the API returns a malformed collection", async () => {
    // Adversarial: a runtime returns a non-array `automations` / `tasks`
    // payload. The reader guards with Array.isArray, so the widget must settle
    // to "nothing running" and self-hide rather than throwing on .filter.
    listAutomationsMock.mockResolvedValue({
      automations: null,
      summary: null,
      workflowStatus: null,
      workflowFetchError: null,
    });
    listScheduledTasksMock.mockResolvedValue({ tasks: "boom" });
    const { container } = render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(container.firstElementChild).toBeNull();
  });

  it("isolates a malformed scheduled-tasks source and still shows valid automations", async () => {
    // One source degrades (garbage tasks) but the other is healthy: the guard
    // must drop only the bad source, not the whole surface.
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    listScheduledTasksMock.mockResolvedValue({ tasks: null });
    render(<WorkflowsWidget />);
    await waitFor(() => expect(screen.getByText("Daily digest")).toBeTruthy());
    // Only the one healthy automation is running → no +N badge.
    expect(screen.queryByText("+1")).toBeNull();
  });
});
