// Pins the one-source/three-modality contract of TaskCoordinatorSpatialView: the
// TUI render honors the terminal width budget (via renderViewToLines), the
// GUI/XR DOM render mounts with agent hooks (XR scaled up), and the view
// registers into the terminal registry the agent terminal mounts. Deterministic.
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
  type TaskCoordinatorSnapshot,
  TaskCoordinatorSpatialView,
} from "./TaskCoordinatorSpatialView.tsx";

const listSnapshot: TaskCoordinatorSnapshot = {
  threads: [
    {
      id: "t1",
      title: "Refactor auth pipeline",
      subtitle: "make auth cleaner",
      status: "active",
      sessionCount: 2,
      decisionCount: 7,
    },
    {
      id: "t2",
      title: "Fix flaky test suite",
      subtitle: "tests flake",
      status: "done",
      sessionCount: 1,
      decisionCount: 2,
    },
  ],
  selectedThreadId: null,
  detail: null,
  showArchived: false,
  search: "",
};

const detailSnapshot: TaskCoordinatorSnapshot = {
  threads: [],
  selectedThreadId: "t1",
  showArchived: false,
  search: "",
  detail: {
    id: "t1",
    title: "Refactor auth pipeline",
    kind: "coding",
    status: "active",
    priority: "high",
    paused: false,
    originalRequest: "make auth cleaner",
    summary: "in progress",
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: "s1",
    latestSessionLabel: "claude",
    latestWorkdir: "/repo",
    latestRepo: "elizaos/eliza",
    latestActivityAt: Date.now(),
    decisionCount: 1,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "measured",
      byProvider: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    archivedAt: null,
    goal: "Untangle the auth pipeline",
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
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cacheTokens: 0,
        costUsd: 0,
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
    transcripts: [],
    planRevisions: [],
  },
};

const listView = <TaskCoordinatorSpatialView snapshot={listSnapshot} />;
const detailView = <TaskCoordinatorSpatialView snapshot={detailSnapshot} />;

describe("TaskCoordinatorSpatialView one source, three modalities", () => {
  it("TUI: renders the task list honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(listView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      // Long titles truncate to fit the width contract; match a stable prefix.
      expect(flat).toContain("Refactor auth");
      expect(flat).toContain("Fix flaky test");
      expect(flat).toContain("Open");
    }
  });

  it("TUI: renders the task detail honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(detailView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Refactor auth pipeline");
      expect(flat).toContain("tests pass"); // acceptance criterion
      expect(flat).toContain("auth-refactor"); // session label
      expect(flat).toContain("auth.ts"); // artifact
      expect(flat).toContain("Delete");
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
      expect(html).toContain('data-agent-id="search"');
      expect(html).toContain('data-agent-id="toggle-archived"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "task-coordinator-test",
      () => listView,
    );
    try {
      const component = getTerminalView("task-coordinator-test");
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
