// @vitest-environment jsdom
/**
 * TaskEditor cross-boundary migration (#12177 review fix #2).
 *
 * When an existing simple automation's schedule kind is changed across the
 * trigger <-> workbench boundary, the editor must MIGRATE (create the new type,
 * then delete the stale one) — never leave a duplicate that keeps firing.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createTriggerMock,
  updateTriggerMock,
  deleteTriggerMock,
  createWorkbenchTaskMock,
  updateWorkbenchTaskMock,
  deleteWorkbenchTaskMock,
} = vi.hoisted(() => ({
  createTriggerMock: vi.fn(),
  updateTriggerMock: vi.fn(),
  deleteTriggerMock: vi.fn(),
  createWorkbenchTaskMock: vi.fn(),
  updateWorkbenchTaskMock: vi.fn(),
  deleteWorkbenchTaskMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    createTrigger: createTriggerMock,
    updateTrigger: updateTriggerMock,
    deleteTrigger: deleteTriggerMock,
    createWorkbenchTask: createWorkbenchTaskMock,
    updateWorkbenchTask: updateWorkbenchTaskMock,
    deleteWorkbenchTask: deleteWorkbenchTaskMock,
  },
}));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}));

import { TaskEditor } from "./TaskEditor";

function save() {
  fireEvent.click(screen.getByTestId("task-editor-save"));
}

describe("TaskEditor — cross-boundary migration", () => {
  beforeEach(() => {
    for (const m of [
      createTriggerMock,
      updateTriggerMock,
      deleteTriggerMock,
      createWorkbenchTaskMock,
      updateWorkbenchTaskMock,
      deleteWorkbenchTaskMock,
    ]) {
      m.mockReset();
      m.mockResolvedValue({ ok: true });
    }
  });
  afterEach(() => cleanup());

  it("(b) editing a workbench 'once' task into a recurring schedule deletes the stale task and creates a trigger", async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditor
        initial={{
          id: "wb-1", // was a workbench task
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "once",
          cronExpression: "0 9 * * *",
          eventName: "",
        }}
        onSaved={onSaved}
      />,
    );

    // Switch to recurring, then save.
    fireEvent.click(screen.getByText("Recurring"));
    save();

    await waitFor(() => expect(createTriggerMock).toHaveBeenCalledTimes(1));
    expect(deleteWorkbenchTaskMock).toHaveBeenCalledWith("wb-1");
    // No update path, no stray trigger delete.
    expect(updateWorkbenchTaskMock).not.toHaveBeenCalled();
    expect(deleteTriggerMock).not.toHaveBeenCalled();
    expect(createTriggerMock.mock.calls[0][0]).toMatchObject({
      kind: "prompt",
      triggerType: "cron",
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("(a) editing a recurring trigger into a 'once' task deletes the stale trigger and creates a workbench task", async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditor
        initial={{
          triggerId: "tr-1", // was a trigger
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "recurring",
          cronExpression: "0 9 * * *",
          eventName: "",
        }}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByText("Once"));
    save();

    await waitFor(() =>
      expect(createWorkbenchTaskMock).toHaveBeenCalledTimes(1),
    );
    expect(deleteTriggerMock).toHaveBeenCalledWith("tr-1");
    expect(updateTriggerMock).not.toHaveBeenCalled();
    expect(deleteWorkbenchTaskMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("(c) a same-kind trigger edit updates in place — no delete, no create", async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditor
        initial={{
          triggerId: "tr-1",
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "recurring",
          cronExpression: "0 9 * * *",
          eventName: "",
        }}
        onSaved={onSaved}
      />,
    );

    // Keep it recurring; just save.
    save();

    await waitFor(() => expect(updateTriggerMock).toHaveBeenCalledTimes(1));
    expect(createTriggerMock).not.toHaveBeenCalled();
    expect(deleteTriggerMock).not.toHaveBeenCalled();
    expect(deleteWorkbenchTaskMock).not.toHaveBeenCalled();
    expect(createWorkbenchTaskMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("(c') a same-kind workbench 'once' edit updates in place — no delete, no create", async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditor
        initial={{
          id: "wb-1",
          name: "Note",
          prompt: "Do the thing",
          scheduleKind: "once",
          cronExpression: "0 9 * * *",
          eventName: "",
        }}
        onSaved={onSaved}
      />,
    );

    save();

    await waitFor(() =>
      expect(updateWorkbenchTaskMock).toHaveBeenCalledTimes(1),
    );
    expect(createWorkbenchTaskMock).not.toHaveBeenCalled();
    expect(deleteTriggerMock).not.toHaveBeenCalled();
    expect(deleteWorkbenchTaskMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});
