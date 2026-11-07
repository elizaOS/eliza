// @vitest-environment jsdom
/** The neutral task choice leaf, with a synthetic host transport. */
import type { TaskChoiceWidget } from "@elizaos/core/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskChoice } from "../TaskChoice";

afterEach(cleanup);

const widget = (overrides: Partial<TaskChoiceWidget> = {}): TaskChoiceWidget => ({
  schemaVersion: 1,
  taskId: "task-1",
  epoch: 0,
  contextKey: "a".repeat(64),
  callbackData: `is1:${"b".repeat(32)}`,
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  state: "pending",
  block: {
    kind: "choice",
    id: "method",
    scope: "task",
    prompt: "How should this bill be paid?",
    options: [
      { value: "saved", label: "Existing method" },
      { value: "new", label: "A different method" },
    ],
  },
  ...overrides,
});

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

it("a consumed tap removes the options at once and reports the chosen label", async () => {
  const sent = deferred();
  const onChoose = vi.fn(() => sent.promise);
  const onAccepted = vi.fn();
  const { rerender } = render(
    <TaskChoice
      widget={widget()}
      taskId="task-1"
      onChoose={onChoose}
      onAccepted={onAccepted}
      consumeOnChoose
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Existing method" }));
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.getByText("Existing method")).toBeTruthy();
  expect(onChoose).toHaveBeenCalledWith("saved");
  expect(onAccepted).not.toHaveBeenCalled();
  await act(async () => sent.resolve());
  expect(onAccepted).toHaveBeenCalledWith("Existing method");
  rerender(
    <TaskChoice
      widget={widget({ state: "committed" })}
      taskId="task-1"
      onChoose={onChoose}
      onAccepted={onAccepted}
      consumeOnChoose
    />,
  );
  // The host shows the answer; no generic received line is added.
  expect(screen.queryByText("Your choice was received.")).toBeNull();
});

it("a failed consumed choice restores the options and never reports acceptance", async () => {
  const sent = deferred();
  const onAccepted = vi.fn();
  render(
    <TaskChoice
      widget={widget()}
      taskId="task-1"
      onChoose={() => sent.promise}
      onAccepted={onAccepted}
      consumeOnChoose
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "A different method" }));
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  await act(async () => sent.reject(new Error("lost")));
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("alert").textContent).toMatch(/could not be sent/);
  expect(onAccepted).not.toHaveBeenCalled();
});

it("without consumeOnChoose the options stay and are disabled while sending", async () => {
  const sent = deferred();
  render(
    <TaskChoice widget={widget()} taskId="task-1" onChoose={() => sent.promise} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Existing method" }));
  const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
  expect(buttons).toHaveLength(2);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () => sent.resolve());
});
