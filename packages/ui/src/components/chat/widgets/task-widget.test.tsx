// @vitest-environment jsdom
//
// TaskWidget: fallback title until the first fetch, then the fetched title /
// status / agents / token count, "Task removed." when the detail fetch is null,
// navigation to /orchestrator on click, and no pulse animation for terminal
// status. jsdom render with the orchestrator task detail fetch mocked (no backend).

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
  client: {
    getCodingAgentTaskThread: getCodingAgentTaskThreadMock,
    // The live pipeline store subscribes to the WS feed; a no-op unsubscribe is
    // enough for the header-only assertions here (stream behavior is covered by
    // task-activity-store.test.ts).
    onWsEvent: () => () => undefined,
  },
}));

import { getInlineWidget } from "./inline-registry";
import { registerTaskWidget, TaskWidget } from "./task-widget";

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

  it("expands the pipeline on header click and navigates via the workbench link", async () => {
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

    // Header click expands the inline pipeline (does NOT navigate away).
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      screen.getByTestId("task-widget").getAttribute("data-expanded"),
    ).toBe("true");
    expect(screen.getByTestId("task-widget-pipeline")).toBeTruthy();
    expect(events).toHaveLength(0);

    // The explicit workbench affordance is what navigates.
    fireEvent.click(screen.getByText("Open in workbench →"));
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

  it("renders a clickable PR chip when task metadata carries a PR link", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({
        status: "done",
        metadata: {
          prUrl: "https://github.com/elizaOS/eliza/pull/16090",
          prNumber: 16090,
          prRepo: "elizaOS/eliza",
        },
      }),
    );
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(screen.getByTestId("task-widget-pr-chip")).toBeTruthy();
    });
    const chip = screen.getByTestId("task-widget-pr-chip");
    expect(chip.getAttribute("href")).toBe(
      "https://github.com/elizaOS/eliza/pull/16090",
    );
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toContain("noreferrer");
    expect(chip.textContent).toContain("#16090");
    expect(chip.getAttribute("title")).toBe("elizaOS/eliza #16090");
  });

  it("derives the PR number from the URL when prNumber is absent", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({
        metadata: { prUrl: "https://github.com/o/r/pull/77" },
      }),
    );
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(screen.getByTestId("task-widget-pr-chip").textContent).toContain(
        "#77",
      );
    });
  });

  it("derives the displayed PR identity from the validated URL", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({
        metadata: {
          prUrl: "https://github.com/canonical/repo/pull/77",
          prNumber: 999,
          prRepo: "spoofed/repo",
        },
      }),
    );
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    const chip = await screen.findByTestId("task-widget-pr-chip");
    expect(chip.textContent).toContain("#77");
    expect(chip.getAttribute("title")).toBe("canonical/repo #77");
  });

  it("renders no PR chip when metadata has no PR link", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(detail());
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(getCodingAgentTaskThreadMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("task-widget-pr-chip")).toBeNull();
  });

  it("rejects a non-GitHub-PR prUrl (chip never renders an arbitrary link)", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({
        metadata: { prUrl: "https://evil.example.com/phish", prNumber: 1 },
      }),
    );
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(getCodingAgentTaskThreadMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("task-widget-pr-chip")).toBeNull();
  });

  it("PR chip click does not toggle the expand/collapse header", async () => {
    getCodingAgentTaskThreadMock.mockResolvedValueOnce(
      detail({
        metadata: { prUrl: "https://github.com/o/r/pull/5", prNumber: 5 },
      }),
    );
    render(<TaskWidget threadId={THREAD_ID} fallbackTitle="Optimistic" />);
    await waitFor(() => {
      expect(screen.getByTestId("task-widget-pr-chip")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("task-widget-pr-chip"));
    expect(
      screen.getByTestId("task-widget").getAttribute("data-expanded"),
    ).toBe("false");
  });
});

// #9304 - task inline-widget registration gate.
//
// The `[TASK:...]` widget is owned by the orchestrator plugin and registered via
// registerTaskWidget() (not auto-loaded). This gate proves that calling it wires
// the "task" kind so a marker actually parses + would render; dropping the
// registration fails CI here.
describe("registerTaskWidget (#9304 registration gate)", () => {
  it("is not registered until registerTaskWidget() is called", () => {
    expect(getInlineWidget("task")).toBeUndefined();
  });

  it("registers the task kind so a [TASK:...] marker parses", () => {
    registerTaskWidget();
    const def = getInlineWidget("task");
    expect(def).toBeDefined();
    const matches =
      def?.parse(`open [TASK:${THREAD_ID}]My task[/TASK] done`) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.data).toMatchObject({ threadId: THREAD_ID });
  });
});
