// @vitest-environment jsdom

/**
 * Renders the real automations feed against an in-memory API client, including
 * status, run, editor, capability-upgrade, and exclusive failure states.
 */

import {
  act,
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
import { ApiError } from "../../api/client-types-core";
import { invalidate } from "../../hooks/resource-cache";
import { AutomationsFeed, automationListCacheKey } from "./AutomationsFeed";

const DEFAULT_AGENT_BASE =
  "https://api.elizacloud.ai/api/v1/eliza/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const SECOND_AGENT_BASE =
  "https://api.elizacloud.ai/api/v1/eliza/agents/9b0deccb-a884-4149-b91d-328004ac108d";

const clientMock = vi.hoisted(() => ({
  baseUrl:
    "https://api.elizacloud.ai/api/v1/eliza/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea",
  listAutomations: vi.fn(),
  listScheduledTasks: vi.fn(),
  applyScheduledTask: vi.fn(),
  runWorkflowDefinition: vi.fn(),
}));
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../utils/openExternalUrl", () => ({
  openExternalUrl: openExternalUrlMock,
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
    executionFetchErrors: [],
  };
}

beforeEach(() => {
  window.location.hash = "#automations";
  clientMock.baseUrl = DEFAULT_AGENT_BASE;
  clientMock.listAutomations.mockResolvedValue(responseFixture());
  clientMock.listScheduledTasks.mockResolvedValue({ tasks: [] });
  clientMock.runWorkflowDefinition.mockResolvedValue({ id: "execution-1" });
});

afterEach(() => {
  cleanup();
  invalidate(automationListCacheKey(DEFAULT_AGENT_BASE));
  invalidate(automationListCacheKey(SECOND_AGENT_BASE));
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

  it("never paints one Cloud agent's cached workflows after switching agents", async () => {
    const firstResponse = responseFixture();
    firstResponse.automations = [
      automationItem({ title: "Agent A private workflow" }),
    ];
    const secondResponse = responseFixture();
    secondResponse.automations = [
      automationItem({
        id: "agent-b-automation",
        workflowId: "agent-b-workflow",
        title: "Agent B private workflow",
      }),
    ];
    let finishSecondRequest:
      | ((response: AutomationListResponse) => void)
      | undefined;
    clientMock.listAutomations
      .mockResolvedValueOnce(firstResponse)
      .mockReturnValueOnce(
        new Promise<AutomationListResponse>((resolve) => {
          finishSecondRequest = resolve;
        }),
      );
    const { rerender } = render(<AutomationsFeed />);

    expect(await screen.findByText("Agent A private workflow")).toBeTruthy();

    clientMock.baseUrl = SECOND_AGENT_BASE;
    rerender(<AutomationsFeed />);

    await waitFor(() => {
      expect(screen.queryByText("Agent A private workflow")).toBeNull();
    });
    expect(screen.queryByText("Agent B private workflow")).toBeNull();

    await act(async () => {
      finishSecondRequest?.(secondResponse);
    });
    expect(await screen.findByText("Agent B private workflow")).toBeTruthy();
  });

  it("prevents duplicate run requests while a workflow execution is pending", async () => {
    let finishRun: ((value: { id: string }) => void) | undefined;
    clientMock.runWorkflowDefinition.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        finishRun = resolve;
      }),
    );
    render(<AutomationsFeed />);

    const runButton = await screen.findByRole("button", {
      name: "Run Nightly review now",
    });
    fireEvent.click(runButton);
    fireEvent.click(runButton);

    expect(clientMock.runWorkflowDefinition).toHaveBeenCalledTimes(1);
    expect(runButton.hasAttribute("disabled")).toBe(true);

    finishRun?.({ id: "execution-1" });
    await waitFor(() => expect(runButton.hasAttribute("disabled")).toBe(false));
  });

  it("labels a failed run separately and retries the workflow operation", async () => {
    clientMock.runWorkflowDefinition
      .mockRejectedValueOnce(new Error("Smithers execution failed"))
      .mockResolvedValueOnce({ id: "execution-2" });
    render(<AutomationsFeed />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Run Nightly review now" }),
    );

    expect(await screen.findByText("Run failed")).toBeTruthy();
    expect(screen.getByText("Smithers execution failed")).toBeTruthy();
    expect(screen.queryByText("Automations couldn't be loaded")).toBeNull();
    expect(clientMock.listAutomations).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Run again" }));

    await waitFor(() =>
      expect(clientMock.runWorkflowDefinition).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(clientMock.listAutomations).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Run failed")).toBeNull();
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
      executionFetchErrors: [],
    });

    render(<AutomationsFeed />);

    expect(await screen.findByText("Nothing scheduled yet")).toBeTruthy();
    const scrollRegion = screen.getByTestId("automations-scroll-region");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.className).toContain(
      "pb-[var(--eliza-chat-clearance,5.25rem)]",
    );
    expect(scrollRegion.className).toContain(
      "pe-[var(--eliza-chat-side-clearance,0px)]",
    );
    expect(screen.getByTestId("automations-empty-state").className).toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:py-3",
    );
    expect(
      screen.getByTestId("automations-empty-state").querySelector("svg")
        ?.className.baseVal,
    ).toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:hidden",
    );
    // The empty state is unreachable in practice (a default is seeded on first
    // run); when it does render for the deleted-everything edge it must carry
    // NO create CTA — the agent offers re-creation from chat instead.
    expect(
      screen.queryByRole("button", { name: /create your first/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it("renders an explicit unavailable state when the workflow service is disabled", async () => {
    clientMock.listAutomations.mockResolvedValue({
      automations: [],
      summary: {
        total: 0,
        coordinatorCount: 0,
        workflowCount: 0,
        scheduledCount: 0,
        draftCount: 0,
      },
      workflowStatus: {
        mode: "disabled",
        host: "in-process",
        status: "error",
        cloudConnected: false,
        localEnabled: false,
      },
      workflowFetchError: "Workflow service is not registered",
      executionFetchErrors: [],
    });

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Workflow service unavailable"),
    ).toBeTruthy();
    expect(screen.getByText("Workflow service is not registered")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
  });

  it("renders a 404 workflow route as unavailable instead of healthy-empty", async () => {
    clientMock.listAutomations.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/automations",
        status: 404,
        message: "Not found",
      }),
    );

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Workflow service unavailable"),
    ).toBeTruthy();
    expect(
      screen.getByText(/workflow API is not available on this runtime/i),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeNull();
  });

  it("offers the existing dedicated-agent management flow for the typed capability gate", async () => {
    clientMock.listAutomations.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/automations",
        status: 409,
        code: "workflow_requires_dedicated",
        message:
          "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
      }),
    );

    render(<AutomationsFeed />);

    expect(await screen.findByText("Dedicated agent required")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    );

    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://elizacloud.ai/dashboard/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea",
    );
  });

  it("renders a failed initial load as an exclusive retryable error state", async () => {
    clientMock.listAutomations
      .mockRejectedValueOnce(new Error("Workflow service disconnected"))
      .mockResolvedValueOnce(responseFixture());

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Automations couldn't be loaded"),
    ).toBeTruthy();
    expect(screen.getByText("Workflow service disconnected")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Nightly review")).toBeTruthy();
    expect(clientMock.listAutomations).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Automations couldn't be loaded")).toBeNull();
  });

  it("surfaces a scheduled-task 500 instead of fabricating a healthy-empty supplement", async () => {
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
      executionFetchErrors: [],
    });
    clientMock.listScheduledTasks.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/scheduled-tasks",
        status: 500,
        message: "Scheduled-task storage failed",
      }),
    );

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Automations couldn't be loaded"),
    ).toBeTruthy();
    expect(screen.getByText("Scheduled-task storage failed")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("distinguishes unavailable execution history from a workflow that never ran", async () => {
    const response = responseFixture();
    response.automations = [
      automationItem({
        id: "automation-history-error",
        workflowId: "workflow-history-error",
        title: "History unavailable",
        lastExecution: undefined,
        executionFetchError: "execution store unavailable",
      }),
    ];
    response.executionFetchErrors = [
      {
        workflowId: "workflow-history-error",
        error: "execution store unavailable",
      },
    ];
    clientMock.listAutomations.mockResolvedValue(response);

    render(<AutomationsFeed />);

    expect(await screen.findByText("History unavailable")).toBeTruthy();
    expect(
      screen.getByText("Run history unavailable: execution store unavailable"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-passed")).getByText("0"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-failed")).getByText("0"),
    ).toBeTruthy();
  });
});
