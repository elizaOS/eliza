/** Exercises the native Smithers studio over mocked elizaOS Cloud workflow APIs. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { client } from "../../api";
import type {
  WorkflowDefinition,
  WorkflowExecution,
} from "../../api/client-types-chat";
import { CHAT_PREFILL_EVENT, type ChatPrefillEventDetail } from "../../events";
import { WorkflowEditor } from "./WorkflowEditor";

vi.mock("../../api", () => ({
  client: {
    activateWorkflowDefinition: vi.fn(),
    cancelWorkflowExecution: vi.fn(),
    createTrigger: vi.fn(),
    createWorkflowDefinition: vi.fn(),
    deactivateWorkflowDefinition: vi.fn(),
    deleteTrigger: vi.fn(),
    decideWorkflowApproval: vi.fn(),
    getWorkflowExecution: vi.fn(),
    getWorkflowExecutions: vi.fn(),
    getWorkflowRevisions: vi.fn(),
    getTriggers: vi.fn(),
    restoreWorkflowRevision: vi.fn(),
    runWorkflowDefinition: vi.fn(),
    signalWorkflowExecution: vi.fn(),
    updateWorkflowDefinition: vi.fn(),
  },
}));

const api = client as unknown as Record<string, ReturnType<typeof vi.fn>>;
const now = "2026-08-12T12:00:00.000Z";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => vi.unstubAllGlobals());

function workflow(): WorkflowDefinition {
  return {
    id: "workflow-1",
    name: "Digest",
    description: "Native digest",
    source: 'import { createSmithers } from "smthrs/create"; export default {}',
    language: "tsx",
    active: true,
    steps: [
      { id: "digest", label: "Build digest", kind: "task", agent: "elizaOS" },
    ],
    widgets: [
      {
        id: "status",
        title: "Digest status",
        surface: "both",
        component: "status",
      },
    ],
    versionId: "v1",
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getWorkflowExecutions.mockResolvedValue([]);
  api.getTriggers.mockResolvedValue({ triggers: [] });
  api.createTrigger.mockResolvedValue({ trigger: { id: "trigger-1" } });
  api.getWorkflowRevisions.mockResolvedValue({
    currentVersionId: "v1",
    revisions: [],
  });
  api.createWorkflowDefinition.mockResolvedValue(workflow());
  api.updateWorkflowDefinition.mockResolvedValue(workflow());
  api.cancelWorkflowExecution.mockResolvedValue({});
  api.decideWorkflowApproval.mockResolvedValue({});
  api.restoreWorkflowRevision.mockResolvedValue(workflow());
  api.runWorkflowDefinition.mockResolvedValue({
    id: "run-1",
    workflowId: "workflow-1",
    mode: "manual",
    status: "queued",
    finished: false,
    startedAt: now,
    stoppedAt: null,
    input: {},
    events: [],
  });
});

afterEach(cleanup);

describe("WorkflowEditor", () => {
  it("shows failed history reads and lets the user retry", async () => {
    api.getWorkflowRevisions.mockRejectedValueOnce(
      new Error("History service unavailable"),
    );
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText(/History service unavailable/)).toBeTruthy();
    expect(screen.queryByText("No saved revisions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("No saved revisions")).toBeTruthy();
    expect(screen.queryByText(/History service unavailable/)).toBeNull();
  });

  it("does not show a previous workflow's runs after its delayed response arrives", async () => {
    const oldRuns = Promise.withResolvers<WorkflowExecution[]>();
    api.getWorkflowExecutions.mockReturnValueOnce(oldRuns.promise);
    const { rerender } = render(<WorkflowEditor initial={workflow()} />);
    await waitFor(() =>
      expect(api.getWorkflowExecutions).toHaveBeenCalledWith("workflow-1", 30),
    );
    rerender(
      <WorkflowEditor
        initial={{ ...workflow(), id: "workflow-2", name: "Review" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await waitFor(() =>
      expect(api.getWorkflowExecutions).toHaveBeenCalledWith("workflow-2", 30),
    );
    await act(async () =>
      oldRuns.resolve([
        {
          id: "old-run",
          workflowId: "workflow-1",
          mode: "manual",
          status: "finished",
          finished: true,
          startedAt: now,
          stoppedAt: now,
          input: {},
          events: [],
          output: "old workflow result",
        },
      ]),
    );
    expect(screen.queryByText("old workflow result")).toBeNull();
    expect(screen.queryByText("old-run")).toBeNull();
  });

  it("keeps a newly started run when an earlier runs request finishes late", async () => {
    const oldRuns = Promise.withResolvers<WorkflowExecution[]>();
    api.getWorkflowExecutions.mockReturnValueOnce(oldRuns.promise);
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.runWorkflowDefinition).toHaveBeenCalled());
    await screen.findByLabelText("Output");
    await act(async () => oldRuns.resolve([]));
    expect(screen.getByLabelText("Output")).toBeTruthy();
    expect(screen.queryByText("No runs yet")).toBeNull();
  });

  it("still starts a saved workflow when revision refresh fails", async () => {
    api.getWorkflowRevisions.mockRejectedValue(
      new Error("Revision backend unavailable"),
    );
    render(<WorkflowEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(api.runWorkflowDefinition).toHaveBeenCalledWith("workflow-1", {}),
    );
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByText(/Revision backend unavailable/),
    ).toBeTruthy();
  });

  it("marks live status stale on a failed poll and recovers on the next poll", async () => {
    const running: WorkflowExecution = {
      id: "live-poll",
      workflowId: "workflow-1",
      mode: "manual",
      status: "running",
      finished: false,
      startedAt: now,
      stoppedAt: null,
      input: {},
      events: [],
    };
    api.getWorkflowExecutions.mockResolvedValue([running]);
    api.getWorkflowExecution
      .mockRejectedValueOnce(new Error("Status temporarily unavailable"))
      .mockResolvedValue({
        ...running,
        status: "finished",
        finished: true,
        stoppedAt: now,
        output: "Recovered result",
      });
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(
      await screen.findByText(/Live status unavailable/, {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(
      await screen.findByText(/Recovered result/, {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/Live status unavailable/)).toBeNull();
  });

  it("renders native source, visual triggers, and typed widgets", async () => {
    render(<WorkflowEditor initial={workflow()} />);
    expect(screen.getByText("Build digest")).toBeTruthy();
    expect(screen.getByTitle("Manual")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add workflow trigger" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
    fireEvent.change(screen.getByLabelText("Interval minutes"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));
    await waitFor(() =>
      expect(api.createTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "workflow",
          workflowId: "workflow-1",
          triggerType: "interval",
          intervalMs: 1_800_000,
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(
      (screen.getByTestId("smithers-source-editor") as HTMLTextAreaElement)
        .value,
    ).toMatch(/smthrs\/create/);
    fireEvent.click(screen.getByRole("button", { name: "Widgets" }));
    expect(await screen.findByText("Digest status")).toBeTruthy();
    await waitFor(() => expect(api.getWorkflowExecutions).toHaveBeenCalled());
    await waitFor(() => expect(api.getWorkflowRevisions).toHaveBeenCalled());
  });

  it("routes visual add and edit gestures through Eliza chat", async () => {
    const prefills: ChatPrefillEventDetail[] = [];
    const onPrefill = (event: Event) => {
      prefills.push((event as CustomEvent<ChatPrefillEventDetail>).detail);
    };
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);
    try {
      render(<WorkflowEditor initial={workflow()} />);
      await waitFor(() => expect(api.getWorkflowExecutions).toHaveBeenCalled());
      await waitFor(() => expect(api.getTriggers).toHaveBeenCalled());
      await waitFor(() => expect(api.getWorkflowRevisions).toHaveBeenCalled());
      fireEvent.click(
        screen.getByRole("button", { name: "Add step with Eliza" }),
      );
      expect(prefills.at(-1)?.text).toBe("Add a step to workflow workflow-1: ");

      fireEvent.click(screen.getByLabelText("Build digest, task"));
      fireEvent.click(screen.getByRole("button", { name: "Build digest" }));
      expect(prefills.at(-1)?.text).toBe(
        "Edit step digest in workflow workflow-1: ",
      );
    } finally {
      window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
    }
  });

  it("persists a new workflow before starting its first run", async () => {
    render(<WorkflowEditor />);
    const runButton = screen.getByRole("button", { name: "Run" });
    expect(runButton.className).toContain("hover:bg-accent-hover");
    fireEvent.click(runButton);
    await waitFor(() =>
      expect(api.createWorkflowDefinition).toHaveBeenCalledTimes(1),
    );
    expect(api.createWorkflowDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.stringContaining("retries={2}"),
      }),
    );
    await waitFor(() =>
      expect(api.runWorkflowDefinition).toHaveBeenCalledWith("workflow-1", {}),
    );
    await waitFor(() => expect(api.getWorkflowRevisions).toHaveBeenCalled());
  });

  it("collects JSON-schema inputs before a run", async () => {
    const configured = workflow();
    configured.inputSchema = {
      type: "object",
      required: ["topic"],
      properties: {
        topic: { type: "string", title: "Topic" },
        limit: { type: "integer", title: "Limit", default: 5 },
      },
    };
    render(<WorkflowEditor initial={configured} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.change(screen.getByLabelText("Topic"), {
      target: { value: "release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() =>
      expect(api.runWorkflowDefinition).toHaveBeenCalledWith("workflow-1", {
        topic: "release",
        limit: 5,
      }),
    );
  });

  it("materializes an untouched required boolean in the run payload", async () => {
    const configured = workflow();
    configured.inputSchema = {
      type: "object",
      required: ["notify"],
      properties: {
        notify: { type: "boolean", title: "Notify" },
      },
    };
    render(<WorkflowEditor initial={configured} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(
      (await screen.findByRole("checkbox")).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() =>
      expect(api.runWorkflowDefinition).toHaveBeenCalledWith("workflow-1", {
        notify: false,
      }),
    );
  });

  it("saves dirty source before running the active definition", async () => {
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.change(screen.getByLabelText("Workflow name"), {
      target: { value: "Updated digest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(api.updateWorkflowDefinition).toHaveBeenCalled(),
    );
    await waitFor(() => expect(api.runWorkflowDefinition).toHaveBeenCalled());
    expect(
      api.updateWorkflowDefinition.mock.invocationCallOrder[0],
    ).toBeLessThan(api.runWorkflowDefinition.mock.invocationCallOrder[0]);
  });

  it("renders Smithers widget contracts as native visual surfaces", async () => {
    const configured = workflow();
    configured.widgets = [
      {
        id: "markdown",
        title: "Summary",
        surface: "both",
        component: "markdown",
        dataPath: "summary",
      },
      {
        id: "table",
        title: "Rows",
        surface: "both",
        component: "data-table",
        dataPath: "rows",
      },
      {
        id: "chart",
        title: "Chart",
        surface: "both",
        component: "chart",
        dataPath: "chart",
      },
      {
        id: "issues",
        title: "Issues",
        surface: "both",
        component: "issue-list",
        dataPath: "issues",
      },
    ];
    api.getWorkflowExecutions.mockResolvedValue([
      {
        id: "run-finished",
        workflowId: "workflow-1",
        mode: "manual",
        status: "finished",
        finished: true,
        startedAt: now,
        stoppedAt: now,
        input: {},
        events: [],
        output: {
          summary: "Release ready",
          rows: [{ name: "Alpha", score: 9 }],
          chart: [{ label: "Passed", value: 7 }],
          issues: ["Review copy"],
        },
      },
    ]);
    render(<WorkflowEditor initial={configured} />);
    fireEvent.click(screen.getByRole("button", { name: "Widgets" }));
    expect(await screen.findByText("Release ready")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.getByText("Review copy")).toBeTruthy();
  });

  it("arms destructive run cancellation and revision restore", async () => {
    api.getWorkflowExecutions.mockResolvedValue([
      {
        id: "run-live",
        workflowId: "workflow-1",
        mode: "manual",
        status: "running",
        finished: false,
        startedAt: now,
        stoppedAt: null,
        input: {},
        events: [],
      },
    ]);
    api.getWorkflowRevisions.mockResolvedValue({
      currentVersionId: "v1",
      revisions: [
        {
          id: "revision-1",
          workflowId: "workflow-1",
          versionId: "v0",
          name: "Digest",
          active: false,
          createdAt: now,
          updatedAt: now,
          capturedAt: now,
          operation: "update",
        },
      ],
    });
    api.cancelWorkflowExecution.mockRejectedValueOnce(
      new Error("Cancellation unavailable"),
    );
    api.restoreWorkflowRevision.mockRejectedValueOnce(
      new Error("Restore unavailable"),
    );
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(
      await screen.findByRole("button", { name: "Cancel run" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(api.cancelWorkflowExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel run" }));
    await waitFor(() =>
      expect(api.cancelWorkflowExecution).toHaveBeenCalledWith("run-live"),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Cancellation unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel run" }));
    await waitFor(() =>
      expect(screen.queryByText("Cancellation unavailable")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("button", { name: "Restore revision" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore revision" }));
    expect(api.restoreWorkflowRevision).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm restore revision" }),
    );
    await waitFor(() =>
      expect(api.restoreWorkflowRevision).toHaveBeenCalledWith(
        "workflow-1",
        "v0",
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Restore unavailable",
    );
  });

  it("submits the exact Smithers approval node and iteration", async () => {
    api.getWorkflowExecutions.mockResolvedValue([
      {
        id: "run-approval",
        workflowId: "workflow-1",
        mode: "manual",
        status: "waiting-approval",
        finished: false,
        startedAt: now,
        stoppedAt: null,
        input: {},
        approvals: [
          {
            runId: "run-approval",
            workflowId: "workflow-1",
            nodeId: "publish",
            iteration: 2,
            status: "pending",
            prompt: "Publish the release?",
            requestedAt: now,
          },
        ],
        events: [
          {
            id: "event-approval",
            sequence: 1,
            runId: "run-approval",
            workflowId: "workflow-1",
            timestamp: now,
            type: "node.waiting-approval",
            nodeId: "publish",
            iteration: 2,
            payload: {},
          },
        ],
      },
    ]);
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByText("Publish the release?")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Inspect node.waiting-approval event",
      }),
    ).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(api.decideWorkflowApproval).toHaveBeenCalledWith(
        "run-approval",
        "publish",
        2,
        true,
      ),
    );
  });

  it("reveals structured event detail only when requested", async () => {
    api.getWorkflowExecutions.mockResolvedValue([
      {
        id: "run-detail",
        workflowId: "workflow-1",
        mode: "manual",
        status: "finished",
        finished: true,
        startedAt: now,
        stoppedAt: now,
        input: {},
        events: [
          {
            id: "event-detail",
            sequence: 1,
            runId: "run-detail",
            workflowId: "workflow-1",
            timestamp: now,
            type: "NodeFinished",
            nodeId: "digest",
            payload: { attempt: 2, result: "ready" },
          },
        ],
      },
    ]);
    render(<WorkflowEditor initial={workflow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    const inspect = await screen.findByRole("button", {
      name: "Inspect NodeFinished event",
    });
    expect(inspect.className).toContain("min-h-11");
    expect(screen.queryByText(/"result": "ready"/)).toBeNull();
    fireEvent.click(inspect);
    expect(await screen.findByText(/"result": "ready"/)).toBeTruthy();
    fireEvent.click(inspect);
    expect(screen.queryByText(/"result": "ready"/)).toBeNull();
  });
});
