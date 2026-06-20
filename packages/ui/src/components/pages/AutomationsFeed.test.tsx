// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type { WorkflowExecution } from "../../api/client-types-chat";
import type {
  AutomationItem,
  AutomationListResponse,
} from "../../api/client-types-config";
import { invalidate } from "../../hooks/resource-cache";
import { AutomationsFeed } from "./AutomationsFeed";

vi.mock("../../api", () => ({
  client: {
    listAutomations: vi.fn(),
    runWorkflowDefinition: vi.fn(),
  },
}));

const clientMock = client as unknown as {
  listAutomations: ReturnType<typeof vi.fn>;
  runWorkflowDefinition: ReturnType<typeof vi.fn>;
};

function workflowItem(
  overrides: Partial<AutomationItem> & { id: string; title: string },
): AutomationItem {
  const { id, title, ...rest } = overrides;
  const workflowId = overrides.workflowId ?? id.replace("auto-", "");
  return {
    id,
    type: "workflow",
    source: "workflow",
    title,
    description: "",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: "2026-06-20T12:00:00.000Z",
    workflowId,
    workflow: {
      id: workflowId,
      name: title,
      active: true,
      nodes: [],
      connections: {},
    },
    schedules: [],
    room: null,
    ...rest,
  };
}

function listResponse(): AutomationListResponse {
  const automations = [
    workflowItem({
      id: "auto-nightly",
      title: "Nightly report",
      workflowId: "workflow-nightly",
      schedules: [
        {
          id: "trigger-nightly",
          taskId: "task-nightly",
          displayName: "Daily report",
          instructions: "",
          triggerType: "cron",
          enabled: true,
          wakeMode: "inject_now",
          createdBy: "test",
          cronExpression: "0 9 * * *",
          runCount: 3,
        },
      ],
      lastExecution: {
        status: "success",
        startedAt: "2026-06-20T12:00:00.000Z",
        stoppedAt: "2026-06-20T12:00:01.000Z",
      },
    }),
    workflowItem({
      id: "auto-slack",
      title: "Slack escalation",
      workflowId: "workflow-slack",
      enabled: false,
      status: "paused",
      workflow: {
        id: "workflow-slack",
        name: "Slack escalation",
        active: false,
        nodes: [],
        connections: {},
      },
      lastExecution: {
        status: "error",
        startedAt: "2026-06-20T12:05:00.000Z",
        stoppedAt: "2026-06-20T12:05:01.000Z",
        errorMessage: "Missing Slack credential",
      },
    }),
  ];
  return {
    automations,
    summary: {
      total: automations.length,
      coordinatorCount: 0,
      workflowCount: automations.length,
      scheduledCount: 1,
      draftCount: 0,
    },
    workflowStatus: null,
    workflowFetchError: null,
  };
}

function executionFixture(): WorkflowExecution {
  return {
    id: "execution-nightly",
    workflowId: "workflow-nightly",
    mode: "manual",
    status: "success",
    startedAt: "2026-06-20T12:10:00.000Z",
    stoppedAt: "2026-06-20T12:10:01.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidate("automations:list");
  window.location.hash = "#automations";
  clientMock.listAutomations.mockResolvedValue(listResponse());
  clientMock.runWorkflowDefinition.mockResolvedValue(executionFixture());
});

afterEach(() => {
  cleanup();
  invalidate("automations:list");
});

describe("AutomationsFeed", () => {
  it("renders workflow health and exposes a row run action", async () => {
    render(<AutomationsFeed />);

    const nightly = await screen.findByText("Nightly report");
    expect(nightly).toBeTruthy();

    const overview = screen.getByLabelText(/automation overview/i);
    expect(overview.textContent).toContain("2 workflows");
    expect(overview.textContent).toContain("1 active");
    expect(overview.textContent).toContain("1 need attention");
    expect(overview.textContent).toContain("1 scheduled");
    expect(screen.getByText("Failed: Missing Slack credential")).toBeTruthy();

    const row = nightly.closest("li");
    expect(row).toBeTruthy();
    const runButton = within(row as HTMLElement).getByRole("button", {
      name: "Run Nightly report now",
    });
    expect(runButton.getAttribute("data-agent-id")).toBe(
      "run-workflow-workflow-nightly",
    );

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(clientMock.runWorkflowDefinition).toHaveBeenCalledWith(
        "workflow-nightly",
      );
    });
  });
});
