/** Exercises the authenticated, validated agents-list background poll with real React effects. */
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
});

describe("useSandboxStatusPoll", () => {
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
});
