/** Exercises the native Smithers studio over mocked elizaOS Cloud workflow APIs. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type { WorkflowDefinition } from "../../api/client-types-chat";
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

  it("persists a new workflow before starting its first run", async () => {
    render(<WorkflowEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(api.createWorkflowDefinition).toHaveBeenCalledTimes(1),
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

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("button", { name: "Restore revision" }),
    ).toBeTruthy();
    expect(screen.getByText("8/12/2026, 12:00:00 PM")).toBeTruthy();
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
});
