// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationItem } from "../../api/client-types-config";
import type { ScheduledTaskView } from "../../api/client-types-core";

// The editor routes verbs to the scheduled-task endpoints via the typed client.
const { applyScheduledTaskMock } = vi.hoisted(() => ({
  applyScheduledTaskMock: vi.fn(),
}));
vi.mock("../../api", () => ({
  client: { applyScheduledTask: applyScheduledTaskMock },
}));
// Translation: echo the defaultValue so we can assert on the English copy.
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}));

import { ScheduledTaskEditor } from "./ScheduledTaskEditor";

function task(over: Partial<ScheduledTaskView> = {}): ScheduledTaskView {
  return {
    taskId: "t-1",
    kind: "recap",
    promptInstructions: "Review the week",
    trigger: { kind: "manual" },
    priority: "low",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "daily-rhythm",
    ownerVisible: true,
    metadata: { recordKey: "weekly-review" },
    ...over,
  };
}

function item(scheduledTask: ScheduledTaskView | undefined): AutomationItem {
  return {
    id: "scheduled:t-1",
    type: "coordinator_text",
    source: "scheduled_task",
    title: "Weekly review",
    description: "Review the week",
    status: "paused",
    enabled: false,
    system: false,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt: null,
    schedules: [],
    scheduledTask,
  };
}

describe("ScheduledTaskEditor", () => {
  beforeEach(() => {
    applyScheduledTaskMock.mockReset();
    applyScheduledTaskMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
  });

  it("shows 'Run now' for a manual (paused) starter and acknowledges it", async () => {
    const onApplied = vi.fn();
    render(<ScheduledTaskEditor item={item(task())} onApplied={onApplied} />);

    fireEvent.click(screen.getByText("Run now"));
    await waitFor(() =>
      expect(applyScheduledTaskMock).toHaveBeenCalledWith(
        "t-1",
        "acknowledge",
        undefined,
      ),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it("labels the run button 'Acknowledge' for a non-manual task", () => {
    render(
      <ScheduledTaskEditor
        item={item(
          task({
            trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
          }),
        )}
      />,
    );
    expect(screen.getByText("Acknowledge")).toBeTruthy();
    expect(screen.queryByText("Run now")).toBeNull();
  });

  it("routes snooze with a 60-minute payload", async () => {
    render(<ScheduledTaskEditor item={item(task())} />);
    fireEvent.click(screen.getByText("Snooze 1h"));
    await waitFor(() =>
      expect(applyScheduledTaskMock).toHaveBeenCalledWith("t-1", "snooze", {
        minutes: 60,
      }),
    );
  });

  it("routes complete and dismiss", async () => {
    render(<ScheduledTaskEditor item={item(task())} />);
    // Buttons disable while a verb is in flight, so let complete settle before
    // dismissing.
    fireEvent.click(screen.getByText("Complete"));
    await waitFor(() =>
      expect(applyScheduledTaskMock).toHaveBeenCalledWith(
        "t-1",
        "complete",
        undefined,
      ),
    );
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() =>
      expect(applyScheduledTaskMock).toHaveBeenCalledWith(
        "t-1",
        "dismiss",
        undefined,
      ),
    );
  });

  it("surfaces an error and does not call onApplied when the verb fails", async () => {
    applyScheduledTaskMock.mockRejectedValue(new Error("server rejected"));
    const onApplied = vi.fn();
    render(<ScheduledTaskEditor item={item(task())} onApplied={onApplied} />);

    fireEvent.click(screen.getByText("Run now"));
    await waitFor(() =>
      expect(screen.getByText("server rejected")).toBeTruthy(),
    );
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("renders an unavailable state when the raw record is missing", () => {
    render(<ScheduledTaskEditor item={item(undefined)} />);
    expect(
      screen.getByText("This scheduled item is no longer available."),
    ).toBeTruthy();
    expect(applyScheduledTaskMock).not.toHaveBeenCalled();
  });
});
