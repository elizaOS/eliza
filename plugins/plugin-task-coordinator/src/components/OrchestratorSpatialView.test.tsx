// Pins the one-source/three-modality contract of OrchestratorSpatialView: the
// TUI render honors the terminal width budget (via renderViewToLines), and the
// GUI/XR DOM render exposes the enriched action bar with XR scaled up.
// Deterministic — typed snapshot in, rendered primitives out, no live model.
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type OrchestratorSnapshot,
  OrchestratorSpatialView,
} from "./OrchestratorSpatialView.tsx";

const usage = {
  inputTokens: 12_000,
  outputTokens: 3_400,
  reasoningTokens: 800,
  cacheTokens: 2_000,
  totalTokens: 18_200,
  costUsd: 0.42,
  state: "measured" as const,
  byProvider: [],
};

const listSnapshot: OrchestratorSnapshot = {
  status: {
    taskCount: 4,
    activeTaskCount: 2,
    pausedTaskCount: 1,
    blockedTaskCount: 1,
    validatingTaskCount: 0,
    sessionCount: 5,
    activeSessionCount: 2,
    usage,
    byStatus: {
      open: 0,
      active: 2,
      waiting_on_user: 0,
      blocked: 1,
      validating: 0,
      done: 0,
      failed: 0,
      archived: 0,
      interrupted: 0,
    },
  },
  threads: [
    {
      id: "t1",
      title: "Refactor auth pipeline",
      kind: "feature",
      status: "active",
      priority: "high",
      paused: false,
      originalRequest: "make auth cleaner",
      summary: "in progress",
      sessionCount: 2,
      activeSessionCount: 1,
      latestSessionId: "s1",
      latestSessionLabel: "claude",
      latestWorkdir: "/repo",
      latestRepo: "elizaos/eliza",
      latestActivityAt: Date.now(),
      decisionCount: 7,
      usage,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      archivedAt: null,
    },
    {
      id: "t2",
      title: "Fix flaky test suite",
      kind: "bug",
      status: "blocked",
      priority: "urgent",
      paused: true,
      originalRequest: "tests flake",
      summary: undefined,
      sessionCount: 1,
      activeSessionCount: 0,
      latestSessionId: null,
      latestSessionLabel: null,
      latestWorkdir: null,
      latestRepo: null,
      latestActivityAt: null,
      decisionCount: 2,
      usage: { ...usage, totalTokens: 4_000, costUsd: 0.08 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      archivedAt: null,
    },
  ],
  hasMore: true,
  detail: null,
  planSteps: [],
  pendingInputs: [],
};

const detailSnapshot: OrchestratorSnapshot = {
  status: null,
  threads: [],
  hasMore: false,
  detail: {
    id: "t1",
    title: "Refactor auth pipeline",
    kind: "feature",
    status: "active",
    priority: "high",
    paused: false,
    originalRequest: "make auth cleaner",
    summary: "in progress",
    sessionCount: 2,
    activeSessionCount: 1,
    latestSessionId: "s1",
    latestSessionLabel: "claude",
    latestWorkdir: "/repo",
    latestRepo: "elizaos/eliza",
    latestActivityAt: Date.now(),
    decisionCount: 7,
    usage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    archivedAt: null,
    goal: "Untangle the auth pipeline and remove dead branches",
    roomId: "room1",
    taskRoomId: "taskroom1",
    worldId: "world1",
    ownerUserId: "user1",
    parentTaskId: null,
    acceptanceCriteria: ["tests pass", "no any"],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    sessions: [
      {
        id: "sr1",
        threadId: "t1",
        sessionId: "s1",
        framework: "claude",
        providerSource: "anthropic",
        model: "opus",
        accountProviderId: null,
        accountId: null,
        accountLabel: null,
        label: "auth-refactor",
        originalTask: "refactor",
        workdir: "/repo",
        repo: "elizaos/eliza",
        status: "active",
        activeTool: "edit_file",
        decisionCount: 4,
        autoResolvedCount: 1,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        idleCheckCount: 0,
        taskDelivered: false,
        completionSummary: null,
        lastSeenDecisionIndex: 4,
        lastInputSentAt: null,
        stoppedAt: null,
        inputTokens: 8_000,
        outputTokens: 2_000,
        reasoningTokens: 400,
        totalTokens: 10_400,
        cacheTokens: 1_000,
        costUsd: 0.24,
        usageState: "measured",
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    decisions: [
      {
        id: "d1",
        threadId: "t1",
        sessionId: "s1",
        event: "tool_approval",
        promptText: "Allow edit to auth.ts?",
        decision: "approve",
        response: null,
        reasoning: "safe edit",
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
      },
    ],
    events: [
      {
        id: "e1",
        threadId: "t1",
        sessionId: "s1",
        eventType: "session_started",
        timestamp: Date.now(),
        summary: "claude session started in /repo",
        data: {},
        createdAt: new Date().toISOString(),
      },
    ],
    artifacts: [
      {
        id: "a1",
        threadId: "t1",
        sessionId: "s1",
        artifactType: "file",
        title: "auth.ts",
        path: "/repo/auth.ts",
        uri: null,
        mimeType: "text/typescript",
        verificationStatus: "passed",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    ],
    messages: [],
    transcripts: [
      {
        id: "tr1",
        threadId: "t1",
        sessionId: "s1",
        timestamp: Date.now(),
        direction: "stdout",
        content: "running tests... all green",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    ],
    planRevisions: [],
  },
  planSteps: [
    { id: "p1", label: "Map current auth flow", state: "done" },
    { id: "p2", label: "Remove legacy branches", state: "active" },
    { id: "p3", label: "Add coverage", state: "pending" },
  ],
  pendingInputs: [
    {
      sessionId: "s1",
      threadId: "t1",
      promptText: "Confirm deletion of legacy adapter?",
      recentOutput: "found 3 unused exports",
      llmDecision: {},
      taskContext: {},
      createdAt: Date.now(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

const listView = <OrchestratorSpatialView snapshot={listSnapshot} />;
const detailView = <OrchestratorSpatialView snapshot={detailSnapshot} />;

describe("OrchestratorSpatialView one source, three modalities", () => {
  it("TUI: renders the task list honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(listView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Refactor auth pipeline");
      expect(flat).toContain("Fix flaky test suite");
      // Tasks are created conversationally in chat — the workbench is a
      // read-only dashboard, so it exposes no create affordance.
      expect(flat).not.toContain("New task");
    }
  });

  it("TUI: renders the task detail honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(detailView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Refactor auth pipeline");
      expect(flat).toContain("Remove legacy branches"); // plan step
      expect(flat).toContain("auth-refactor"); // session label
      expect(flat).toContain("auth.ts"); // artifact
      expect(flat).toContain("Confirm deletion"); // pending input
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{listView}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{listView}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Refactor auth pipeline");
      expect(html).toContain('data-agent-id="open-t1"');
    }
  });

  it("detail exposes the enriched action bar affordances (non-terminal task)", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{detailView}</SpatialSurface>,
    );
    // Edit-group + lifecycle affordances render for an active (non-terminal) task.
    for (const agentId of [
      "fork",
      "restart",
      "add-agent",
      "copy-link",
      "archive",
      "delete",
      "validate",
      "priority",
    ]) {
      expect(gui).toContain(`data-agent-id="${agentId}"`);
    }
    // Static markup only renders the closed select trigger; Radix renders its
    // options in a portal when opened, so the static contract is the agent hook
    // plus the current value.
    expect(gui).toContain("high");
  });

  it("detail hides the Edit-group + priority on a terminal (archived) task", () => {
    const terminal: OrchestratorSnapshot = {
      ...detailSnapshot,
      detail: detailSnapshot.detail
        ? { ...detailSnapshot.detail, status: "archived" }
        : null,
    };
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <OrchestratorSpatialView snapshot={terminal} />
      </SpatialSurface>,
    );
    // Terminal guard: Edit-group + priority are hidden; Reopen replaces Archive.
    for (const agentId of ["fork", "restart", "add-agent", "priority"]) {
      expect(gui).not.toContain(`data-agent-id="${agentId}"`);
    }
    expect(gui).toContain('data-agent-id="reopen"');
    expect(gui).toContain('data-agent-id="copy-link"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "orchestrator-test",
      () => listView,
    );
    try {
      const component = getTerminalView("orchestrator-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Refactor auth pipeline");
    } finally {
      unregister();
    }
  });
});
