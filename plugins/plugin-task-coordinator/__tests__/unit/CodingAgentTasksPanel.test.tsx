// @vitest-environment jsdom
//
// Behavioral + data-display tests for CodingAgentTasksPanel (the task-coordinator
// gui/xr view, src/CodingAgentTasksPanel.tsx). Renders it with realistic
// CodingAgentTaskThread / CodingAgentTaskThreadDetail fixtures and
// assert: (a) the populated list shows specific titles/subtitles + total/active/
// done count chips + session/decision chips; (b) typing in search re-fetches
// with that search; (c) the show-archived toggle re-fetches with includeArchived
// and flips aria-pressed; (d) an empty result renders TaskEmptyState; (e)
// clicking a card opens ThreadDetailPane with the fixture's acceptance/session/
// artifact/decision/transcript values + the counts row; (f) Delete archives the
// thread and Reopen reopens an archived one; (g) the back chip returns to the
// list. We mock @elizaos/ui's client + useApp + Button and @elizaos/ui/agent-
// surface's useAgentElement so the component's own behavior is under test.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listCodingAgentTaskThreads = vi.fn();
const getCodingAgentTaskThread = vi.fn();
const archiveCodingAgentTaskThread = vi.fn();
const reopenCodingAgentTaskThread = vi.fn();

// Shared mock app value so the legacy `useApp()` API and the per-slice
// `useAppSelector` / `useAppSelectorShallow` selectors all read the same fields.
const mockAppValue = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) => {
    const template = String(vars?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) =>
      vars && name in vars ? String(vars[name]) : `{{${name}}}`,
    );
  },
  uiLanguage: "en-US",
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

vi.mock("@elizaos/ui", () => ({
  client: {
    listCodingAgentTaskThreads: (...a: unknown[]) =>
      listCodingAgentTaskThreads(...a),
    getCodingAgentTaskThread: (...a: unknown[]) =>
      getCodingAgentTaskThread(...a),
    archiveCodingAgentTaskThread: (...a: unknown[]) =>
      archiveCodingAgentTaskThread(...a),
    reopenCodingAgentTaskThread: (...a: unknown[]) =>
      reopenCodingAgentTaskThread(...a),
  },
  // Translate stub that mirrors the production i18n contract the view relies on:
  // render the defaultValue and interpolate `{{var}}` placeholders from `vars`
  // (this is exactly the count/preview interpolation the real catalog performs,
  // so the rendered "2 sessions" / "2 changed files: …" strings are real).
  useApp: () => mockAppValue,
  useAppSelector: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockAppValue),
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockAppValue),
  // Lightweight Button stub — the real one pulls a large dependency graph; the
  // panel only needs a clickable button element.
  Button: ({
    children,
    onClick,
    disabled,
    // Drop `@elizaos/ui` Button-only props that a raw <button> rejects, then
    // forward EVERYTHING else (data-testid, aria-pressed, type, className, …)
    // so tests can find controls by testid and assert their aria state.
    unstyled: _unstyled,
    variant: _variant,
    size: _size,
    ...rest
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    unstyled?: boolean;
    variant?: string;
    size?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
  // Empty-state recommendations stub — render the title + each recommendation
  // as a button so tests can assert the chat-seeding empty state.
  ChatEmptyStateWithRecommendations: ({
    title,
    recommendations = [],
  }: {
    title?: string;
    recommendations?: Array<string | { label: string }>;
  }) => (
    <div data-testid="task-empty-state">
      {title ? <p>{title}</p> : null}
      {recommendations.map((rec) => {
        const label = typeof rec === "string" ? rec : rec.label;
        return (
          <button type="button" key={label}>
            {label}
          </button>
        );
      })}
    </div>
  ),
}));

import { CodingAgentTasksPanel } from "../../src/CodingAgentTasksPanel";

// --- Fixtures matching the real client types -------------------------------

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  state: "unavailable" as const,
  byProvider: [],
};

type Thread = {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: string;
  paused: boolean;
  originalRequest: string;
  summary?: string;
  sessionCount: number;
  activeSessionCount: number;
  latestSessionId: string | null;
  latestSessionLabel: string | null;
  latestWorkdir: string | null;
  latestRepo: string | null;
  latestActivityAt: number | null;
  decisionCount: number;
  usage: typeof usage;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  archivedAt: string | null;
};

function thread(over: Partial<Thread> & { id: string; title: string }): Thread {
  return {
    kind: "coding",
    status: "open",
    priority: "normal",
    paused: false,
    originalRequest: "",
    summary: undefined,
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: null,
    decisionCount: 0,
    usage,
    createdAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T11:59:00.000Z",
    closedAt: null,
    archivedAt: null,
    ...over,
  };
}

const ACTIVE_THREAD = thread({
  id: "t-active",
  title: "Fix the broken CI build",
  status: "active",
  originalRequest: "Please fix the failing GitHub Actions pipeline",
  sessionCount: 2,
  activeSessionCount: 1,
  decisionCount: 5,
});

const DONE_THREAD = thread({
  id: "t-done",
  title: "Add dark mode toggle",
  status: "done",
  summary: "Shipped the theme switcher with persisted preference",
  originalRequest: "ignored because summary takes precedence",
  sessionCount: 1,
  decisionCount: 2,
});

const OPEN_THREAD = thread({
  id: "t-open",
  title: "Write the migration guide",
  status: "open",
  originalRequest: "Document the v1 to v2 upgrade",
});

// A populated detail for the active thread, exercising every detail region.
function detailFor(over: Partial<Record<string, unknown>> = {}) {
  return {
    ...ACTIVE_THREAD,
    goal: "Make CI green",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    acceptanceCriteria: ["All tests pass", "Lint is clean"],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    sessions: [
      {
        id: "sess-row-1",
        threadId: "t-active",
        sessionId: "sess-1",
        framework: "codex",
        providerSource: "openai",
        model: "gpt-5.5",
        label: "CI Fixer",
        originalTask: "fix ci",
        workdir: "/repo/packages/app",
        repo: "owner/repo",
        status: "active",
        activeTool: null,
        decisionCount: 3,
        autoResolvedCount: 0,
        registeredAt: 1,
        lastActivityAt: 2,
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
        metadata: {
          workspaceChanges: {
            changedFiles: ["src/ci.ts", "src/build.ts"],
            totalChangedFiles: 2,
          },
        },
        createdAt: "2026-06-16T10:00:00.000Z",
        updatedAt: "2026-06-16T11:00:00.000Z",
      },
    ],
    decisions: [
      {
        id: "dec-1",
        threadId: "t-active",
        sessionId: "sess-1",
        event: "tool_call",
        promptText: "run tests?",
        decision: "approved-run-tests",
        response: null,
        reasoning: "Tests must pass before merge",
        timestamp: Date.now() - 60_000,
        createdAt: "2026-06-16T11:58:00.000Z",
      },
    ],
    events: [
      {
        id: "ev-1",
        threadId: "t-active",
        sessionId: "sess-1",
        eventType: "session_started",
        timestamp: Date.now() - 120_000,
        summary: "Worker session booted",
        data: {},
        createdAt: "2026-06-16T11:56:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "art-1",
        threadId: "t-active",
        sessionId: "sess-1",
        artifactType: "patch",
        title: "ci-fix.patch",
        path: "/repo/ci-fix.patch",
        uri: null,
        mimeType: null,
        verificationStatus: "passed",
        metadata: {},
        createdAt: "2026-06-16T11:55:00.000Z",
      },
    ],
    messages: [],
    transcripts: [
      {
        id: "tr-1",
        threadId: "t-active",
        sessionId: "sess-1",
        timestamp: Date.now() - 30_000,
        direction: "stdin",
        // Real ESC-prefixed ANSI color codes so we verify the strip happens.
        content: "[32mApply the failing-test fix[0m",
        metadata: {},
        createdAt: "2026-06-16T11:59:30.000Z",
      },
    ],
    planRevisions: [],
    ...over,
  };
}

beforeEach(() => {
  listCodingAgentTaskThreads.mockReset().mockResolvedValue([]);
  getCodingAgentTaskThread.mockReset().mockResolvedValue(detailFor());
  archiveCodingAgentTaskThread.mockReset().mockResolvedValue(true);
  reopenCodingAgentTaskThread.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

function panel(): HTMLElement {
  return screen.getByTestId("task-coordinator-panel");
}

describe("CodingAgentTasksPanel — list", () => {
  it("renders each thread's title + subtitle and the total/active/done count chips", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([
      ACTIVE_THREAD,
      DONE_THREAD,
      OPEN_THREAD,
    ]);
    render(<CodingAgentTasksPanel />);

    // Titles appear for every thread.
    await screen.findByText("Fix the broken CI build");
    expect(screen.getByText("Add dark mode toggle")).toBeTruthy();
    expect(screen.getByText("Write the migration guide")).toBeTruthy();

    // Subtitle uses summary when present, else originalRequest.
    expect(
      screen.getByText("Shipped the theme switcher with persisted preference"),
    ).toBeTruthy();
    expect(
      screen.getByText("Please fix the failing GitHub Actions pipeline"),
    ).toBeTruthy();

    // Count chips: 3 total, 1 active, 1 done. Assert each chip pairs the right
    // value with its label (a chip is the <span> wrapping value + label).
    const header = panel().querySelector("header") as HTMLElement;
    const chips = within(header);
    const chipFor = (label: string): HTMLElement => {
      const labelEl = chips.getByText(label);
      const chip = labelEl.parentElement as HTMLElement;
      return chip;
    };
    expect(within(chipFor("total")).getByText("3")).toBeTruthy();
    expect(within(chipFor("active")).getByText("1")).toBeTruthy();
    expect(within(chipFor("done")).getByText("1")).toBeTruthy();

    // Per-card meta chips: the active card shows "2 sessions" + "5 decisions".
    expect(screen.getByText("2 sessions")).toBeTruthy();
    expect(screen.getByText("5 decisions")).toBeTruthy();
  });

  it("the initial fetch requests the non-archived, unsearched list (limit 30)", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD]);
    render(<CodingAgentTasksPanel />);
    await screen.findByText("Fix the broken CI build");
    expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      search: undefined,
      limit: 30,
    });
  });

  it("renders the empty state when the list is empty", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([]);
    render(<CodingAgentTasksPanel />);
    expect(await screen.findByTestId("task-empty-state")).toBeTruthy();
    expect(
      screen.getByText("Dispatch a coding agent to fix a failing test"),
    ).toBeTruthy();
  });
});

// #13565: in `fullPage` mode the Tasks nav view hosts this panel UNDER the
// shared, uniform `ViewHeader` (icon-only back + centered "Tasks"). The panel
// therefore drops its own internal title row (no duplicate heading) and renders
// a designed-empty state with NO suggestion/create CTAs — the proactive-greeting
// child offers to start a task in chat instead. The embedded (default) mode
// keeps its own header + recommendation chips for the surfaces that have no chat
// rail, which the tests above already cover.
describe("CodingAgentTasksPanel — fullPage (uniform header host)", () => {
  it("renders NO internal <h1> title row (the shell ViewHeader owns the title)", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD, DONE_THREAD]);
    const { container } = render(<CodingAgentTasksPanel fullPage />);
    await screen.findByText("Fix the broken CI build");
    expect(container.querySelector("h1")).toBeNull();
    // The counts survive as a lightweight secondary meta strip instead.
    expect(screen.getByTestId("task-count-strip")).toBeTruthy();
  });

  it("the default (embedded) mode STILL renders its own <h1> header", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD, DONE_THREAD]);
    const { container } = render(<CodingAgentTasksPanel />);
    await screen.findByText("Fix the broken CI build");
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Coding Tasks");
  });

  it("the fullPage empty state has NO suggestion/create CTA buttons", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([]);
    render(<CodingAgentTasksPanel fullPage />);
    const empty = await screen.findByTestId("task-empty-state");
    expect(within(empty).queryAllByRole("button")).toHaveLength(0);
    // The quiet designed-empty title still names the state.
    expect(screen.getByText("No coding tasks yet.")).toBeTruthy();
  });

  it("the default (embedded) empty state KEEPS its recommendation chips", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([]);
    render(<CodingAgentTasksPanel />);
    const empty = await screen.findByTestId("task-empty-state");
    expect(
      within(empty).getAllByRole("button").length,
    ).toBeGreaterThan(0);
  });
});

describe("CodingAgentTasksPanel — controls", () => {
  it("typing in search re-fetches the thread list with that search term", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD]);
    render(<CodingAgentTasksPanel />);
    await screen.findByText("Fix the broken CI build");

    const searchBox = screen.getByPlaceholderText(
      "Search tasks",
    ) as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: "dark mode" } });

    await waitFor(() => {
      expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
        includeArchived: false,
        search: "dark mode",
        limit: 30,
      });
    });
  });

  it("the show-archived toggle re-fetches with includeArchived and flips aria-pressed", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD]);
    render(<CodingAgentTasksPanel />);
    await screen.findByText("Fix the broken CI build");

    const toggle = screen.getByTestId("task-show-archived");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await waitFor(() => {
      expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
        includeArchived: true,
        search: undefined,
        limit: 30,
      });
    });
  });
});

describe("CodingAgentTasksPanel — detail pane", () => {
  it("clicking a card opens the detail pane with populated data regions", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD]);
    getCodingAgentTaskThread.mockResolvedValue(detailFor());
    render(<CodingAgentTasksPanel />);

    fireEvent.click(await screen.findByText("Fix the broken CI build"));

    // The detail loads (getCodingAgentTaskThread called with the clicked id).
    await waitFor(() =>
      expect(getCodingAgentTaskThread).toHaveBeenCalledWith("t-active"),
    );
    await screen.findByTestId("task-detail-pane");

    // Counts row.
    expect(screen.getByText("1 sessions")).toBeTruthy();
    expect(screen.getByText("1 artifacts")).toBeTruthy();
    expect(screen.getByText("1 transcript entries")).toBeTruthy();

    // Acceptance criteria.
    expect(screen.getByText("All tests pass")).toBeTruthy();
    expect(screen.getByText("Lint is clean")).toBeTruthy();

    // Session row: label + framework(provider) + workdir + changed-files.
    expect(screen.getByText("CI Fixer")).toBeTruthy();
    expect(
      screen.getByText(/codex \(openai\) · .* · \/repo\/packages\/app/),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 changed files: src\/ci\.ts, src\/build\.ts/),
    ).toBeTruthy();

    // Artifact title + type/path.
    expect(screen.getByText("ci-fix.patch")).toBeTruthy();
    expect(screen.getByText(/patch · \/repo\/ci-fix\.patch/)).toBeTruthy();

    // Coordinator decision text.
    expect(screen.getByText(/approved-run-tests/)).toBeTruthy();
    expect(screen.getByText("Tests must pass before merge")).toBeTruthy();

    // Event summary.
    expect(screen.getByText("Worker session booted")).toBeTruthy();

    // ANSI-stripped transcript content (no escape codes survive): exact text
    // match plus an assertion that the literal "[32m" residue is gone.
    const transcript = screen.getByText("Apply the failing-test fix");
    expect(transcript.textContent).toBe("Apply the failing-test fix");
    expect(transcript.textContent).not.toContain("[32m");
    expect(transcript.textContent).not.toContain("");
  });

  it("the back chip returns from the detail pane to the list", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD]);
    render(<CodingAgentTasksPanel />);

    fireEvent.click(await screen.findByText("Fix the broken CI build"));
    await screen.findByTestId("task-detail-pane");

    fireEvent.click(screen.getByTestId("task-detail-back"));

    await waitFor(() =>
      expect(screen.queryByTestId("task-detail-pane")).toBeNull(),
    );
    // The card list is shown again.
    expect(screen.getByTestId("task-card")).toBeTruthy();
  });

  it("Delete archives the open thread via archiveCodingAgentTaskThread(id)", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([ACTIVE_THREAD]);
    getCodingAgentTaskThread.mockResolvedValue(detailFor());
    archiveCodingAgentTaskThread.mockResolvedValue(true);
    render(<CodingAgentTasksPanel />);

    fireEvent.click(await screen.findByText("Fix the broken CI build"));
    await screen.findByTestId("task-detail-pane");

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(archiveCodingAgentTaskThread).toHaveBeenCalledWith("t-active"),
    );
  });

  it("Reopen reopens an archived thread via reopenCodingAgentTaskThread(id)", async () => {
    const archivedThread = thread({
      id: "t-arch",
      title: "Old archived task",
      status: "archived",
      archivedAt: "2026-06-15T00:00:00.000Z",
    });
    listCodingAgentTaskThreads.mockResolvedValue([archivedThread]);
    getCodingAgentTaskThread.mockResolvedValue(
      detailFor({
        ...archivedThread,
        status: "archived",
        goal: "Old goal",
        acceptanceCriteria: [],
        sessions: [],
        decisions: [],
        events: [],
        artifacts: [],
        transcripts: [],
      }),
    );
    reopenCodingAgentTaskThread.mockResolvedValue(true);
    render(<CodingAgentTasksPanel />);

    fireEvent.click(await screen.findByText("Old archived task"));
    await screen.findByTestId("task-detail-pane");

    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    await waitFor(() =>
      expect(reopenCodingAgentTaskThread).toHaveBeenCalledWith("t-arch"),
    );
  });
});
