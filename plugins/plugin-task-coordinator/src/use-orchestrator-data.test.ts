// @vitest-environment jsdom
//
// Wrapper test for the orchestrator workbench's live-data layer (#9960).
// Exercises useOrchestratorData in isolation against a mocked client:
// list+status on mount, detail+timeline on
// selection, the loud-failure (actionError) path of runMutation, and timeline
// paging.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = {
  getOrchestratorStatus: vi.fn(),
  listCodingAgentTaskThreads: vi.fn(),
  getCodingAgentTaskThread: vi.fn(),
  listOrchestratorTaskTimeline: vi.fn(),
  streamOrchestratorTask: vi.fn(),
};

vi.mock("@elizaos/ui", () => ({
  client: {
    getOrchestratorStatus: () => calls.getOrchestratorStatus(),
    listCodingAgentTaskThreads: (o: unknown) =>
      calls.listCodingAgentTaskThreads(o),
    getCodingAgentTaskThread: (id: string) =>
      calls.getCodingAgentTaskThread(id),
    listOrchestratorTaskTimeline: (id: string, o: unknown) =>
      calls.listOrchestratorTaskTimeline(id, o),
    streamOrchestratorTask: (id: string, cb: () => void) =>
      calls.streamOrchestratorTask(id, cb),
  },
}));

import { useOrchestratorData } from "./use-orchestrator-data";

const t = (_k: string, vars?: { defaultValue?: string }) =>
  vars?.defaultValue ?? _k;

const baseInput = {
  selectedId: null as string | null,
  showArchived: false,
  statusFilter: "all" as const,
  deferredSearch: "",
  t,
};

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.getOrchestratorStatus.mockResolvedValue({ taskCount: 2 });
  calls.listCodingAgentTaskThreads.mockResolvedValue([
    { id: "task-1", status: "active" },
    { id: "task-2", status: "done" },
  ]);
  calls.getCodingAgentTaskThread.mockResolvedValue({
    id: "task-1",
    status: "active",
    activeSessionCount: 1,
    sessions: [],
  });
  calls.listOrchestratorTaskTimeline.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  calls.streamOrchestratorTask.mockReturnValue(() => undefined);
});

afterEach(() => vi.clearAllMocks());

describe("useOrchestratorData (#9960)", () => {
  it("loads status + tasks on mount", async () => {
    const { result } = renderHook(() => useOrchestratorData(baseInput));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual({ taskCount: 2 });
    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.backendAbsent).toBe(false);
    expect(calls.listCodingAgentTaskThreads).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: false }),
    );
  });

  it("surfaces backendAbsent (not an error) on a 404", async () => {
    calls.getOrchestratorStatus.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const { result } = renderHook(() => useOrchestratorData(baseInput));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.backendAbsent).toBe(true);
    expect(result.current.loadError).toBeNull();
  });

  it("loads detail + timeline when a task is selected", async () => {
    const { result, rerender } = renderHook(
      (props: typeof baseInput) => useOrchestratorData(props),
      { initialProps: baseInput },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ ...baseInput, selectedId: "task-1" });
    await waitFor(() => expect(result.current.detail?.id).toBe("task-1"));
    expect(calls.getCodingAgentTaskThread).toHaveBeenCalledWith("task-1");
    expect(calls.streamOrchestratorTask).toHaveBeenCalledWith(
      "task-1",
      expect.any(Function),
    );
  });

  it("clears detail when the selection is cleared", async () => {
    const { result, rerender } = renderHook(
      (props: typeof baseInput) => useOrchestratorData(props),
      { initialProps: { ...baseInput, selectedId: "task-1" } },
    );
    await waitFor(() => expect(result.current.detail?.id).toBe("task-1"));
    rerender(baseInput);
    await waitFor(() => expect(result.current.detail).toBeNull());
  });

  it("runMutation surfaces actionError loudly on failure", async () => {
    const { result } = renderHook(() => useOrchestratorData(baseInput));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runMutation(async () => {
        throw new Error("boom");
      });
    });
    expect(result.current.actionError).toBe("boom");
    expect(result.current.mutating).toBe(false);
  });
});
