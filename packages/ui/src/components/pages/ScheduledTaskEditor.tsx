/**
 * ScheduledTaskEditor — owner-facing detail + verb panel for a LifeOps
 * scheduled item (glossary term) surfaced in the unified Automations feed.
 *
 * Scheduled items are owned by the LifeOps runner (the single scheduling
 * spine), NOT the workflow CRUD. So this panel routes its actions to the
 * scheduled-item verb endpoints via `client.applyScheduledTask` — run
 * (acknowledge), complete, dismiss, snooze — rather than the workflow
 * create/update path. It is a thin verb surface, not a full schedule editor:
 * the schedule itself is defined by the seeded definition / chat, consistent
 * with the one-scheduler rule. The code type stays `ScheduledTask` (frozen
 * contract); only the prose/UI say "scheduled item".
 */

import { Bell, CalendarClock, Check, Clock, X } from "lucide-react";
import { useCallback, useState } from "react";
import { client } from "../../api";
import type { ScheduledTaskVerbName } from "../../api/client-scheduled-tasks";
import type { AutomationItem } from "../../api/client-types-config";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { scheduledTaskScheduleLabel } from "../../utils/scheduled-task-to-automation";
import { Button } from "../ui/button";
import { FieldLabel } from "../ui/field";
import { StatusBadge } from "../ui/status-badge";

export interface ScheduledTaskEditorProps {
  /** The unified item whose `scheduledTask` is the raw record. */
  item: AutomationItem;
  onApplied?: () => void;
  onCancel?: () => void;
}

const SNOOZE_MINUTES = 60;

export function ScheduledTaskEditor({
  item,
  onApplied,
  onCancel,
}: ScheduledTaskEditorProps) {
  const { t } = useTranslation();
  const task = item.scheduledTask;
  const [busy, setBusy] = useState<ScheduledTaskVerbName | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    async (verb: ScheduledTaskVerbName, payload?: Record<string, unknown>) => {
      if (!task) return;
      setBusy(verb);
      setError(null);
      try {
        await client.applyScheduledTask(task.taskId, verb, payload);
        onApplied?.();
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("scheduledtask.applyError", {
                defaultValue: "Failed to update scheduled item.",
              }),
        );
      } finally {
        setBusy(null);
      }
    },
    [task, onApplied, t],
  );

  if (!task) {
    return (
      <div className="p-6">
        <div className="text-sm text-danger">
          {t("scheduledtask.missing", {
            defaultValue: "This scheduled item is no longer available.",
          })}
        </div>
        <Button variant="ghost" size="sm" className="mt-3" onClick={onCancel}>
          {t("automationsfeed.back", { defaultValue: "Back" })}
        </Button>
      </div>
    );
  }

  const scheduleLabel = scheduledTaskScheduleLabel(task.trigger);
  const isManual = task.trigger.kind === "manual";

  return (
    <div className="device-layout mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4 lg:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CalendarClock className="h-5 w-5 shrink-0 text-accent" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-txt">
              {item.title}
            </h1>
            <StatusBadge
              withDot
              tone={item.enabled ? "success" : "muted"}
              label={
                item.enabled
                  ? t("automationsfeed.active", { defaultValue: "Active" })
                  : t("automationsfeed.inactive", { defaultValue: "Inactive" })
              }
            />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("automationsfeed.back", { defaultValue: "Back" })}
        </Button>
      </div>

      <div className="space-y-4">
        <div className="space-y-1">
          <FieldLabel>
            {t("scheduledtask.schedule", { defaultValue: "Schedule" })}
          </FieldLabel>
          <p className="text-sm text-muted-strong">
            {scheduleLabel ??
              t("scheduledtask.noSchedule", { defaultValue: "No schedule" })}
          </p>
        </div>
        <div className="space-y-1">
          <FieldLabel>
            {t("scheduledtask.prompt", { defaultValue: "What it does" })}
          </FieldLabel>
          <p className="whitespace-pre-wrap text-sm text-txt">
            {task.promptInstructions}
          </p>
        </div>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      <div className="flex flex-wrap gap-2">
        {/* Run now = acknowledge (fire the task immediately for manual/paused
            starters like the seeded weekly review). */}
        <Button
          variant="default"
          size="sm"
          disabled={busy !== null}
          onClick={() => apply("acknowledge")}
        >
          <Bell className="mr-1 h-3.5 w-3.5" aria-hidden />
          {isManual
            ? t("scheduledtask.runNow", { defaultValue: "Run now" })
            : t("scheduledtask.acknowledge", { defaultValue: "Acknowledge" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => apply("snooze", { minutes: SNOOZE_MINUTES })}
        >
          <Clock className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t("scheduledtask.snooze", { defaultValue: "Snooze 1h" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => apply("complete")}
        >
          <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t("scheduledtask.complete", { defaultValue: "Complete" })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => apply("dismiss")}
        >
          <X className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t("scheduledtask.dismiss", { defaultValue: "Dismiss" })}
        </Button>
      </div>
    </div>
  );
}
