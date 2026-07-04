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

import { AutomationsWidget } from "./automations";

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

describe("AutomationsWidget", () => {
  beforeEach(() => {
    listAutomationsMock.mockReset();
    listScheduledTasksMock.mockReset();
    // Default: no scheduled tasks so existing assertions are unaffected.
    listScheduledTasksMock.mockResolvedValue(scheduledResponse([]));
  });
  afterEach(() => cleanup());

  it("renders a loading card before the fetch resolves", () => {
    listAutomationsMock.mockReturnValue(new Promise(() => {}));
    render(<AutomationsWidget />);
    expect(screen.getByTestId("chat-widget-automations")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("labels the widget with the Automations glossary term, never Tasks", async () => {
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    render(<AutomationsWidget />);
    await screen.findByText("Daily digest");
    // The label is folded into the card's hover title + aria-label (icon-only
    // card), never rendered as visible text — so assert the accessible name.
    const card = screen.getByTestId("chat-widget-automations");
    expect(card.getAttribute("title")).toBe("Automations");
    const ariaLabel = card.getAttribute("aria-label") ?? "";
    expect(ariaLabel).toContain("Running automations");
    expect(ariaLabel).not.toContain("Running tasks");
  });

  it("surfaces a boot-seeded scheduled task as the running task", async () => {
    // Fresh install: no workflows, but the seeded gm scheduled task exists.
    listAutomationsMock.mockResolvedValue(listResponse([]));
    listScheduledTasksMock.mockResolvedValue(
      scheduledResponse([scheduledTask({ metadata: { recordKey: "gm" } })]),
    );
    render(<AutomationsWidget />);
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
    const { container } = render(<AutomationsWidget />);
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
    render(<AutomationsWidget />);
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
    render(<AutomationsWidget />);
    await waitFor(() => expect(screen.getByText("Live one")).toBeTruthy());
    // No badge: only one running automation survives the filter.
    expect(screen.queryByText("+1")).toBeNull();
  });

  it("self-hides when nothing is running", async () => {
    listAutomationsMock.mockResolvedValue(listResponse([]));
    const { container } = render(<AutomationsWidget />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(container.firstElementChild).toBeNull();
  });

  it("self-hides when the automations endpoint fails", async () => {
    listAutomationsMock.mockRejectedValue(new Error("404"));
    const { container } = render(<AutomationsWidget />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(container.firstElementChild).toBeNull();
  });

  it("navigates to the automations view on activate", async () => {
    listAutomationsMock.mockResolvedValue(
      listResponse([automation({ id: "w-1", title: "Daily digest" })]),
    );
    const navSpy = vi.fn();
    window.addEventListener("eliza:navigate:view", navSpy);
    render(<AutomationsWidget />);
    const card = await screen.findByTestId("chat-widget-automations");
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
      <AutomationsWidget spanClassName="col-span-2 row-span-1" />,
    );
    await screen.findByTestId("chat-widget-automations");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("col-span-2");
    expect(root.className).toContain("row-span-1");
  });
});
