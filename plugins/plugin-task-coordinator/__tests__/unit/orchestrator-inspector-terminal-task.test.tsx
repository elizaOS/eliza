// @vitest-environment jsdom
//
// Behavioral tests for the terminal-task action-bar guards in
// `TaskInspector` (src/OrchestratorWorkbench.tsx). We test it directly via the
// exported `TaskInspector` symbol with a hand-built detail fixture so the test
// is fast and does not need the
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

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

// --- Behavior + data display ----------------------------------------------
// The block above asserts only button PRESENCE/ABSENCE. These cases close the
// gap: they (1) render an active task populated with sub-agent sessions, a plan,
// acceptance criteria, artifacts, and non-zero token/cost usage and assert those
// specific VALUES render, and (2) fire each action-bar control and assert the
// matching on* callback fires with the expected argument.

type Session = Detail["sessions"][number];

const sessionFixture = (over: Partial<Session> & { sessionId: string }) =>
  ({
    id: `row-${over.sessionId}`,
    threadId: "task-1",
    sessionId: over.sessionId,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as Session;

// A non-zero, "measured" usage summary so the rendered figures are real values,
// not the "—" unavailable marker.
const measuredUsage = {
  inputTokens: 8000,
  outputTokens: 4345,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 12_345,
  costUsd: 0.42,
  state: "measured" as const,
  usageState: "measured" as const,
  byProvider: [
    {
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: 8000,
      outputTokens: 4345,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 12_345,
      costUsd: 0.42,
      state: "measured" as const,
    },
  ],
};

function makeCallbacks() {
  return {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onArchive: vi.fn(),
    onReopen: vi.fn(),
    onDelete: vi.fn(),
    onFork: vi.fn(),
    onRestart: vi.fn(),
    onRestartWithEditedPlan: vi.fn(),
    onValidate: vi.fn(),
    onSetPriority: vi.fn(),
    onToggleAddAgent: vi.fn(),
    onAddAgent: vi.fn(),
    onInspectSession: vi.fn(),
    onStopAgent: vi.fn(),
    onCopyLink: vi.fn(),
  };
}

function renderWithSpies(
  detailOverrides: Partial<Detail> & { status: Detail["status"] },
) {
  const cb = makeCallbacks();
  const utils = render(
    <TaskInspector
      detail={detail(detailOverrides)}
      busy={false}
      addAgentOpen={false}
      {...cb}
      t={(key, vars) => String(vars?.defaultValue ?? key)}
    />,
  );
  return { ...utils, cb };
}

describe("TaskInspector — data display (active task with full detail)", () => {
  it("renders populated sub-agent, plan, acceptance, artifact, and usage values", () => {
    renderWithSpies({
      status: "active",
      sessions: [sessionFixture({ sessionId: "sess-1" })],
      currentPlan: {
        summary: "Three-step recovery plan",
        steps: [
          { title: "Reproduce the failure", status: "done" },
          { title: "Patch the build script", status: "in_progress" },
        ],
      },
      acceptanceCriteria: ["CI is green", "No new lint errors"],
      artifacts: [
        {
          id: "art-1",
          threadId: "task-1",
          sessionId: "sess-1",
          artifactType: "patch",
          title: "build-fix.patch",
          path: "/repo/build-fix.patch",
          uri: null,
          mimeType: null,
          verificationStatus: "passed",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          // biome-ignore lint/suspicious/noExplicitAny: typed inline at the boundary
        } as any,
      ],
      // biome-ignore lint/suspicious/noExplicitAny: typed inline at the boundary
      usage: measuredUsage as any,
    });

    // Sub-agent card: label + framework·model + workspace (repo wins over workdir).
    expect(screen.getByText("Primary worker")).toBeTruthy();
    expect(screen.getByText("codex · gpt-5.5")).toBeTruthy();
    expect(screen.getByText("owner/app")).toBeTruthy();

    // Plan summary + steps.
    expect(screen.getByText("Three-step recovery plan")).toBeTruthy();
    expect(screen.getByText("Reproduce the failure")).toBeTruthy();
    expect(screen.getByText("Patch the build script")).toBeTruthy();

    // Acceptance criteria.
    expect(screen.getByText("CI is green")).toBeTruthy();
    expect(screen.getByText("No new lint errors")).toBeTruthy();

    // Artifact title + type·path.
    expect(screen.getByText("build-fix.patch")).toBeTruthy();
    expect(screen.getByText(/patch · \/repo\/build-fix\.patch/)).toBeTruthy();

    // Usage: compact token total (12.3K) + USD cost ($0.42), both measured.
    expect(screen.getByText("12.3K")).toBeTruthy();
    expect(screen.getByText("$0.42")).toBeTruthy();
  });
});

describe("TaskInspector — control behavior (callbacks fire)", () => {
  it("Pause fires onPause for an active task", () => {
    const { cb } = renderWithSpies({ status: "active" });
    fireEvent.click(screen.getByTestId("orchestrator-inspector-pause"));
    expect(cb.onPause).toHaveBeenCalledTimes(1);
  });

  it("Resume fires onResume for a paused task", () => {
    const { cb } = renderWithSpies({ status: "active", paused: true });
    fireEvent.click(screen.getByTestId("orchestrator-inspector-resume"));
    expect(cb.onResume).toHaveBeenCalledTimes(1);
  });

  it("Fork and Restart fire their callbacks for an active task", () => {
    const { cb } = renderWithSpies({ status: "active" });
    fireEvent.click(screen.getByTestId("orchestrator-fork"));
    fireEvent.click(screen.getByTestId("orchestrator-inspector-restart"));
    expect(cb.onFork).toHaveBeenCalledTimes(1);
    expect(cb.onRestart).toHaveBeenCalledTimes(1);
  });

  it("Copy link fires onCopyLink", () => {
    const { cb } = renderWithSpies({ status: "active" });
    fireEvent.click(screen.getByTestId("orchestrator-copy-link"));
    expect(cb.onCopyLink).toHaveBeenCalledTimes(1);
  });

  it("Archive fires onArchive for a non-archived task", () => {
    const { cb } = renderWithSpies({ status: "active" });
    fireEvent.click(screen.getByTestId("orchestrator-inspector-archive"));
    expect(cb.onArchive).toHaveBeenCalledTimes(1);
  });

  it("Reopen fires onReopen for an archived task", () => {
    const { cb } = renderWithSpies({ status: "archived" });
    fireEvent.click(screen.getByTestId("orchestrator-reopen"));
    expect(cb.onReopen).toHaveBeenCalledTimes(1);
  });

  it("Approve/Reject fire onValidate(true/false) for a validating task", () => {
    const { cb } = renderWithSpies({ status: "validating" });
    fireEvent.click(screen.getByTestId("orchestrator-approve"));
    expect(cb.onValidate).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("orchestrator-reject"));
    expect(cb.onValidate).toHaveBeenCalledWith(false);
  });

  it("changing the priority select fires onSetPriority with the new value", () => {
    const { cb } = renderWithSpies({ status: "active", priority: "normal" });
    fireEvent.change(screen.getByTestId("orchestrator-priority-select"), {
      target: { value: "high" },
    });
    expect(cb.onSetPriority).toHaveBeenCalledWith("high");
  });

  it("Add agent toggles the add-agent form via onToggleAddAgent", () => {
    const { cb } = renderWithSpies({ status: "active" });
    fireEvent.click(screen.getByTestId("orchestrator-add-agent"));
    expect(cb.onToggleAddAgent).toHaveBeenCalledTimes(1);
  });

  it("inspect-session and stop-agent fire with the sub-agent's sessionId", () => {
    const { cb } = renderWithSpies({
      status: "active",
      sessions: [sessionFixture({ sessionId: "sess-42" })],
    });
    fireEvent.click(screen.getByTestId("orchestrator-inspect-session"));
    expect(cb.onInspectSession).toHaveBeenCalledWith("sess-42");
    fireEvent.click(screen.getByTestId("orchestrator-stop-agent"));
    expect(cb.onStopAgent).toHaveBeenCalledWith("sess-42");
  });

  it("Delete opens the confirm dialog and its Delete action fires onDelete", () => {
    const { cb } = renderWithSpies({ status: "active" });
    // The trigger only opens the AlertDialog; onDelete is wired to the dialog's
    // confirm action, not the trigger button.
    fireEvent.click(screen.getByTestId("orchestrator-delete"));
    expect(cb.onDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });
});
