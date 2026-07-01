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
import type {
  AutomationItem,
  AutomationListResponse,
} from "../../api/client-types-config";
import { ApiError } from "../../api/client-types-core";
import { invalidate } from "../../hooks/resource-cache";
import { AutomationsFeed } from "./AutomationsFeed";

/** A promise whose resolution is controlled by the test, for in-flight assertions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    schedules: [],
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

  it("routes new automation creation into the Automations chat", async () => {
    const prefill = vi.fn();
    window.addEventListener("eliza:chat:prefill", prefill as EventListener);
    render(<AutomationsFeed />);

    await screen.findByText("Nightly review");
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(prefill).toHaveBeenCalledOnce();
    const event = prefill.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({
      text: "Create an automation that ",
      select: false,
    });

    window.removeEventListener("eliza:chat:prefill", prefill as EventListener);
  });

  it("filters the feed to a single kind and reflects per-filter counts", async () => {
    render(<AutomationsFeed />);
    await screen.findByText("Nightly review");

    // All three rows visible under the default "all" filter.
    expect(screen.getByText("Nightly review")).toBeTruthy();
    expect(screen.getByText("Broken workflow")).toBeTruthy();
    expect(screen.getByText("Simple reminder")).toBeTruthy();

    // The Tasks chip carries the derived count (1 task in the fixture).
    const tasksChip = screen.getByRole("button", { name: /^Tasks/ });
    expect(tasksChip.textContent).toContain("1");
    fireEvent.click(tasksChip);

    // Only the task row survives the filter; both workflows are gone.
    expect(screen.queryByText("Nightly review")).toBeNull();
    expect(screen.queryByText("Broken workflow")).toBeNull();
    expect(screen.getByText("Simple reminder")).toBeTruthy();
    expect(tasksChip.getAttribute("aria-current")).toBe("true");

    // Switching to Inactive shows only the disabled task (enabled === false).
    const inactiveChip = screen.getByRole("button", { name: /^Inactive/ });
    expect(inactiveChip.textContent).toContain("1");
    fireEvent.click(inactiveChip);
    expect(screen.getByText("Simple reminder")).toBeTruthy();
    expect(screen.queryByText("Nightly review")).toBeNull();

    // Active shows the two enabled workflows and hides the task.
    const activeChip = screen.getByRole("button", { name: /^Active/ });
    expect(activeChip.textContent).toContain("2");
    fireEvent.click(activeChip);
    expect(screen.getByText("Nightly review")).toBeTruthy();
    expect(screen.getByText("Broken workflow")).toBeTruthy();
    expect(screen.queryByText("Simple reminder")).toBeNull();
  });

  it("responds to the external eliza:automations:setFilter event", async () => {
    render(<AutomationsFeed />);
    await screen.findByText("Nightly review");

    fireEvent(
      window,
      new CustomEvent("eliza:automations:setFilter", {
        detail: { filter: "workflows" },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Simple reminder")).toBeNull();
    });
    expect(screen.getByText("Nightly review")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Workflows/ }).getAttribute(
        "aria-current",
      ),
    ).toBe("true");
  });

  it("shows the empty state (not an error banner) when there are no automations", async () => {
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
    expect(
      within(screen.getByTestId("automation-stat-total")).getByText("0"),
    ).toBeTruthy();
    // The create-first CTA prefills the automations chat, same rail as "New".
    const prefill = vi.fn();
    window.addEventListener("eliza:chat:prefill", prefill as EventListener);
    fireEvent.click(
      screen.getByRole("button", { name: "Create your first automation" }),
    );
    expect(prefill).toHaveBeenCalledOnce();
    window.removeEventListener("eliza:chat:prefill", prefill as EventListener);
  });

  it("treats a 404 (workflow runtime not hosted) as empty, never an error", async () => {
    clientMock.listAutomations.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/automations",
        message: "Not Found",
        status: 404,
      }),
    );

    render(<AutomationsFeed />);

    expect(await screen.findByText("Nothing scheduled yet")).toBeTruthy();
    // The 404 message must NOT leak into the red error banner.
    expect(screen.queryByText("Not Found")).toBeNull();
  });

  it("surfaces a non-404 load failure as a visible error banner", async () => {
    clientMock.listAutomations.mockRejectedValue(new Error("backend exploded"));

    render(<AutomationsFeed />);

    // The raw failure message is surfaced in the danger-styled error banner —
    // a swallowed catch (or a silent empty-state fallback) would hide it.
    const banner = await screen.findByText("backend exploded");
    expect(banner.className).toContain("text-danger");
  });

  it("renders the loading skeleton before data arrives (no rows, no empty state)", async () => {
    const gate = deferred<AutomationListResponse>();
    clientMock.listAutomations.mockReturnValue(gate.promise);

    render(<AutomationsFeed />);

    // While the fetch is in flight: neither real rows nor the empty headline.
    expect(screen.queryByText("Nightly review")).toBeNull();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();

    gate.resolve(responseFixture());
    expect(await screen.findByText("Nightly review")).toBeTruthy();
  });

  it("runs a workflow with the exact id and refreshes on success", async () => {
    render(<AutomationsFeed />);
    await screen.findByText("Nightly review");

    fireEvent.click(
      screen.getByRole("button", { name: "Run Nightly review now" }),
    );

    await waitFor(() => {
      expect(clientMock.runWorkflowDefinition).toHaveBeenCalledWith(
        "workflow-1",
      );
    });
    // Exactly one execution, and the list is re-read afterwards.
    expect(clientMock.runWorkflowDefinition).toHaveBeenCalledTimes(1);
    expect(clientMock.listAutomations).toHaveBeenCalledTimes(2);
  });

  it("surfaces a run failure in the error banner without wiping the feed", async () => {
    clientMock.runWorkflowDefinition.mockRejectedValue(
      new Error("run rejected"),
    );

    render(<AutomationsFeed />);
    await screen.findByText("Nightly review");

    fireEvent.click(
      screen.getByRole("button", { name: "Run Nightly review now" }),
    );

    expect(await screen.findByText("run rejected")).toBeTruthy();
    // The list is still on screen — a failed run does not clear it.
    expect(screen.getByText("Nightly review")).toBeTruthy();
  });

  it("does not deduplicate rapid-fire run clicks (in-flight guard is missing)", async () => {
    // Hold the first run open so a synchronous second click lands before any
    // refresh/re-render can gate it.
    const gate = deferred<{ id: string }>();
    clientMock.runWorkflowDefinition.mockReturnValue(gate.promise);

    render(<AutomationsFeed />);
    await screen.findByText("Nightly review");

    const runButton = screen.getByRole("button", {
      name: "Run Nightly review now",
    });
    fireEvent.click(runButton);
    fireEvent.click(runButton);
    fireEvent.click(runButton);

    // BUG: every click fires its own execution — no in-flight/disabled guard.
    // All calls still target the correct workflow id (routing is not corrupted).
    expect(clientMock.runWorkflowDefinition).toHaveBeenCalledTimes(3);
    for (const call of clientMock.runWorkflowDefinition.mock.calls) {
      expect(call[0]).toBe("workflow-1");
    }

    gate.resolve({ id: "execution-1" });
    await waitFor(() => {
      // Each successful run triggers its own refresh: 1 initial + 3 runs.
      expect(clientMock.listAutomations).toHaveBeenCalledTimes(4);
    });
  });
});
