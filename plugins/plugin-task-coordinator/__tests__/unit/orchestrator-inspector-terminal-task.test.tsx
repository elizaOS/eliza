// @vitest-environment jsdom
//
// Behavioral tests for the terminal-task action-bar guards in
// `TaskInspector` (src/OrchestratorWorkbench.tsx). The inspector is mature
// (4142 LOC); we test it directly via the exported `TaskInspector` symbol with
// a hand-built detail fixture so the test is fast and does not need the
// surrounding workbench, network mocks, or the conversation timeline.
//
// What's locked here (see
// `plugins/plugin-agent-orchestrator/docs/orchestrator-dashboard-task-widget-secrets-design.md`
// section 3):
//
//  * When `detail.status` is terminal (done, failed, archived), the entire
//    Edit-group action bar (Fork, Restart, Add Agent) is hidden and the
//    priority dropdown is hidden. Only Reopen (when archived) and Delete
//    (and Copy link) remain as primary affordances.
//  * For non-terminal statuses (e.g. `active`), all of those buttons render
//    as before — the change is purely additive guards, no regression.
//
// The Playwright spec
// `packages/app/test/ui-smoke/orchestrator-gui-workbench.spec.ts` exercises
// these same buttons against a task in `status: "active"`, so the active-task
// guard test here mirrors what that spec depends on.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub out the agent-surface hook — TaskInspector wires a couple of agent
// elements (close button + priority select) and only needs `ref` + `agentProps`
// back. Returning empty objects is safe because the production hook is purely
// a registration side effect for the agent overlay.
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

import { TaskInspector } from "../../src/OrchestratorWorkbench";

// Hand-built fixture matching `CodingAgentTaskThreadDetail`. The status maps
// in OrchestratorWorkbench keep type-safety on `status`, but we only feed
// fields the inspector reads — empty arrays everywhere else.
type Detail = Parameters<typeof TaskInspector>[0]["detail"];

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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function detail(over: Partial<Detail> & { status: Detail["status"] }): Detail {
  return {
    id: "task-1",
    title: "Fixture task",
    kind: "coding",
    status: over.status,
    priority: "normal",
    paused: false,
    originalRequest: "Build something",
    summary: "",
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: null,
    decisionCount: 0,
    // biome-ignore lint/suspicious/noExplicitAny: typed inline as Detail at the boundary
    usage: baseUsage as any,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    archivedAt: null,
    goal: "Verify guards",
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
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    ...over,
  } as Detail;
}

function renderInspector(
  detailOverrides: Partial<Detail> & { status: Detail["status"] },
) {
  return render(
    <TaskInspector
      detail={detail(detailOverrides)}
      busy={false}
      addAgentOpen={false}
      onPause={() => {}}
      onResume={() => {}}
      onArchive={() => {}}
      onReopen={() => {}}
      onDelete={() => {}}
      onFork={() => {}}
      onRestart={() => {}}
      onRestartWithEditedPlan={() => {}}
      onValidate={() => {}}
      onSetPriority={() => {}}
      onToggleAddAgent={() => {}}
      onAddAgent={() => {}}
      onInspectSession={() => {}}
      onStopAgent={() => {}}
      onCopyLink={() => {}}
      t={(key, vars) => String(vars?.defaultValue ?? key)}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("TaskInspector — terminal-task action-bar guards", () => {
  it("hides Edit-group buttons and the priority dropdown for a done task", () => {
    renderInspector({ status: "done" });

    // Edit group is gone — no Fork, no Restart, no Add agent.
    expect(screen.queryByTestId("orchestrator-fork")).toBeNull();
    expect(screen.queryByTestId("orchestrator-inspector-restart")).toBeNull();
    expect(screen.queryByTestId("orchestrator-add-agent")).toBeNull();

    // Priority dropdown is hidden — priority is meaningless once a task closed.
    expect(screen.queryByTestId("orchestrator-priority-select")).toBeNull();

    // Delete is still there; archived-only Reopen is NOT because the task is
    // done, not archived. (Archive remains as a remaining affordance.)
    expect(screen.queryByTestId("orchestrator-delete")).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-reopen")).toBeNull();
    expect(
      screen.queryByTestId("orchestrator-inspector-archive"),
    ).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-copy-link")).not.toBeNull();
  });

  it("hides Edit-group buttons and the priority dropdown for a failed task", () => {
    renderInspector({ status: "failed" });

    expect(screen.queryByTestId("orchestrator-fork")).toBeNull();
    expect(screen.queryByTestId("orchestrator-inspector-restart")).toBeNull();
    expect(screen.queryByTestId("orchestrator-add-agent")).toBeNull();
    expect(screen.queryByTestId("orchestrator-priority-select")).toBeNull();
    expect(screen.queryByTestId("orchestrator-delete")).not.toBeNull();
  });

  it("hides Edit-group buttons and shows Reopen for an archived task", () => {
    renderInspector({ status: "archived" });

    expect(screen.queryByTestId("orchestrator-fork")).toBeNull();
    expect(screen.queryByTestId("orchestrator-inspector-restart")).toBeNull();
    expect(screen.queryByTestId("orchestrator-add-agent")).toBeNull();
    expect(screen.queryByTestId("orchestrator-priority-select")).toBeNull();

    // Reopen IS visible (the only primary affordance for archived tasks).
    expect(screen.queryByTestId("orchestrator-reopen")).not.toBeNull();
    // Delete remains available.
    expect(screen.queryByTestId("orchestrator-delete")).not.toBeNull();
    // No archive button for already-archived tasks.
    expect(screen.queryByTestId("orchestrator-inspector-archive")).toBeNull();
  });

  it("renders the full Edit group and priority dropdown for an active task", () => {
    renderInspector({ status: "active" });

    // Edit group is fully visible — this is what
    // orchestrator-gui-workbench.spec.ts depends on.
    expect(screen.queryByTestId("orchestrator-fork")).not.toBeNull();
    expect(
      screen.queryByTestId("orchestrator-inspector-restart"),
    ).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-add-agent")).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-priority-select")).not.toBeNull();

    // Pause is shown (not paused, not terminal); Resume and Reopen are not.
    expect(screen.queryByTestId("orchestrator-inspector-pause")).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-inspector-resume")).toBeNull();
    expect(screen.queryByTestId("orchestrator-reopen")).toBeNull();
  });

  it("shows Resume (not Pause) for a paused active task and keeps Edit group", () => {
    renderInspector({ status: "active", paused: true });

    expect(
      screen.queryByTestId("orchestrator-inspector-resume"),
    ).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-inspector-pause")).toBeNull();

    // Edit group is still visible — paused is not terminal.
    expect(screen.queryByTestId("orchestrator-fork")).not.toBeNull();
    expect(
      screen.queryByTestId("orchestrator-inspector-restart"),
    ).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-add-agent")).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-priority-select")).not.toBeNull();
  });

  it("shows Approve/Reject for a validating task and keeps Edit group", () => {
    renderInspector({ status: "validating" });

    expect(screen.queryByTestId("orchestrator-approve")).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-reject")).not.toBeNull();

    // Validating is NOT terminal — Edit group remains visible.
    expect(screen.queryByTestId("orchestrator-fork")).not.toBeNull();
    expect(
      screen.queryByTestId("orchestrator-inspector-restart"),
    ).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-add-agent")).not.toBeNull();
    expect(screen.queryByTestId("orchestrator-priority-select")).not.toBeNull();
  });
});
