// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listAutomationsMock } = vi.hoisted(() => ({
  listAutomationsMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: { listAutomations: listAutomationsMock },
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

describe("WorkflowsWidget", () => {
  beforeEach(() => {
    listAutomationsMock.mockReset();
  });
  afterEach(() => cleanup());

  it("renders a loading card before the fetch resolves", () => {
    listAutomationsMock.mockReturnValue(new Promise(() => {}));
    render(<WorkflowsWidget />);
    expect(screen.getByTestId("chat-widget-workflows")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
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
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).toBeNull(),
    );
    expect(container.firstElementChild).toBeNull();
  });

  it("self-hides when the automations endpoint fails", async () => {
    listAutomationsMock.mockRejectedValue(new Error("404"));
    const { container } = render(<WorkflowsWidget />);
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).toBeNull(),
    );
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
});
