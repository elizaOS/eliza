/** Exercises sandbox status and authenticated list polling with real React effects and deterministic transport doubles. */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api-client";
import {
  useSandboxListPoll,
  useSandboxStatusPoll,
} from "./use-sandbox-status-poll";

vi.mock("../../lib/api-client", () => ({ api: vi.fn() }));

const mockedApi = vi.mocked(api);

function agent(status: "provisioning" | "running") {
  return {
    id: "agent-1",
    agentName: "Ada",
    status,
    databaseStatus: "ready",
    lastBackupAt: null,
    lastHeartbeatAt: null,
    errorMessage: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
    dockerImage: null,
    executionTier: "dedicated-lazy",
    webUiUrl: "https://agent.example",
  } as const;
}

beforeEach(() => {
  mockedApi.mockReset();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSandboxListPoll", () => {
  it("uses the authenticated API client, validates the DTO, and reports a running transition", async () => {
    const onDataRefresh = vi.fn();
    const onTransitionToRunning = vi.fn();
    mockedApi.mockResolvedValue({ success: true, data: [agent("running")] });

    renderHook(() =>
      useSandboxListPoll([{ id: "agent-1", status: "provisioning" }], {
        intervalMs: 60_000,
        onDataRefresh,
        onTransitionToRunning,
      }),
    );

    await waitFor(() => expect(onDataRefresh).toHaveBeenCalledOnce());
    expect(mockedApi).toHaveBeenCalledWith(
      "/api/v1/eliza/agents",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onDataRefresh).toHaveBeenCalledWith([agent("running")]);
    expect(onTransitionToRunning).toHaveBeenCalledWith("agent-1", "Ada");
  });

  it("keeps the current list when the refresh payload is malformed", async () => {
    const onDataRefresh = vi.fn();
    mockedApi.mockResolvedValue({
      success: true,
      data: [{ id: "agent-1", status: "running" }],
    });

    renderHook(() =>
      useSandboxListPoll([{ id: "agent-1", status: "provisioning" }], {
        intervalMs: 60_000,
        onDataRefresh,
      }),
    );

    await waitFor(() => expect(mockedApi).toHaveBeenCalledOnce());
    expect(onDataRefresh).not.toHaveBeenCalled();
  });

  it("aborts and ignores an old request when active polling stops", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    mockedApi.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const onDataRefresh = vi.fn();
    const { rerender } = renderHook(
      ({ status }: { status: "provisioning" | "running" }) =>
        useSandboxListPoll([{ id: "agent-1", status }], {
          intervalMs: 60_000,
          onDataRefresh,
        }),
      {
        initialProps: {
          status: "provisioning",
        } as { status: "provisioning" | "running" },
      },
    );

    await waitFor(() => expect(mockedApi).toHaveBeenCalledOnce());
    const signal = mockedApi.mock.calls[0]?.[1]?.signal;
    rerender({ status: "running" });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolveRequest?.({ success: true, data: [agent("running")] });
      await Promise.resolve();
    });
    expect(onDataRefresh).not.toHaveBeenCalled();
  });

  it("aborts a hung status fetch at the per-poll timeout instead of leaving isLoading pinned", async () => {
    // An agent-status endpoint that never settles on its own: the only way out
    // is the caller's AbortSignal firing (the per-poll `AbortSignal.timeout(10s)`).
    // Note: Node's AbortSignal.timeout uses an internal timer that vitest fake
    // timers cannot drive, so back it with the faked global setTimeout here.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const hungFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    vi.stubGlobal("fetch", hungFetch);
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSandboxStatusPoll("agent-1", { intervalMs: 60_000 }),
    );

    // First poll hop is in flight and pinned as loading.
    await act(async () => {
      await Promise.resolve();
    });
    expect(hungFetch).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    // The per-poll 10s bound aborts the hung hop; the error path clears
    // isLoading instead of leaving the progress view stuck forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(hungFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useSandboxStatusPoll", () => {
  it("ignores a stale terminal response and keeps replacement polling active", async () => {
    vi.useFakeTimers();
    let resolveAgentA: ((response: Response) => void) | undefined;
    let resolveAgentBFirst: ((response: Response) => void) | undefined;
    let resolveAgentBNext: ((response: Response) => void) | undefined;
    const requestSignals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce((_input, init) => {
        requestSignals.push(init?.signal);
        return new Promise((resolve) => {
          resolveAgentA = resolve;
        });
      })
      .mockImplementationOnce((_input, init) => {
        requestSignals.push(init?.signal);
        return new Promise((resolve) => {
          resolveAgentBFirst = resolve;
        });
      })
      .mockImplementationOnce((_input, init) => {
        requestSignals.push(init?.signal);
        return new Promise((resolve) => {
          resolveAgentBNext = resolve;
        });
      });

    const { result, rerender, unmount } = renderHook(
      ({ agentId }) => useSandboxStatusPoll(agentId, { intervalMs: 1_000 }),
      { initialProps: { agentId: "agent-a" } },
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    rerender({ agentId: "agent-b" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestSignals[0]?.aborted).toBe(true);

    await act(async () => {
      resolveAgentBFirst?.(
        Response.json({
          data: { status: "provisioning", lastHeartbeatAt: null },
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.status).toBe("provisioning");

    await act(async () => {
      resolveAgentA?.(
        Response.json({
          data: { status: "running", lastHeartbeatAt: null },
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.status).toBe("provisioning");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.lastCall?.[0]).toBe("/api/v1/eliza/agents/agent-b");

    unmount();
    expect(requestSignals[2]?.aborted).toBe(true);
    await act(async () => {
      resolveAgentBNext?.(
        Response.json({ data: { status: "running", lastHeartbeatAt: null } }),
      );
      await Promise.resolve();
    });
  });

  it("keeps an active request alive across interval ticks until its deadline", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((response: Response) => void) | undefined;
    const requestSignals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce((_input, init) => {
        requestSignals.push(init?.signal);
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce(
        Response.json({
          data: { status: "running", lastHeartbeatAt: null },
        }),
      );

    const { result, unmount } = renderHook(() =>
      useSandboxStatusPoll("agent-a", { intervalMs: 1_000 }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestSignals[0]?.aborted).toBe(false);

    await act(async () => {
      resolveFirst?.(
        Response.json({
          data: { status: "provisioning", lastHeartbeatAt: null },
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.status).toBe("provisioning");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("running");
    unmount();
  });

  it("reports why a status poll failed instead of leaving the reason blank", async () => {
    // The !res.ok branch reports `HTTP <status>`, but a rejected request had no
    // status and previously left `error` null — indistinguishable from a status
    // that simply has not loaded yet.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("network down"),
    );

    const { result, unmount } = renderHook(() =>
      useSandboxStatusPoll("agent-a", { intervalMs: 60_000 }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeTruthy();
    expect(result.current.status).not.toBe("running");
    unmount();
  });

  it("starts polling a replacement agent after the previous agent reached a terminal state", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { status: "running", lastHeartbeatAt: null },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { status: "provisioning", lastHeartbeatAt: null },
          }),
          { status: 200 },
        ),
      );

    const { result, rerender } = renderHook(
      ({ agentId }) => useSandboxStatusPoll(agentId, { intervalMs: 60_000 }),
      { initialProps: { agentId: "agent-a" } },
    );

    await waitFor(() => expect(result.current.status).toBe("running"));
    rerender({ agentId: "agent-b" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.lastCall?.[0]).toBe("/api/v1/eliza/agents/agent-b");
    await waitFor(() => expect(result.current.status).toBe("provisioning"));
  });

  // The previous agent's terminal status must not be attributed to the new one.
  // Resetting only the ref left the visible result untouched, so if agent-b's
  // first fetch failed the catch merely bumped an error counter and agent-a's
  // "running" stayed on screen indefinitely — a status we never loaded
  // rendering as a healthy one we did.
  it("clears a previous agent's status when the polled agent changes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { status: "running", lastHeartbeatAt: null },
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValue(new Error("agent-b is unreachable"));

    const { result, rerender } = renderHook(
      ({ agentId }) => useSandboxStatusPoll(agentId, { intervalMs: 60_000 }),
      { initialProps: { agentId: "agent-a" } },
    );

    await waitFor(() => expect(result.current.status).toBe("running"));

    rerender({ agentId: "agent-b" });

    await waitFor(() => expect(result.current.status).not.toBe("running"));
    expect(result.current.status).toBe("pending");
    expect(result.current.lastHeartbeat).toBeNull();
  });
});
