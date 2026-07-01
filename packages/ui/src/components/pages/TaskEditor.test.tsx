// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchTask } from "../../api/client-types-config";
import { TaskEditor } from "./TaskEditor";

// Mock only the transport boundary: the typed client. Everything else
// (schedule tag encoding, validation, busy gating) is the unit under test.
const clientMock = vi.hoisted(() => ({
  createWorkbenchTask: vi.fn(),
  updateWorkbenchTask: vi.fn(),
}));
vi.mock("../../api", () => ({ client: clientMock }));

function savedTask(over: Partial<WorkbenchTask> = {}): { task: WorkbenchTask } {
  return {
    task: {
      id: "task-1",
      name: "Summarise emails",
      description: "Do the thing",
      tags: [],
      isCompleted: false,
      ...over,
    },
  };
}

/** A promise we resolve by hand, to hold a call "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

beforeEach(() => {
  clientMock.createWorkbenchTask.mockResolvedValue(savedTask());
  clientMock.updateWorkbenchTask.mockResolvedValue(savedTask());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskEditor", () => {
  it("creates a one-off task with an empty schedule tag list", async () => {
    const onSaved = vi.fn();
    render(<TaskEditor onSaved={onSaved} />);

    // "once" is the default schedule kind → no cron/event tags.
    fill("task-editor-name", "Summarise emails");
    fill("task-editor-prompt", "Summarise yesterday's inbox");
    fireEvent.click(screen.getByTestId("task-editor-save"));

    await waitFor(() =>
      expect(clientMock.createWorkbenchTask).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.createWorkbenchTask).toHaveBeenCalledWith({
      name: "Summarise emails",
      description: "Summarise yesterday's inbox",
      tags: [],
    });
    expect(clientMock.updateWorkbenchTask).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(savedTask().task),
    );
  });

  it("encodes the picked cron preset into a schedule: tag on create", async () => {
    render(<TaskEditor onSaved={vi.fn()} />);

    fill("task-editor-name", "Morning digest");
    fill("task-editor-prompt", "Send the digest");
    // Switch the schedule kind to recurring, then pick a non-default preset.
    fireEvent.click(screen.getByLabelText("Recurring"));
    fireEvent.click(screen.getByRole("button", { name: "Every hour" }));
    fireEvent.click(screen.getByTestId("task-editor-save"));

    await waitFor(() =>
      expect(clientMock.createWorkbenchTask).toHaveBeenCalledWith({
        name: "Morning digest",
        description: "Send the digest",
        tags: ["schedule:0 * * * *"],
      }),
    );
  });

  it("routes an existing task through update (not create) with an event tag", async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditor
        initial={{
          id: "task-42",
          name: "Greet on login",
          prompt: "Say hi",
          scheduleKind: "event",
          eventName: "user.login",
        }}
        availableEvents={[{ id: "user.login", label: "User login" }]}
        onSaved={onSaved}
      />,
    );

    // Edit-mode label + prefilled fields prove the initial value round-trips.
    const save = screen.getByTestId("task-editor-save");
    expect(save.textContent).toContain("Save task");
    expect(
      (screen.getByTestId("task-editor-name") as HTMLInputElement).value,
    ).toBe("Greet on login");

    fireEvent.click(save);

    await waitFor(() =>
      expect(clientMock.updateWorkbenchTask).toHaveBeenCalledWith("task-42", {
        name: "Greet on login",
        description: "Say hi",
        tags: ["event:user.login"],
      }),
    );
    expect(clientMock.createWorkbenchTask).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("keeps save gated until both title and prompt have non-whitespace content", () => {
    render(<TaskEditor onSaved={vi.fn()} />);
    const save = screen.getByTestId("task-editor-save") as HTMLButtonElement;

    expect(save.disabled).toBe(true);

    // Whitespace-only input is adversarial: must not satisfy the gate.
    fill("task-editor-name", "   ");
    fill("task-editor-prompt", "   ");
    expect(save.disabled).toBe(true);

    fill("task-editor-name", "Real title");
    expect(save.disabled).toBe(true); // prompt still blank

    fill("task-editor-prompt", "Real prompt");
    expect(save.disabled).toBe(false);

    expect(clientMock.createWorkbenchTask).not.toHaveBeenCalled();
  });

  it("does not double-submit when the save button is clicked again mid-flight", async () => {
    const pending = deferred<{ task: WorkbenchTask }>();
    clientMock.createWorkbenchTask.mockReturnValueOnce(pending.promise);
    const onSaved = vi.fn();
    render(<TaskEditor onSaved={onSaved} />);

    fill("task-editor-name", "Once only");
    fill("task-editor-prompt", "Fire once");
    const save = screen.getByTestId("task-editor-save") as HTMLButtonElement;

    fireEvent.click(save);
    // The in-flight guard disables the button; a disabled button swallows clicks.
    await waitFor(() => expect(save.disabled).toBe(true));
    fireEvent.click(save);
    fireEvent.click(save);

    expect(clientMock.createWorkbenchTask).toHaveBeenCalledTimes(1);

    pending.resolve(savedTask());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // Settles back to interactive after the single call resolves.
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(clientMock.createWorkbenchTask).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server error and re-enables save without calling onSaved", async () => {
    clientMock.createWorkbenchTask.mockRejectedValueOnce(
      new Error("workbench offline"),
    );
    const onSaved = vi.fn();
    render(<TaskEditor onSaved={onSaved} />);

    fill("task-editor-name", "Flaky task");
    fill("task-editor-prompt", "Attempt it");
    const save = screen.getByTestId("task-editor-save") as HTMLButtonElement;
    fireEvent.click(save);

    expect(await screen.findByText("workbench offline")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    await waitFor(() => expect(save.disabled).toBe(false));
  });
});
