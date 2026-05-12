/**
 * TaskEditor — single-screen editor for a "simple" automation: title,
 * prompt, and a schedule (once / recurring cron / on-event).
 *
 * Most users land here and don't need a node graph. The editor calls
 * `client.createWorkbenchTask` / `client.updateWorkbenchTask`. The
 * schedule is stored as `tags` because the WorkbenchTask shape doesn't
 * have a dedicated schedule field — the existing AutomationsView already
 * uses tags as free-form metadata. When the workflow plugin grows a
 * dedicated `cron` field on WorkbenchTask we can drop the tag encoding.
 */

import { Button } from "../ui/button";
import { FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { PagePanel } from "../composites/page-panel";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Calendar, Clock3, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { client } from "../../api";
import type { WorkbenchTask } from "../../api/client-types-config";
import { CRON_PRESETS, formatSchedule } from "../../utils/cron-format";
import {
  encodeScheduleTags,
  type TaskScheduleKind,
} from "../../utils/task-schedule";

export type { TaskScheduleKind } from "../../utils/task-schedule";
export {
  decodeScheduleTags,
  encodeScheduleTags,
} from "../../utils/task-schedule";

export interface TaskEditorInitialValue {
  id?: string;
  name: string;
  prompt: string;
  scheduleKind: TaskScheduleKind;
  cronExpression: string;
  eventName: string;
}

export interface TaskEditorProps {
  initial?: Partial<TaskEditorInitialValue>;
  /**
   * Available trigger events the user can pick from. The host should
   * source this from the runtime's trigger catalog. We accept it as a
   * prop so this component stays free of upstream coupling.
   */
  availableEvents?: ReadonlyArray<{ id: string; label: string }>;
  onSaved?: (task: WorkbenchTask) => void;
  onCancel?: () => void;
}

export function TaskEditor({
  initial,
  availableEvents = [],
  onSaved,
  onCancel,
}: TaskEditorProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [scheduleKind, setScheduleKind] = useState<TaskScheduleKind>(
    initial?.scheduleKind ?? "once",
  );
  const [cron, setCron] = useState(
    initial?.cronExpression ?? CRON_PRESETS[1].expression,
  );
  const [eventName, setEventName] = useState(
    initial?.eventName ?? availableEvents[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronPreview = useMemo(
    () => (scheduleKind === "recurring" ? formatSchedule(cron) : null),
    [scheduleKind, cron],
  );

  const submit = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setError("Title is required.");
      return;
    }
    if (!trimmedPrompt) {
      setError("Prompt is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const tags = encodeScheduleTags(scheduleKind, cron, eventName);
      const payload = {
        name: trimmedName,
        description: trimmedPrompt,
        tags,
      };
      const res = initial?.id
        ? await client.updateWorkbenchTask(initial.id, payload)
        : await client.createWorkbenchTask(payload);
      onSaved?.(res.task);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save task.");
    } finally {
      setBusy(false);
    }
  }, [name, prompt, scheduleKind, cron, eventName, initial?.id, onSaved]);

  return (
    <PagePanel variant="padded" className="space-y-5">
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-txt">
          {initial?.id ? "Edit task" : "New task"}
        </h2>
        <p className="text-sm text-muted-strong">
          A task is a single prompt the agent runs — once, on a schedule, or in
          response to an event.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <FieldLabel>Title</FieldLabel>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Summarise yesterday's emails"
          autoFocus
          data-testid="task-editor-name"
        />
      </div>

      <div className="space-y-2">
        <FieldLabel>Prompt</FieldLabel>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do when this task runs?"
          rows={5}
          data-testid="task-editor-prompt"
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-txt">Schedule</legend>
        <div className="flex flex-wrap gap-2">
          <ScheduleRadio
            id="task-sched-once"
            label="Once"
            icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "once"}
            onSelect={() => setScheduleKind("once")}
          />
          <ScheduleRadio
            id="task-sched-recurring"
            label="Recurring"
            icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "recurring"}
            onSelect={() => setScheduleKind("recurring")}
          />
          <ScheduleRadio
            id="task-sched-event"
            label="On event"
            icon={<Calendar className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "event"}
            onSelect={() => setScheduleKind("event")}
            disabled={availableEvents.length === 0}
          />
        </div>

        {scheduleKind === "recurring" && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.expression}
                  type="button"
                  onClick={() => setCron(preset.expression)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    cron === preset.expression
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border/40 text-muted-strong hover:border-border"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono text-xs"
              data-testid="task-editor-cron"
            />
            {cronPreview && (
              <div className="text-xs text-muted-strong">
                Runs{" "}
                <span className="text-txt">{cronPreview.toLowerCase()}</span>.
              </div>
            )}
          </div>
        )}

        {scheduleKind === "event" && availableEvents.length > 0 && (
          <select
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            className="w-full rounded-md border border-border/40 bg-bg px-3 py-2 text-sm text-txt"
            data-testid="task-editor-event"
          >
            {availableEvents.map((event) => (
              <option key={event.id} value={event.id}>
                {event.label}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <div className="flex items-center justify-end gap-2 border-t border-border/40 pt-4">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button
          variant="default"
          size="sm"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !prompt.trim()}
          data-testid="task-editor-save"
        >
          {busy ? <Spinner className="mr-2 h-3.5 w-3.5" /> : null}
          {initial?.id ? "Save task" : "Create task"}
        </Button>
      </div>
    </PagePanel>
  );
}

function ScheduleRadio({
  id,
  label,
  icon,
  checked,
  onSelect,
  disabled,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
        disabled
          ? "cursor-not-allowed border-border/30 text-muted opacity-60"
          : checked
            ? "border-accent bg-accent/10 text-accent"
            : "border-border/40 text-muted-strong hover:border-border"
      }`}
    >
      <input
        id={id}
        type="radio"
        name="task-schedule-kind"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
      />
      {icon}
      {label}
    </label>
  );
}
