/** Prompt editor persistence uses canonical triggers for all schedule kinds. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  createWorkbenchTask: vi.fn(),
  updateWorkbenchTask: vi.fn(),
  deleteWorkbenchTask: vi.fn(),
  deleteTrigger: vi.fn(),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

import { TaskEditor } from "./TaskEditor";

beforeEach(() => {
  for (const fn of Object.values(clientMock))
    fn.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);
const save = () => fireEvent.click(screen.getByTestId("task-editor-save"));
const initial = { name: "QA prompt", prompt: "Reply with QA only" };
it("requires an explicit future time for Once before any create", async () => {
  const view = render(<TaskEditor initial={initial} />);
  save();
  await waitFor(() =>
    expect(view.container.textContent).toContain("Choose a future run time"),
  );
  expect(clientMock.createTrigger).not.toHaveBeenCalled();
  expect(clientMock.createWorkbenchTask).not.toHaveBeenCalled();
});
it("creates a scheduled one-off prompt through the trigger contract", async () => {
  const onSaved = vi.fn();
  render(<TaskEditor initial={initial} onSaved={onSaved} />);
  fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
    target: { value: "2035-10-06T11:00" },
  });
  save();
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(clientMock.createTrigger).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "prompt",
      triggerType: "once",
      displayName: "QA prompt",
      instructions: "Reply with QA only",
      scheduledAtIso: new Date("2035-10-06T11:00").toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: true,
      wakeMode: "inject_now",
    }),
  );
  expect(clientMock.createWorkbenchTask).not.toHaveBeenCalled();
});
it("rejects a past run time without persisting", async () => {
  const view = render(<TaskEditor initial={initial} />);
  fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
    target: { value: "2020-01-01T11:00" },
  });
  save();
  await waitFor(() =>
    expect(view.container.textContent).toContain("Choose a future run time"),
  );
  expect(clientMock.createTrigger).not.toHaveBeenCalled();
});
it("edits a paused Once in place without changing its instant, timezone or activation policy", async () => {
  render(
    <TaskEditor
      initial={{
        ...initial,
        triggerId: "paused",
        scheduleKind: "once",
        scheduledAtIso: "2020-01-01T19:00:42.123Z",
        timezone: "America/Los_Angeles",
        enabled: false,
      }}
    />,
  );
  fireEvent.change(screen.getByTestId("task-editor-name"), {
    target: { value: "Renamed" },
  });
  save();
  await waitFor(() => expect(clientMock.updateTrigger).toHaveBeenCalledOnce());
  const [id, payload] = clientMock.updateTrigger.mock.calls[0];
  expect(id).toBe("paused");
  expect(payload).toMatchObject({
    scheduledAtIso: "2020-01-01T19:00:42.123Z",
    timezone: "America/Los_Angeles",
    displayName: "Renamed",
  });
  expect(payload).not.toHaveProperty("enabled");
  expect(payload).not.toHaveProperty("wakeMode");
  expect(clientMock.createTrigger).not.toHaveBeenCalled();
});
it("changes a recurring trigger to Once without create/delete migration", async () => {
  render(
    <TaskEditor
      initial={{
        ...initial,
        triggerId: "same",
        scheduleKind: "recurring",
        cronExpression: "0 9 * * *",
        timezone: "America/Los_Angeles",
        enabled: false,
      }}
    />,
  );
  fireEvent.click(screen.getByText("Once"));
  fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
    target: { value: "2035-10-06T11:00" },
  });
  save();
  await waitFor(() => expect(clientMock.updateTrigger).toHaveBeenCalledOnce());
  expect(clientMock.updateTrigger.mock.calls[0][1].triggerType).toBe("once");
  expect(clientMock.createTrigger).not.toHaveBeenCalled();
  expect(clientMock.deleteTrigger).not.toHaveBeenCalled();
});
it("preserves recurring edits and event creation", async () => {
  const view = render(
    <TaskEditor
      initial={{
        ...initial,
        triggerId: "cron",
        scheduleKind: "recurring",
        cronExpression: "0 9 * * *",
        timezone: "Asia/Tokyo",
      }}
    />,
  );
  save();
  await waitFor(() => expect(clientMock.updateTrigger).toHaveBeenCalledOnce());
  expect(clientMock.updateTrigger.mock.calls[0][1]).toMatchObject({
    triggerType: "cron",
    timezone: "Asia/Tokyo",
    cronExpression: "0 9 * * *",
  });
  view.unmount();
  render(
    <TaskEditor
      initial={{
        ...initial,
        scheduleKind: "event",
        eventName: "message.received",
      }}
      availableEvents={[{ id: "message.received", label: "Message" }]}
    />,
  );
  save();
  await waitFor(() => expect(clientMock.createTrigger).toHaveBeenCalledOnce());
  expect(clientMock.createTrigger.mock.calls[0][0]).toMatchObject({
    kind: "prompt",
    triggerType: "event",
    eventKind: "message.received",
  });
});
it("does not silently migrate a legacy workbench row into a duplicate trigger", async () => {
  const view = render(
    <TaskEditor
      initial={{
        ...initial,
        id: "legacy",
        scheduleKind: "recurring",
        cronExpression: "0 9 * * *",
      }}
    />,
  );
  save();
  await waitFor(() =>
    expect(view.container.textContent).toContain(
      "legacy task cannot be edited",
    ),
  );
  expect(clientMock.createTrigger).not.toHaveBeenCalled();
  expect(clientMock.updateWorkbenchTask).not.toHaveBeenCalled();
  expect(clientMock.deleteWorkbenchTask).not.toHaveBeenCalled();
});
it("retains input and does not claim save after route rejection", async () => {
  clientMock.createTrigger.mockRejectedValue(new Error("Owner role required"));
  const saved = vi.fn();
  const view = render(
    <TaskEditor
      initial={{
        ...initial,
        scheduleKind: "recurring",
        cronExpression: "0 9 * * *",
      }}
      onSaved={saved}
    />,
  );
  save();
  await waitFor(() =>
    expect(view.container.textContent).toContain("Owner role required"),
  );
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByTestId("task-editor-name")).toHaveProperty(
    "value",
    "QA prompt",
  );
});

it("leaves an existing unspecified timezone for the backend to preserve", async () => {
  render(
    <TaskEditor
      initial={{
        ...initial,
        triggerId: "legacy-zone",
        scheduleKind: "recurring",
        cronExpression: "0 9 * * *",
      }}
    />,
  );
  save();
  await waitFor(() => expect(clientMock.updateTrigger).toHaveBeenCalledOnce());
  expect(clientMock.updateTrigger.mock.calls[0][1].timezone).toBeUndefined();
});
