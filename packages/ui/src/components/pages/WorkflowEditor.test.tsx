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
    createWorkflowDefinition: vi.fn(),
    deactivateWorkflowDefinition: vi.fn(),
    decideWorkflowApproval: vi.fn(),
    getWorkflowExecution: vi.fn(),
    getWorkflowExecutions: vi.fn(),
    getWorkflowRevisions: vi.fn(),
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
  api.getWorkflowRevisions.mockResolvedValue({
    currentVersionId: "v1",
    revisions: [],
  });
  api.createWorkflowDefinition.mockResolvedValue(workflow());
  api.updateWorkflowDefinition.mockResolvedValue(workflow());
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
  it("renders native source and reveals optional schedule controls on demand", async () => {
    render(<WorkflowEditor initial={workflow()} />);
    expect(screen.getByText("Build digest")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(
      (screen.getByTestId("smithers-source-editor") as HTMLTextAreaElement)
        .value,
    ).toMatch(/smthrs\/create/);
    expect(screen.queryByLabelText("Workflow cron schedule")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByLabelText("Workflow cron schedule")).toBeTruthy();
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
      expect(api.runWorkflowDefinition).toHaveBeenCalledWith("workflow-1"),
    );
    await waitFor(() => expect(api.getWorkflowRevisions).toHaveBeenCalled());
  });
});
