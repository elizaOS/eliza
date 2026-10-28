// @vitest-environment jsdom
/** The real workflow studio; only the agent HTTP client is synthetic. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WorkflowDefinition,
  WorkflowExecution,
} from "../../../api/client-types-chat";

const io = vi.hoisted(() => ({
  getWorkflowExecutions: vi.fn(),
  getWorkflowRevisions: vi.fn(async () => []),
  getWorkflowExecution: vi.fn(),
  runWorkflowDefinition: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ client: io }));

import { WorkflowEditor } from "../WorkflowEditor";

const scheduledAt = "2026-10-28T07:30:00.000Z";
const workflow = {
  id: "flow",
  name: "Morning",
  description: "",
  source: "export default 1",
  language: "tsx",
  active: true,
  steps: [],
  versionId: "v1",
  createdAt: scheduledAt,
  updatedAt: scheduledAt,
} as unknown as WorkflowDefinition;
const run = (over: Partial<WorkflowExecution>): WorkflowExecution =>
  ({
    id: "run-missed-0001",
    status: "finished",
    finished: true,
    startedAt: "2026-10-28T09:00:00.000Z",
    mode: "trigger",
    workflowId: "flow",
    workflowVersionId: "v1",
    workflowName: "Morning",
    input: {},
    events: [],
    ...over,
  }) as WorkflowExecution;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows a missed occurrence as not run and starts a new run only after confirmation", async () => {
  io.getWorkflowExecutions.mockResolvedValue([
    run({
      output: {
        status: "missed",
        scheduledAt,
        text: "Not run: the agent was not running at the scheduled time",
      },
    }),
  ]);
  io.runWorkflowDefinition.mockResolvedValue(
    run({ id: "run-new-00001", status: "running", finished: false }),
  );
  render(<WorkflowEditor initial={workflow} />);
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));

  const notice = await screen.findByTestId("workflow-run-not-run");
  expect(notice.textContent).toContain("Missed — did not run.");
  expect(notice.textContent).toContain("nothing ran. It is not run later");
  expect(screen.getAllByText("Missed — did not run").length).toBeGreaterThan(0);
  expect(screen.queryByText("finished")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Run now" }));
  expect(io.runWorkflowDefinition).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm starting a new run now" }),
  );
  await waitFor(() =>
    expect(io.runWorkflowDefinition).toHaveBeenCalledWith("flow", {}),
  );
});

it("offers no Run now for an occurrence skipped beside an active run", async () => {
  io.getWorkflowExecutions.mockResolvedValue([
    run({
      output: { status: "overlap", scheduledAt, text: "Skipped" },
    }),
  ]);
  render(<WorkflowEditor initial={workflow} />);
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  const notice = await screen.findByTestId("workflow-run-not-run");
  expect(notice.textContent).toContain(
    "Skipped — an earlier run was still active.",
  );
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
});

it("offers no Run now for a hosted digest's missed time, which only its schedule admits", async () => {
  io.getWorkflowExecutions.mockResolvedValue([
    run({
      output: {
        status: "missed",
        scheduledAt,
        text: "The scheduled time was missed. No backlog was executed.",
      },
    }),
  ]);
  render(
    <WorkflowEditor
      initial={
        {
          ...workflow,
          metadata: { elizaHostedDigestV1: "{}" },
        } as unknown as WorkflowDefinition
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  const notice = await screen.findByTestId("workflow-run-not-run");
  expect(notice.textContent).toContain("Missed — did not run.");
  expect(notice.textContent).toContain(
    "it runs again only at its next scheduled time",
  );
  expect(notice.textContent).not.toContain("use Run now");
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  expect(io.runWorkflowDefinition).not.toHaveBeenCalled();
});
