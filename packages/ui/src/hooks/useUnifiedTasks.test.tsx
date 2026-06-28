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

// The hook reads the two list endpoints via the typed client — mock both. Each
// is a spy so we can assert the parallel fetch, the per-source degrade, and the
// ownerVisibleOnly default.
const { listAutomationsMock, listScheduledTasksMock } = vi.hoisted(() => ({
  listAutomationsMock: vi.fn(),
  listScheduledTasksMock: vi.fn(),
}));
vi.mock("../api", () => ({
  client: {
    listAutomations: listAutomationsMock,
    listScheduledTasks: listScheduledTasksMock,
  },
}));

import { useUnifiedTasks } from "./useUnifiedTasks";

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
    listAutomationsMock.mockReset();
    listScheduledTasksMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges automations + scheduled tasks into one list and settles loading", async () => {
    listAutomationsMock.mockResolvedValue(automationsResponse([automation]));
    listScheduledTasksMock.mockResolvedValue(
      scheduledResponse([scheduledTask()]),
    );

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    const ids = result.current.state.items.map((i) => i.id);
    expect(ids).toContain("workflow:w-1");
    expect(ids).toContain("scheduled:t-1");
    expect(result.current.state.error).toBeNull();
    // Both sources fetched in parallel.
    expect(listAutomationsMock).toHaveBeenCalledTimes(1);
    expect(listScheduledTasksMock).toHaveBeenCalledTimes(1);
  });

  it("degrades each source independently — one source failing yields empty for it, not an error", async () => {
    listAutomationsMock.mockRejectedValue(new Error("automations not hosted"));
    listScheduledTasksMock.mockResolvedValue(
      scheduledResponse([scheduledTask()]),
    );

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    // The whole hook still resolves; only the failed source is empty.
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.items.map((i) => i.id)).toEqual([
      "scheduled:t-1",
    ]);
  });

  it("settles to empty (never throws) when BOTH sources fail", async () => {
    listAutomationsMock.mockRejectedValue(new Error("down"));
    listScheduledTasksMock.mockRejectedValue(new Error("down"));

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    expect(result.current.state.items).toEqual([]);
    expect(result.current.state.error).toBeNull();
  });

  it("requests owner-visible scheduled tasks by default", async () => {
    listAutomationsMock.mockResolvedValue(automationsResponse([]));
    listScheduledTasksMock.mockResolvedValue(scheduledResponse([]));

    renderHook(() => useUnifiedTasks());
    await waitFor(() =>
      expect(listScheduledTasksMock).toHaveBeenCalledWith({
        ownerVisibleOnly: true,
      }),
    );
  });

  it("honors ownerVisibleOnly: false override", async () => {
    listAutomationsMock.mockResolvedValue(automationsResponse([]));
    listScheduledTasksMock.mockResolvedValue(scheduledResponse([]));

    renderHook(() => useUnifiedTasks({ ownerVisibleOnly: false }));
    await waitFor(() =>
      expect(listScheduledTasksMock).toHaveBeenCalledWith({
        ownerVisibleOnly: false,
      }),
    );
  });

  it("refresh() re-fetches both sources", async () => {
    listAutomationsMock.mockResolvedValue(automationsResponse([]));
    listScheduledTasksMock.mockResolvedValue(scheduledResponse([]));

    const { result } = renderHook(() => useUnifiedTasks());
    await waitFor(() => expect(result.current.state.loading).toBe(false));

    const before = listAutomationsMock.mock.calls.length;
    await result.current.refresh();
    expect(listAutomationsMock.mock.calls.length).toBeGreaterThan(before);
  });
});
