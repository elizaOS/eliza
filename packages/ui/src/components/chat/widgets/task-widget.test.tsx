// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentTaskThreadDetail } from "../../../api/client-types-cloud";

const { getCodingAgentTaskThreadMock } = vi.hoisted(() => ({
  getCodingAgentTaskThreadMock: vi.fn(),
}));

vi.mock("../../../api/client", () => ({
  client: { getCodingAgentTaskThread: getCodingAgentTaskThreadMock },
}));

import { TaskWidget } from "./task-widget";

const THREAD_ID = "0123abcd-1234-5678-9abc-deadbeefcafe";

function detail(
  overrides: Partial<CodingAgentTaskThreadDetail> = {},
): CodingAgentTaskThreadDetail {
  return {
    id: THREAD_ID,
    title: "Build planner",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "",
    summary: null,
    goal: "",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    sessionCount: 2,
    activeSessionCount: 2,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: Date.now() - 60_000,
    decisionCount: 0,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 1234,
      costUsd: 0,
      state: "estimated",
      usageState: "estimated",
      byProvider: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    archivedAt: null,
    ...overrides,
  } as CodingAgentTaskThreadDetail;
}

describe("TaskWidget", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    getCodingAgentTaskThreadMock.mockReset();
  });

  it("renders the fallback title until the first fetch resolves", () => {
    getCodingAgentTaskThreadMock.mockReturnValue(new Promise(() => undefined));
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    expect(screen.getByTestId("task-widget").textContent).toContain(
      "Optimistic",
    );
  });

  it("renders fetched title, status, agents, and token count", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(detail());
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(screen.getByTestId("task-widget").textContent).toContain(
        "Build planner",
      );
    });
    const widget = screen.getByTestId("task-widget");
    expect(widget.getAttribute("data-task-status")).toBe("active");
    const status = screen.getByTestId("task-widget-status");
    expect(status.textContent).toContain("active");
    expect(status.textContent).toContain("2/2 agents");
    expect(status.textContent).toContain("1.2K");
  });

  it("renders 'Task removed.' when the detail fetch returns null", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(null);
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(
        screen.getByTestId("task-widget").getAttribute("data-removed"),
      ).toBe("true");
    });
    expect(screen.getByTestId("task-widget").textContent).toContain(
      "Task removed.",
    );
  });

  it("dispatches eliza:navigate:view to /orchestrator when clicked", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(detail());
    const events: CustomEvent[] = [];
    const handler = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener("eliza:navigate:view", handler);

    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(screen.getByTestId("task-widget").textContent).toContain(
        "Build planner",
      );
    });

    fireEvent.click(screen.getByTestId("task-widget"));
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      viewPath: `/orchestrator?taskId=${THREAD_ID}`,
    });

    window.removeEventListener("eliza:navigate:view", handler);
  });

  it("renders terminal status without the pulse animation", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({ status: "done" }),
    );
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(
        screen.getByTestId("task-widget").getAttribute("data-task-status"),
      ).toBe("done");
    });
    expect(
      screen.getByTestId("task-widget").querySelector(".animate-pulse"),
    ).toBeNull();
  });

  it("does not render the password value or sensitive details in chat", async () => {
    // Sanity guard: the widget only renders status fields, never message text
    // or arbitrary metadata, so this protects against future drift.
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({ metadata: { secret: "super-secret-value" } }),
    );
    const { container } = render(
      <TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />,
    );
    await waitFor(() => {
      expect(getCodingAgentTaskThreadMock).toHaveBeenCalledTimes(1);
    });
    expect(container.textContent?.includes("super-secret-value")).toBe(false);
  });
});
