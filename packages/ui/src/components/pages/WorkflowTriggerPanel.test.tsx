/** Exercises native workflow trigger creation, deletion, and unavailable states with mocked elizaOS APIs. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import { WorkflowTriggerPanel } from "./WorkflowTriggerPanel";

vi.mock("../../api", () => ({
  client: {
    createTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
    getTriggers: vi.fn(),
    listWorkflowDefinitions: vi.fn(),
  },
}));

const api = client as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  api.getTriggers.mockResolvedValue({ triggers: [] });
  api.createTrigger.mockResolvedValue({ trigger: { id: "trigger-new" } });
  api.deleteTrigger.mockResolvedValue({});
  api.listWorkflowDefinitions.mockResolvedValue([
    {
      id: "source-workflow",
      name: "Research",
      active: true,
      versionId: "v1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "",
      language: "tsx",
      steps: [{ id: "collect", label: "Collect", kind: "task" }],
    },
  ]);
});

afterEach(cleanup);

describe("WorkflowTriggerPanel", () => {
  it("creates a cron trigger against the saved workflow", async () => {
    const onNeedsSave = vi.fn().mockResolvedValue("workflow-1");
    render(
      <WorkflowTriggerPanel
        workflowId="workflow-1"
        workflowName="Digest"
        onNeedsSave={onNeedsSave}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add workflow trigger" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cron" }));
    fireEvent.change(screen.getByLabelText("Cron expression"), {
      target: { value: "0 9 * * 1-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));

    await waitFor(() => expect(onNeedsSave).toHaveBeenCalledTimes(1));
    expect(api.createTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "workflow",
        workflowId: "workflow-1",
        triggerType: "cron",
        cronExpression: "0 9 * * 1-5",
        enabled: true,
      }),
    );
  });

  it("refreshes a first trigger with the workflow id returned by save", async () => {
    let finishCreate: (() => void) | undefined;
    api.createTrigger.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = () => resolve({ trigger: { id: "trigger-first" } });
        }),
    );
    api.getTriggers.mockResolvedValue({
      triggers: [
        {
          id: "trigger-first",
          kind: "workflow",
          workflowId: "workflow-1",
          workflowName: "Digest",
          displayName: "Repeat: Digest",
          instructions: "Run workflow Digest",
          triggerType: "interval",
          intervalMs: 1_800_000,
          enabled: true,
          wakeMode: "inject_now",
          createdBy: "workflow.studio",
        },
      ],
    });
    render(
      <WorkflowTriggerPanel
        workflowId=""
        workflowName="Digest"
        onNeedsSave={vi.fn().mockResolvedValue("workflow-1")}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add workflow trigger" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
    fireEvent.change(screen.getByLabelText("Interval minutes"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));

    await waitFor(() => expect(api.createTrigger).toHaveBeenCalledTimes(1));
    expect(api.getTriggers).not.toHaveBeenCalled();
    await act(async () => finishCreate?.());

    expect(
      await screen.findByRole("button", { name: "Delete Repeat trigger" }),
    ).toBeTruthy();
    expect(api.getTriggers).toHaveBeenCalledTimes(1);
  });

  it("deletes an existing trigger and refreshes the visual strip", async () => {
    api.getTriggers
      .mockResolvedValueOnce({
        triggers: [
          {
            id: "trigger-1",
            kind: "workflow",
            workflowId: "workflow-1",
            workflowName: "Digest",
            displayName: "Cron: Digest",
            instructions: "Run workflow Digest",
            triggerType: "cron",
            cronExpression: "0 9 * * 1-5",
            enabled: true,
            wakeMode: "inject_now",
            createdBy: "workflow.studio",
          },
        ],
      })
      .mockResolvedValueOnce({ triggers: [] });
    render(
      <WorkflowTriggerPanel
        workflowId="workflow-1"
        workflowName="Digest"
        onNeedsSave={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Cron trigger" }),
    );
    await waitFor(() =>
      expect(api.deleteTrigger).toHaveBeenCalledWith("trigger-1"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete Cron trigger" }),
      ).toBeNull(),
    );
  });

  it("targets an exact Smithers step with a native filtered event", async () => {
    render(
      <WorkflowTriggerPanel
        workflowId="workflow-1"
        workflowName="Digest"
        onNeedsSave={vi.fn().mockResolvedValue("workflow-1")}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add workflow trigger" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Event" }));
    await waitFor(() =>
      expect(api.listWorkflowDefinitions).toHaveBeenCalledTimes(1),
    );
    fireEvent.change(screen.getByLabelText("Event source"), {
      target: { value: "step" },
    });
    await screen.findByRole("option", { name: "Collect" });
    fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));

    await waitFor(() => expect(api.createTrigger).toHaveBeenCalledTimes(1));
    expect(api.createTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "workflow_run_event",
        eventFilter: {
          event: {
            type: "NodeFinished",
            workflowId: "source-workflow",
            nodeId: "collect",
          },
        },
      }),
    );
  });

  it("keeps manual runs visible when trigger loading is unavailable", async () => {
    api.getTriggers.mockRejectedValue(new Error("Trigger service offline"));
    render(
      <WorkflowTriggerPanel
        workflowId="workflow-1"
        workflowName="Digest"
        onNeedsSave={vi.fn()}
      />,
    );

    expect(screen.getByTitle("Manual")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Trigger service offline",
    );
  });
});
