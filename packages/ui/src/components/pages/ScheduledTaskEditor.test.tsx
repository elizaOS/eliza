/** Verifies ScheduledTaskEditor through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * jsdom tests for `ScheduledTaskEditor` over a mocked `applyScheduledTask` client:
 * verifies verb routing (run-now / acknowledge / snooze / complete / dismiss),
 * the correct label per task kind, and error surfacing when a verb fails.
 */
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
const { applyScheduledTaskMock, fireScheduledTaskMock } = vi.hoisted(() => ({
  applyScheduledTaskMock: vi.fn(),
  fireScheduledTaskMock: vi.fn(),
}));
vi.mock("../../api/client", () => ({
  client: {
    applyScheduledTask: applyScheduledTaskMock,
    fireScheduledTask: fireScheduledTaskMock,
  },
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
    fireScheduledTaskMock.mockReset();
    fireScheduledTaskMock.mockResolvedValue({
      fire: { kind: "fired", task: null },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("shows 'Run now' for a manual (paused) starter and fires the canonical dispatch", async () => {
    const onApplied = vi.fn();
    render(<ScheduledTaskEditor item={item(task())} onApplied={onApplied} />);

    fireEvent.click(screen.getByText("Run now"));
    await waitFor(() =>
      expect(fireScheduledTaskMock).toHaveBeenCalledWith("t-1"),
    );
    // The acknowledge lifecycle verb must NOT be used to trigger a run.
    expect(applyScheduledTaskMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it("reports a failed dispatch visibly instead of reporting success", async () => {
    fireScheduledTaskMock.mockResolvedValueOnce({
      fire: {
        kind: "dispatch_failed",
        error: "provider unavailable",
        task: null,
      },
    });
    const onApplied = vi.fn();
    render(<ScheduledTaskEditor item={item(task())} onApplied={onApplied} />);

    fireEvent.click(screen.getByText("Run now"));
    await waitFor(() =>
      expect(screen.getByText("provider unavailable")).toBeTruthy(),
    );
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("treats a raced claim as a completed run", async () => {
    fireScheduledTaskMock.mockResolvedValueOnce({
      fire: { kind: "raced", task: null },
    });
    const onApplied = vi.fn();
    render(<ScheduledTaskEditor item={item(task())} onApplied={onApplied} />);

    fireEvent.click(screen.getByText("Run now"));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/could not be run/i)).toBeNull();
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
    fireScheduledTaskMock.mockRejectedValue(new Error("server rejected"));
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
