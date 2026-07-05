// @vitest-environment jsdom

// Renders the real AutomationsFeed against a mocked `../../api` client to cover
// its status overview, truthful run action, and the streamlined creation
// surface. jsdom + in-memory client stub; no live backend.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationItem,
  AutomationListResponse,
} from "../../api/client-types-config";
import { invalidate } from "../../hooks/resource-cache";
import { AutomationsFeed } from "./AutomationsFeed";

const clientMock = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  listScheduledTasks: vi.fn(),
  applyScheduledTask: vi.fn(),
  runWorkflowDefinition: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

function automationItem(
  overrides: Partial<AutomationItem> = {},
): AutomationItem {
  return {
    id: "automation-1",
    type: "workflow",
    source: "workflow",
    title: "Nightly review",
    description: "",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: "2026-06-20T12:00:00.000Z",
    workflowId: "workflow-1",
    schedules: [
      {
        id: "trigger-1",
        taskId: "task-trigger-1",
        displayName: "Scheduled workflow run: Nightly review",
        instructions: "Run workflow Nightly review",
        triggerType: "interval",
        enabled: true,
        wakeMode: "inject_now",
        createdBy: "workflow.schedule",
        intervalMs: 3_600_000,
        runCount: 0,
      },
    ],
    lastExecution: {
      status: "success",
      startedAt: "2026-06-20T12:00:00.000Z",
      stoppedAt: "2026-06-20T12:00:01.000Z",
    },
    ...overrides,
  };
}

function responseFixture(): AutomationListResponse {
  const automations = [
    automationItem(),
    automationItem({
      id: "automation-2",
      title: "Broken workflow",
      workflowId: "workflow-2",
      lastExecution: {
        status: "error",
        startedAt: "2026-06-20T13:00:00.000Z",
        errorMessage: "HTTP request failed",
      },
    }),
    automationItem({
      id: "task-1",
      type: "coordinator_text",
      source: "workbench_task",
      title: "Simple reminder",
      status: "paused",
      enabled: false,
      hasBackingWorkflow: false,
      workflowId: undefined,
      lastExecution: undefined,
    }),
  ];
  return {
    automations,
    summary: {
      total: automations.length,
      coordinatorCount: 1,
      workflowCount: 2,
      scheduledCount: 0,
      draftCount: 0,
    },
    workflowStatus: null,
    workflowFetchError: null,
  };
}

beforeEach(() => {
  window.location.hash = "#automations";
  clientMock.listAutomations.mockResolvedValue(responseFixture());
  clientMock.listScheduledTasks.mockResolvedValue({ tasks: [] });
  clientMock.runWorkflowDefinition.mockResolvedValue({ id: "execution-1" });
});

afterEach(() => {
  cleanup();
  invalidate("automations:list");
  vi.clearAllMocks();
});

describe("AutomationsFeed", () => {
  it("shows a compact status overview and truthful workflow run action", async () => {
    render(<AutomationsFeed />);

    expect(await screen.findByText("Nightly review")).toBeTruthy();

    expect(
      within(screen.getByTestId("automation-stat-total")).getByText("3"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-active")).getByText("2"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-passed")).getByText("1"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-failed")).getByText("1"),
    ).toBeTruthy();
    expect(screen.getByText("Failed: HTTP request failed")).toBeTruthy();
    expect(screen.getAllByText("Every hour").length).toBeGreaterThan(0);

    expect(
      screen.queryByRole("button", { name: /activate workflow/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /deactivate workflow/i }),
    ).toBeNull();

    const runButton = screen.getByRole("button", {
      name: "Run Nightly review now",
    });
    expect(runButton.getAttribute("data-agent-id")).toBe(
      "run-workflow-workflow-1",
    );

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(clientMock.runWorkflowDefinition).toHaveBeenCalledWith(
        "workflow-1",
      );
    });
    expect(clientMock.listAutomations).toHaveBeenCalledTimes(2);
  });

  it("keeps the feed header focused on status instead of generic creation", async () => {
    render(<AutomationsFeed />);

    await screen.findByText("Nightly review");
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it("renders the uniform ViewHeader with a centered title and bare-icon back", async () => {
    render(<AutomationsFeed />);

    await screen.findByText("Nightly review");
    const header = screen.getByTestId("view-header");
    expect(header).toBeTruthy();
    // Title lives in the header, not a page-level heading block.
    expect(within(header).getByText("Automations")).toBeTruthy();
    // Bare-icon back affordance (no text label, aria-labelled).
    expect(within(header).getByRole("button", { name: /back/i })).toBeTruthy();
  });

  it("shows a designed-empty state with NO create CTA when nothing is scheduled", async () => {
    clientMock.listAutomations.mockResolvedValue({
      automations: [],
      summary: {
        total: 0,
        coordinatorCount: 0,
        workflowCount: 0,
        scheduledCount: 0,
        draftCount: 0,
      },
      workflowStatus: null,
      workflowFetchError: null,
    });

    render(<AutomationsFeed />);

    expect(await screen.findByText("Nothing scheduled yet")).toBeTruthy();
    // The empty state is unreachable in practice (a default is seeded on first
    // run); when it does render for the deleted-everything edge it must carry
    // NO create CTA — the agent offers re-creation from chat instead.
    expect(
      screen.queryByRole("button", { name: /create your first/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });
});
