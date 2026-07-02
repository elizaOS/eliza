// @vitest-environment jsdom
//
// CockpitSessionPane is the cockpit's drill-in surface — a pure composition of
// the orchestrator workbench's live-data layer (useOrchestratorData), the
// flowing transcript (buildConversation → ConversationBlockView), and the full
// TaskInspector action bar, plus the floating-composer bubble binding that
// routes the composer to THIS task's room.
//
// This drives it the same way use-orchestrator-data.test.ts does: mock ONLY the
// `client` boundary (the live orchestrator) and feed a detail + a timeline page
// (user + sub-agent turns, a tool-with-diff event, a reasoning event), then
// assert the rendered transcript, that the inspector's Pause routes to the
// client, that Back returns to the deck, and that the registered onSubmit posts
// to the task room.
//
// Note: unlike use-orchestrator-data.test.ts (which FULLY mocks @elizaos/ui to
// just `{ client }`), this partial-mocks it — TaskInspector pulls real
// components (AlertDialog, etc.) from the barrel, so we keep every real export
// and override only `client`. The agent-surface hook is stubbed exactly as the
// existing TaskInspector test does.

import type {
  CodingAgentTaskThreadDetail,
  CodingAgentTaskTimelineItem,
} from "@elizaos/ui";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The REAL ELIZA_CLOUD_TIER_MODEL currently maps BOTH tiers to the same
// Cerebras model (no smart model has shipped), which makes the pane hide the
// Fast/Smart toggle. Mock it as a mutable record so the flip test can exercise
// divergent tiers and the collapse test can exercise identical ones.
const tierModels = vi.hoisted(() => ({
  small: "gemma-4-31b",
  large: "qwen-3-huge",
}));

const calls = {
  getOrchestratorStatus: vi.fn(),
  listCodingAgentTaskThreads: vi.fn(),
  getCodingAgentTaskThread: vi.fn(),
  listOrchestratorTaskTimeline: vi.fn(),
  streamOrchestratorTask: vi.fn(),
  pauseOrchestratorTask: vi.fn(),
  postOrchestratorTaskMessage: vi.fn(),
  getCodingAgentStatus: vi.fn(),
  updateOrchestratorTask: vi.fn(),
  addOrchestratorAgent: vi.fn(),
  restartOrchestratorTask: vi.fn(),
};

// TaskInspector wires a couple of agent elements (close button + priority
// select) and only needs `ref` + `agentProps` back; the production hook is a
// registration side effect for the agent overlay.
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

// Partial mock: keep every REAL @elizaos/ui export (TaskInspector renders
// AlertDialog/DiffReviewPanel/… from the barrel) and override only `client`.
vi.mock("@elizaos/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ELIZA_CLOUD_TIER_MODEL: tierModels,
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
      pauseOrchestratorTask: (id: string) => calls.pauseOrchestratorTask(id),
      postOrchestratorTaskMessage: (id: string, content: string) =>
        calls.postOrchestratorTaskMessage(id, content),
      getCodingAgentStatus: () => calls.getCodingAgentStatus(),
      updateOrchestratorTask: (id: string, patch: unknown) =>
        calls.updateOrchestratorTask(id, patch),
      addOrchestratorAgent: (id: string, input: unknown) =>
        calls.addOrchestratorAgent(id, input),
      restartOrchestratorTask: (id: string, input: unknown) =>
        calls.restartOrchestratorTask(id, input),
    },
  };
});

import { getViewChatBinding } from "@elizaos/ui";
import { CockpitSessionPane } from "./CockpitSessionPane";

const ISO = "2026-01-01T00:00:00.000Z";

const baseUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  state: "unavailable" as const,
  usageState: "unavailable" as const,
  byProvider: [],
  metadata: {},
  createdAt: ISO,
  updatedAt: ISO,
};

const session = {
  id: "row-sess-1",
  threadId: "task-1",
  sessionId: "sess-1",
  framework: "codex",
  providerSource: "openai",
  model: "gpt-5.5",
  label: "Primary worker",
  originalTask: "do the work",
  workdir: "/repo/app",
  repo: "owner/app",
  status: "active",
  activeTool: null,
  decisionCount: 0,
  autoResolvedCount: 0,
  registeredAt: 1,
  lastActivityAt: 100,
  idleCheckCount: 0,
  taskDelivered: true,
  completionSummary: null,
  lastSeenDecisionIndex: 0,
  lastInputSentAt: null,
  stoppedAt: null,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  cacheTokens: 0,
  costUsd: 0,
  usageState: "unavailable",
  metadata: {},
  createdAt: ISO,
  updatedAt: ISO,
};

const detailFixture = {
  id: "task-1",
  title: "Fix the failing build",
  kind: "coding",
  status: "active",
  priority: "normal",
  paused: false,
  originalRequest: "Build is red",
  summary: "",
  sessionCount: 1,
  activeSessionCount: 1,
  latestSessionId: "sess-1",
  latestSessionLabel: "Primary worker",
  latestWorkdir: "/repo/app",
  latestRepo: "owner/app",
  latestActivityAt: 100,
  decisionCount: 0,
  // biome-ignore lint/suspicious/noExplicitAny: typed inline at the test boundary
  usage: baseUsage as any,
  createdAt: ISO,
  updatedAt: ISO,
  closedAt: null,
  archivedAt: null,
  goal: "Make CI green",
  roomId: null,
  taskRoomId: null,
  worldId: null,
  ownerUserId: null,
  parentTaskId: null,
  acceptanceCriteria: [],
  currentPlan: null,
  providerPolicy: null,
  lastUserTurnAt: null,
  lastCoordinatorTurnAt: null,
  metadata: {},
  // biome-ignore lint/suspicious/noExplicitAny: typed inline at the test boundary
  sessions: [session as any],
  decisions: [],
  events: [],
  artifacts: [],
  messages: [],
  transcripts: [],
  planRevisions: [],
} as unknown as CodingAgentTaskThreadDetail;

// A timeline page exercising every conversation block kind the pane renders:
// a user turn, a reasoning cell, a tool card carrying a real +/- diff, and a
// sub-agent (agent) turn.
const timelineItems: CodingAgentTaskTimelineItem[] = [
  {
    id: "tl-user",
    kind: "message",
    threadId: "task-1",
    sessionId: null,
    timestamp: 1000,
    createdAt: ISO,
    message: {
      id: "m-user",
      threadId: "task-1",
      sessionId: null,
      senderKind: "user",
      direction: "stdin",
      content: "Please fix the failing build",
      timestamp: 1000,
      metadata: {},
      createdAt: ISO,
    },
  },
  {
    id: "tl-reason",
    kind: "event",
    threadId: "task-1",
    sessionId: "sess-1",
    timestamp: 1500,
    createdAt: ISO,
    event: {
      id: "e-reason",
      threadId: "task-1",
      sessionId: "sess-1",
      eventType: "reasoning",
      timestamp: 1500,
      summary: "",
      data: { text: "I should inspect the build script first." },
      createdAt: ISO,
    },
  },
  {
    id: "tl-tool",
    kind: "event",
    threadId: "task-1",
    sessionId: "sess-1",
    timestamp: 2000,
    createdAt: ISO,
    event: {
      id: "e-tool",
      threadId: "task-1",
      sessionId: "sess-1",
      eventType: "tool_call",
      timestamp: 2000,
      summary: "",
      data: {
        toolCall: {
          id: "call-1",
          title: "edit",
          kind: "edit",
          status: "completed",
          rawInput: {
            filePath: "src/build.ts",
            old_string: "const x = 1",
            new_string: "const x = 2",
          },
        },
      },
      createdAt: ISO,
    },
  },
  {
    id: "tl-agent",
    kind: "message",
    threadId: "task-1",
    sessionId: "sess-1",
    timestamp: 2500,
    createdAt: ISO,
    message: {
      id: "m-agent",
      threadId: "task-1",
      sessionId: "sess-1",
      senderKind: "sub_agent",
      direction: "stdout",
      content: "Fixed the constant and re-ran the build.",
      timestamp: 2500,
      metadata: {},
      createdAt: ISO,
    },
  },
];

beforeEach(() => {
  // Divergent tiers by default (the flip test needs a real choice); the
  // collapse test overrides this per-case.
  tierModels.small = "gemma-4-31b";
  tierModels.large = "qwen-3-huge";
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.getOrchestratorStatus.mockResolvedValue({ taskCount: 1 });
  calls.listCodingAgentTaskThreads.mockResolvedValue([
    { id: "task-1", status: "active" },
  ]);
  calls.getCodingAgentTaskThread.mockResolvedValue(detailFixture);
  calls.listOrchestratorTaskTimeline.mockResolvedValue({
    items: timelineItems,
    nextCursor: null,
  });
  calls.streamOrchestratorTask.mockReturnValue(() => undefined);
  calls.pauseOrchestratorTask.mockResolvedValue(true);
  calls.postOrchestratorTaskMessage.mockResolvedValue(undefined);
  calls.getCodingAgentStatus.mockResolvedValue({ tasks: [] });
  calls.updateOrchestratorTask.mockResolvedValue(detailFixture);
  calls.addOrchestratorAgent.mockResolvedValue(detailFixture);
  calls.restartOrchestratorTask.mockResolvedValue(detailFixture);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPane() {
  const onBack = vi.fn();
  const utils = render(<CockpitSessionPane taskId="task-1" onBack={onBack} />);
  return { ...utils, onBack };
}

describe("CockpitSessionPane — drill-in (client mocked at the boundary)", () => {
  it("loads the room and renders the full transcript (user, agent, tool diff, reasoning)", async () => {
    renderPane();

    // The selected task's detail + timeline are fetched on mount.
    await waitFor(() =>
      expect(calls.getCodingAgentTaskThread).toHaveBeenCalledWith("task-1"),
    );

    // Every conversation block kind renders via ConversationBlockView.
    await waitFor(() =>
      expect(screen.getByTestId("orchestrator-user-message")).toBeTruthy(),
    );
    expect(screen.getByTestId("orchestrator-agent-message")).toBeTruthy();
    expect(screen.getByTestId("orchestrator-tool-call")).toBeTruthy();
    // The edit tool card opens by default and renders a real +/- diff.
    expect(screen.getByTestId("orchestrator-diff")).toBeTruthy();
    expect(screen.getByTestId("orchestrator-reasoning")).toBeTruthy();

    // The room title is shown in the back-header.
    expect(screen.getByText("Fix the failing build")).toBeTruthy();
  });

  it("Pause routes through the client to this task", async () => {
    renderPane();
    const pause = await screen.findByTestId("orchestrator-inspector-pause");
    fireEvent.click(pause);
    await waitFor(() =>
      expect(calls.pauseOrchestratorTask).toHaveBeenCalledWith("task-1"),
    );
  });

  it("Back returns to the deck (calls onBack)", async () => {
    const { onBack } = renderPane();
    const back = await screen.findByTestId("cockpit-session-back");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("registers a bubble binding whose onSubmit posts to this task room", async () => {
    renderPane();
    // The binding is registered in an effect; wait for the transcript to settle.
    await waitFor(() =>
      expect(screen.getByTestId("orchestrator-user-message")).toBeTruthy(),
    );

    const binding = getViewChatBinding();
    expect(binding?.placeholder).toContain("Fix the failing build");
    // onSubmit consumes the send (returns true) and routes to the room.
    expect(binding?.onSubmit?.("hi")).toBe(true);
    expect(calls.postOrchestratorTaskMessage).toHaveBeenCalledWith(
      "task-1",
      "hi",
    );
  });

  it("toggles to the terminal (real-CLI) view", async () => {
    renderPane();
    await screen.findByTestId("cockpit-session-transcript");
    fireEvent.click(screen.getByTestId("cockpit-view-terminal"));
    // With no matching PTY sessions for this task the panel shows its empty
    // state (no xterm construction); the transcript is swapped out.
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-session-terminal")).toBeTruthy(),
    );
    expect(screen.queryByTestId("cockpit-session-transcript")).toBeNull();
  });

  it("Eliza Cloud: flipping the tier persists policy + RESTARTS (stops old worker, no agent accumulation)", async () => {
    calls.getCodingAgentTaskThread.mockResolvedValue({
      ...detailFixture,
      providerPolicy: {
        preferredFramework: "elizaos",
        providerSource: "eliza-cloud",
        model: "gemma-4-31b",
      },
    });
    renderPane();
    const smart = await screen.findByTestId("cockpit-tier-large");
    fireEvent.click(smart);
    // 1. persist the new tier's model on the task policy
    await waitFor(() =>
      expect(calls.updateOrchestratorTask).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({
          providerPolicy: expect.objectContaining({ model: tierModels.large }),
        }),
      ),
    );
    // 2. RESTART with stopActive (replaces the worker) — NOT addOrchestratorAgent
    // (which would accumulate live agents on repeated flips — Shaw's review).
    await waitFor(() =>
      expect(calls.restartOrchestratorTask).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ stopActive: true }),
      ),
    );
    expect(calls.addOrchestratorAgent).not.toHaveBeenCalled();
  });

  it("Eliza Cloud: hides the tier toggle when both tiers lower to the SAME model (no destructive placebo restart)", async () => {
    // Mirror today's production reality: no smart model has shipped, so
    // small === large. Offering the toggle would persist an identical policy
    // and restart({stopActive:true}) — killing the live worker for nothing.
    tierModels.large = tierModels.small;
    calls.getCodingAgentTaskThread.mockResolvedValue({
      ...detailFixture,
      providerPolicy: {
        preferredFramework: "elizaos",
        providerSource: "eliza-cloud",
        model: tierModels.small,
      },
    });
    renderPane();
    // The pane is fully loaded (title + transcript rendered)…
    await waitFor(() =>
      expect(screen.getByTestId("orchestrator-user-message")).toBeTruthy(),
    );
    // …but neither tier segment exists, so no flip (and no restart) can fire.
    expect(screen.queryByTestId("cockpit-tier-small")).toBeNull();
    expect(screen.queryByTestId("cockpit-tier-large")).toBeNull();
    expect(calls.updateOrchestratorTask).not.toHaveBeenCalled();
    expect(calls.restartOrchestratorTask).not.toHaveBeenCalled();
  });

  it("surfaces a failed inspector action as an alert banner (actionError is not silent)", async () => {
    calls.pauseOrchestratorTask.mockRejectedValue(new Error("pause exploded"));
    renderPane();
    const pause = await screen.findByTestId("orchestrator-inspector-pause");
    fireEvent.click(pause);
    // runMutation catches (does NOT rethrow) and stores the message as
    // actionError — the pane must render it or every failed action is silent.
    const banner = await screen.findByTestId("cockpit-session-action-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("pause exploded");
  });

  it("surfaces an error when a composer-driven message fails to deliver", async () => {
    calls.postOrchestratorTaskMessage.mockRejectedValue(new Error("offline"));
    renderPane();
    await waitFor(() =>
      expect(screen.getByTestId("orchestrator-user-message")).toBeTruthy(),
    );
    const binding = getViewChatBinding();
    // onSubmit still consumes the send (returns true) — but a failed delivery
    // must surface, not vanish silently (Shaw's review).
    expect(binding?.onSubmit?.("hi")).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-session-error").textContent).toMatch(
        /deliver/i,
      ),
    );
  });
});

describe("CockpitSessionPane — inspector layout per surface (#11159 audit)", () => {
  // jsdom has no window.matchMedia, so useIsMobile() is false by default —
  // that IS the desktop case. The mobile case stubs a matching MQL.
  function stubMobileMatchMedia(): void {
    const mql = {
      matches: true,
      media: "(max-width: 767px)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", () => mql);
  }

  it("desktop keeps TaskInspector's w-80 rail fallback (no unconditional class override)", async () => {
    renderPane();
    const inspector = await screen.findByTestId("orchestrator-inspector");
    // Passing className="flex" unconditionally suppressed the `flex w-80`
    // fallback; in this flex ROW the shrink-0 inspector then inflated to
    // max-content and crushed the transcript on desktop.
    expect(inspector.className).toContain("w-80");
  });

  it("mobile overrides the rail with the dismissible drawer", async () => {
    stubMobileMatchMedia();
    try {
      renderPane();
      const inspector = await screen.findByTestId("orchestrator-inspector");
      expect(inspector.className).not.toContain("w-80");
      // Drawer geometry comes from the inline style (closed => hidden).
      expect(
        inspector.style.display === "none" ||
          inspector.style.position === "absolute",
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
