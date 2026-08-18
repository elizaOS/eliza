/** Verifies useUnifiedTasks through the package's configured test harness. */
// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationItem,
  AutomationListResponse,
} from "../api/client-types-config";
import type {
  ScheduledTaskListResponse,
  ScheduledTaskView,
} from "../api/client-types-core";

// Native-complete seam: automations go through workflowSurfaceClient.fetch,
// scheduled tasks through the active client.fetch — each with its own timeoutMs.
const { automationsFetchMock, scheduledFetchMock } = vi.hoisted(() => ({
  automationsFetchMock: vi.fn(),
  scheduledFetchMock: vi.fn(),
}));
vi.mock("../api", () => ({
  client: {
    fetch: scheduledFetchMock,
  },
}));
vi.mock("../api/workflow-surface-routing", () => ({
  workflowSurfaceClient: () => ({ fetch: automationsFetchMock }),
}));

import {
  fetchUnifiedAutomations,
  fetchUnifiedScheduledTasks,
  UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS,
  UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS,
  useUnifiedTasks,
} from "./useUnifiedTasks";

const automation: AutomationItem = {
  id: "workflow:w-1",
  type: "workflow",
  source: "workflow",
  title: "Daily digest",
  description: "",
  status: "active",
  enabled: true,
  system: false,
  isDraft: false,
  hasBackingWorkflow: true,
  updatedAt: null,
  schedules: [],
};

function automationsResponse(items: AutomationItem[]): AutomationListResponse {
  return {
    automations: items,
    summary: {
      total: items.length,
      coordinatorCount: 0,
      workflowCount: items.length,
      scheduledCount: 0,
      draftCount: 0,
    },
    workflowStatus: null,
    workflowFetchError: null,
    executionFetchErrors: [],
  };
}

function scheduledTask(
  over: Partial<ScheduledTaskView> = {},
): ScheduledTaskView {
  return {
    taskId: "t-1",
    kind: "reminder",
    promptInstructions: "Say good morning",
    trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
    priority: "low",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "daily-rhythm",
    ownerVisible: true,
    metadata: { recordKey: "gm" },
    ...over,
  };
}

function scheduledResponse(
  tasks: ScheduledTaskView[],
): ScheduledTaskListResponse {
  return { tasks };
}

describe("useUnifiedTasks", () => {
  beforeEach(() => {
    automationsFetchMock.mockReset();
    scheduledFetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges automations + scheduled tasks into one list and settles loading", async () => {
    automationsFetchMock.mockResolvedValue(automationsResponse([automation]));
    scheduledFetchMock.mockResolvedValue(scheduledResponse([scheduledTask()]));

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    const ids = result.current.state.items.map((i) => i.id);
    expect(ids).toContain("workflow:w-1");
    expect(ids).toContain("scheduled:t-1");
    expect(result.current.state.error).toBeNull();
    expect(automationsFetchMock).toHaveBeenCalledTimes(1);
    expect(scheduledFetchMock).toHaveBeenCalledTimes(1);
    expect(automationsFetchMock).toHaveBeenCalledWith(
      "/api/automations",
      undefined,
      { timeoutMs: UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS },
    );
    expect(scheduledFetchMock).toHaveBeenCalledWith(
      "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
      undefined,
      { timeoutMs: UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS },
    );
  });

  it("degrades each source independently — one source failing yields empty for it, not an error", async () => {
    automationsFetchMock.mockRejectedValue(new Error("automations not hosted"));
    scheduledFetchMock.mockResolvedValue(scheduledResponse([scheduledTask()]));

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    expect(result.current.state.error).toBeNull();
    expect(result.current.state.items.map((i) => i.id)).toEqual([
      "scheduled:t-1",
    ]);
  });

  it("settles to empty (never throws) when BOTH sources fail", async () => {
    automationsFetchMock.mockRejectedValue(new Error("down"));
    scheduledFetchMock.mockRejectedValue(new Error("down"));

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    expect(result.current.state.items).toEqual([]);
    expect(result.current.state.error).toBeNull();
  });

  it("requests owner-visible scheduled tasks by default", async () => {
    automationsFetchMock.mockResolvedValue(automationsResponse([]));
    scheduledFetchMock.mockResolvedValue(scheduledResponse([]));

    renderHook(() => useUnifiedTasks());
    await waitFor(() =>
      expect(scheduledFetchMock).toHaveBeenCalledWith(
        "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
        undefined,
        { timeoutMs: UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS },
      ),
    );
  });

  it("honors ownerVisibleOnly: false override", async () => {
    automationsFetchMock.mockResolvedValue(automationsResponse([]));
    scheduledFetchMock.mockResolvedValue(scheduledResponse([]));

    renderHook(() => useUnifiedTasks({ ownerVisibleOnly: false }));
    await waitFor(() =>
      expect(scheduledFetchMock).toHaveBeenCalledWith(
        "/api/lifeops/scheduled-tasks",
        undefined,
        { timeoutMs: UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS },
      ),
    );
  });

  it("refresh() re-fetches both sources", async () => {
    automationsFetchMock.mockResolvedValue(automationsResponse([]));
    scheduledFetchMock.mockResolvedValue(scheduledResponse([]));

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    const before = automationsFetchMock.mock.calls.length;
    await result.current.refresh();
    expect(automationsFetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("unified-tasks native-complete deadlines", () => {
  beforeEach(() => {
    automationsFetchMock.mockReset();
    scheduledFetchMock.mockReset();
  });

  it("keeps a documented budget per hop", () => {
    expect(UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS).toBe(6_000);
    expect(UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS).toBe(6_000);
  });

  it("passes automations timeoutMs through client.fetch", async () => {
    automationsFetchMock.mockResolvedValue(automationsResponse([]));
    await fetchUnifiedAutomations({ fetch: automationsFetchMock });
    expect(automationsFetchMock).toHaveBeenCalledWith(
      "/api/automations",
      undefined,
      { timeoutMs: UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS },
    );
  });

  it("passes scheduled timeoutMs through client.fetch", async () => {
    scheduledFetchMock.mockResolvedValue(scheduledResponse([scheduledTask()]));
    const listed = await fetchUnifiedScheduledTasks(
      { fetch: scheduledFetchMock },
      true,
    );
    expect(listed.tasks).toHaveLength(1);
    expect(scheduledFetchMock).toHaveBeenCalledWith(
      "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
      undefined,
      { timeoutMs: UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled automations hop as TimeoutError", async () => {
    const timeout = Object.assign(new Error("Request timed out after 10ms"), {
      name: "ApiError",
      kind: "timeout",
    });
    automationsFetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeout), 10);
        }),
    );
    await expect(
      fetchUnifiedAutomations({ fetch: automationsFetchMock }, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed scheduled GET", async () => {
    scheduledFetchMock.mockRejectedValue(
      Object.assign(new Error("Scheduled tasks request failed (503)"), {
        name: "ApiError",
        kind: "http",
        status: 503,
      }),
    );
    await expect(
      fetchUnifiedScheduledTasks({ fetch: scheduledFetchMock }, true),
    ).rejects.toMatchObject({ status: 503 });
  });
});
