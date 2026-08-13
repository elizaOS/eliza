/** Presents native elizaOS workflow triggers as a compact visual start surface. */
import {
  Bell,
  CalendarClock,
  Clock3,
  Plus,
  Radio,
  Repeat2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import type {
  CreateTriggerRequest,
  TriggerSummary,
  TriggerType,
} from "../../api/client-types-core";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

const EVENT_OPTIONS = [
  ["message.received", "Message"],
  ["workflow.finished", "Workflow done"],
  ["task.completed", "Task done"],
  ["calendar.event.ended", "Calendar"],
] as const;

const TYPE_META: Record<TriggerType, { label: string; icon: typeof Clock3 }> = {
  once: { label: "Once", icon: CalendarClock },
  interval: { label: "Repeat", icon: Repeat2 },
  cron: { label: "Cron", icon: Clock3 },
  event: { label: "Event", icon: Radio },
};

function triggerSummary(trigger: TriggerSummary): string {
  if (trigger.triggerType === "once" && trigger.scheduledAtIso) {
    return new Date(trigger.scheduledAtIso).toLocaleString();
  }
  if (trigger.triggerType === "interval" && trigger.intervalMs) {
    const minutes = trigger.intervalMs / 60_000;
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.round(minutes)}m`;
  }
  if (trigger.triggerType === "cron") return trigger.cronExpression ?? "—";
  return trigger.eventKind ?? "—";
}

export function WorkflowTriggerPanel({
  workflowId,
  workflowName,
  onNeedsSave,
}: {
  workflowId: string;
  workflowName: string;
  onNeedsSave: () => Promise<string | null>;
}) {
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [type, setType] = useState<TriggerType | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const id = workflowId;
    if (!id) return;
    const result = await client.getTriggers();
    setTriggers(
      result.triggers.filter(
        (trigger) => trigger.kind === "workflow" && trigger.workflowId === id,
      ),
    );
  }, [workflowId]);

  useEffect(() => {
    void refresh().catch((cause) => {
      // error-policy:J4 the trigger strip remains usable for manual runs while
      // an unavailable trigger service is shown as an explicit error state.
      setError(cause instanceof Error ? cause.message : "Triggers unavailable");
    });
  }, [refresh]);

  const create = useCallback(async () => {
    if (!type) return;
    setBusy(true);
    setError(null);
    try {
      const id = await onNeedsSave();
      if (!id) return;
      const request: CreateTriggerRequest = {
        kind: "workflow",
        workflowId: id,
        workflowName,
        displayName: `${TYPE_META[type].label}: ${workflowName}`,
        instructions: `Run workflow ${workflowName}`,
        triggerType: type,
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "workflow.studio",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (type === "once")
        request.scheduledAtIso = new Date(value).toISOString();
      if (type === "interval") request.intervalMs = Number(value) * 60_000;
      if (type === "cron") request.cronExpression = value;
      if (type === "event") request.eventKind = value;
      await client.createTrigger(request);
      setType(null);
      setValue("");
      await refresh();
    } catch (cause) {
      // error-policy:J4 create failures remain visible beside the attempted trigger.
      setError(
        cause instanceof Error ? cause.message : "Unable to add trigger",
      );
    } finally {
      setBusy(false);
    }
  }, [onNeedsSave, refresh, type, value, workflowName]);

  return (
    <section
      aria-label="Workflow triggers"
      className="border-b border-border/50 bg-card/40 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
          title="Start"
        >
          <Bell className="h-3.5 w-3.5" />
          <span className="sr-only">Start</span>
        </span>
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
          title="Manual"
        />
        {triggers.map((trigger) => {
          const meta = TYPE_META[trigger.triggerType];
          const Icon = meta.icon;
          return (
            <span
              key={trigger.id}
              className="group flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-xs"
              title={`${meta.label} · ${triggerSummary(trigger)}`}
            >
              <Icon className="h-3.5 w-3.5 text-primary" />
              <span>{triggerSummary(trigger)}</span>
              <button
                type="button"
                className="ml-0.5 text-muted-foreground opacity-40 hover:text-destructive group-hover:opacity-100"
                aria-label={`Delete ${meta.label} trigger`}
                onClick={() =>
                  void client
                    .deleteTrigger(trigger.id)
                    .then(refresh)
                    .catch((cause) => {
                      // error-policy:J4 deletion failures preserve the trigger and surface the error.
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Unable to delete trigger",
                      );
                    })
                }
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-full"
          aria-label="Add workflow trigger"
          onClick={() => setType((current) => current ?? "once")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {type ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="workflow-trigger-form"
        >
          {(Object.keys(TYPE_META) as TriggerType[]).map((option) => {
            const Icon = TYPE_META[option].icon;
            return (
              <button
                key={option}
                type="button"
                className={`grid h-8 w-8 place-items-center rounded-md ${type === option ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                aria-label={TYPE_META[option].label}
                aria-pressed={type === option}
                title={TYPE_META[option].label}
                onClick={() => {
                  setType(option);
                  setValue(option === "event" ? EVENT_OPTIONS[0][0] : "");
                }}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
          {type === "event" ? (
            <select
              aria-label="Event"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="h-8 min-w-40 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            >
              {EVENT_OPTIONS.map(([eventKind, label]) => (
                <option key={eventKind} value={eventKind}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={
                type === "once"
                  ? "datetime-local"
                  : type === "interval"
                    ? "number"
                    : "text"
              }
              min={type === "interval" ? 1 : undefined}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                type === "interval"
                  ? "Minutes"
                  : type === "cron"
                    ? "0 9 * * 1-5"
                    : undefined
              }
              aria-label={
                type === "interval"
                  ? "Interval minutes"
                  : type === "cron"
                    ? "Cron expression"
                    : "Start time"
              }
              className="h-8 min-w-40 flex-1 text-xs"
            />
          )}
          <Button
            size="icon-sm"
            aria-label="Save trigger"
            disabled={busy || !value}
            onClick={() => void create()}
          >
            {busy ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel trigger"
            onClick={() => setType(null)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
