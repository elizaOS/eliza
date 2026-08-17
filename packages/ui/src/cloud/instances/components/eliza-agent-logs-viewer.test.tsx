/** Verifies the agent-log viewer's loading, error, cancellation, and stale-request behavior with a mocked transport boundary. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadAgentLogs } = vi.hoisted(() => ({
  loadAgentLogs: vi.fn(),
}));

vi.mock("../lib/agent-logs", () => ({
  loadAgentLogs,
  isAbortError: (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

vi.mock("@elizaos/ui/cloud-ui", () => ({
  LogViewer: (props: {
    childrenBeforeSearch?: ReactNode;
    loading: boolean;
    error: string | null;
    lines: string[];
    onRefresh: () => void;
  }) => (
    <section>
      <span data-testid="loading">{String(props.loading)}</span>
      {props.error && <div role="alert">{props.error}</div>}
      {props.childrenBeforeSearch}
      <output data-testid="lines">{props.lines.join("|")}</output>
      <button type="button" onClick={props.onRefresh}>
        Refresh logs
      </button>
    </section>
  ),
}));

import { ElizaAgentLogsViewer } from "./eliza-agent-logs-viewer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ElizaAgentLogsViewer", () => {
  beforeEach(() => {
    loadAgentLogs.mockReset();
  });

  afterEach(() => cleanup());

  it("renders validated logs and a separate informational notice", async () => {
    loadAgentLogs.mockResolvedValue({
      logs: "first\nsecond",
      notice: "Collected from the most recent container run.",
    });

    render(
      <ElizaAgentLogsViewer
        agentId="agent-1"
        agentName="Eliza"
        status="running"
      />,
    );

    expect(screen.getByTestId("loading").textContent).toBe("true");
    await waitFor(() => {
      expect(screen.getByTestId("lines").textContent).toBe("first|second");
    });
    expect(
      screen.getByText("Collected from the most recent container run."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a retryable error instead of successful log content", async () => {
    loadAgentLogs.mockRejectedValue(
      new Error("Log collection is taking longer than expected."),
    );

    render(
      <ElizaAgentLogsViewer
        agentId="agent-1"
        agentName="Eliza"
        status="running"
      />,
    );

    expect(
      await screen.findByText("Log collection is taking longer than expected."),
    ).toBeTruthy();
    expect(screen.getByTestId("lines").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeTruthy();
  });

  it("renders an unavailable agent result as an error, never healthy empty logs", async () => {
    loadAgentLogs.mockRejectedValue(
      new Error(
        "This agent is no longer available. Refresh the agent list and try again.",
      ),
    );

    render(
      <ElizaAgentLogsViewer
        agentId="agent-gone"
        agentName="Deleted agent"
        status="running"
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This agent is no longer available. Refresh the agent list and try again.",
    );
    expect(screen.getByTestId("lines").textContent).toBe("");
    expect(screen.queryByText("No logs available yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh logs" })).toBeTruthy();
  });

  it("aborts a superseded request and ignores its stale completion", async () => {
    const first = deferred<{ logs: string; notice: null }>();
    const second = deferred<{ logs: string; notice: null }>();
    loadAgentLogs
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(
      <ElizaAgentLogsViewer
        agentId="agent-1"
        agentName="Eliza"
        status="running"
      />,
    );
    await waitFor(() => expect(loadAgentLogs).toHaveBeenCalledTimes(1));
    const firstSignal = loadAgentLogs.mock.calls[0]?.[0].signal as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "Refresh logs" }));
    await waitFor(() => expect(loadAgentLogs).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    first.resolve({ logs: "stale", notice: null });
    second.resolve({ logs: "current", notice: null });
    await waitFor(() => {
      expect(screen.getByTestId("lines").textContent).toBe("current");
    });
    expect(screen.queryByText("stale")).toBeNull();
  });

  it("clears old logs before a refresh can fail", async () => {
    const refresh = deferred<{ logs: string; notice: null }>();
    loadAgentLogs
      .mockResolvedValueOnce({ logs: "previous secret", notice: null })
      .mockReturnValueOnce(refresh.promise);

    render(
      <ElizaAgentLogsViewer
        agentId="agent-1"
        agentName="Eliza"
        status="running"
      />,
    );
    await screen.findByText("previous secret");

    fireEvent.click(screen.getByRole("button", { name: "Refresh logs" }));
    await waitFor(() => expect(loadAgentLogs).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("lines").textContent).toBe("");

    refresh.reject(new Error("Refresh failed"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Refresh failed",
    );
    expect(screen.getByTestId("lines").textContent).toBe("");
  });

  it("never presents one agent's logs after the requested agent changes", async () => {
    const nextAgent = deferred<{ logs: string; notice: null }>();
    loadAgentLogs
      .mockResolvedValueOnce({ logs: "agent one secret", notice: null })
      .mockReturnValueOnce(nextAgent.promise);
    const view = render(
      <ElizaAgentLogsViewer
        agentId="agent-1"
        agentName="First"
        status="running"
      />,
    );
    await screen.findByText("agent one secret");

    view.rerender(
      <ElizaAgentLogsViewer
        agentId="agent-2"
        agentName="Second"
        status="running"
      />,
    );
    expect(screen.getByTestId("lines").textContent).toBe("");
    await waitFor(() => expect(loadAgentLogs).toHaveBeenCalledTimes(2));

    nextAgent.resolve({ logs: "agent two current", notice: null });
    await screen.findByText("agent two current");
    expect(screen.queryByText("agent one secret")).toBeNull();
  });

  it("aborts in-flight work on unmount", async () => {
    const pending = deferred<{ logs: string; notice: null }>();
    loadAgentLogs.mockReturnValue(pending.promise);
    const view = render(
      <ElizaAgentLogsViewer
        agentId="agent-1"
        agentName="Eliza"
        status="running"
      />,
    );
    await waitFor(() => expect(loadAgentLogs).toHaveBeenCalledTimes(1));
    const signal = loadAgentLogs.mock.calls[0]?.[0].signal as AbortSignal;

    view.unmount();
    expect(signal.aborted).toBe(true);
    pending.resolve({ logs: "late", notice: null });
  });
});
