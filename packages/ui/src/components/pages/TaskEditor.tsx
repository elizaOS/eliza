/**
 * TaskEditor — single-screen editor for a prompt automation (glossary term):
 * title, prompt, and a schedule (once / recurring cron / on-event). No node
 * graph — that's a workflow, a separate surface (WorkflowEditor).
 *
 * Most users land here and don't need a node graph. A recurring or
 * on-event schedule is a prompt-kind `TriggerConfig` — the editor creates
 * it via the trigger API (`client.createTrigger` with `kind: "prompt"`,
 * no workflowId), and the one trigger clock fires the prompt as an agent
 * turn. A plain "once" task with no recurrence stays a workbench task
 * (`client.createWorkbenchTask`). Schedule is never encoded onto tags.
 */

import { Calendar, Clock3, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { CRON_PRESETS, formatSchedule } from "../../utils/cron-format";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

/** How the simple automation recurs. Drives which persistence path runs. */
export type TaskScheduleKind = "once" | "recurring" | "event";

export interface TaskEditorInitialValue {
  /** Workbench-task id, set only when editing a plain "once" task. */
  id?: string;
  /**
   * Trigger id, set only when editing an existing prompt-kind trigger
   * (`scheduleKind` is "recurring" or "event"). Mutually exclusive with `id`.
   */
  triggerId?: string;
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
  onSaved?: () => void;
  onCancel?: () => void;
}

export function TaskEditor({
  initial,
  availableEvents = [],
  onSaved,
  onCancel,
}: TaskEditorProps) {
  const { t } = useTranslation();
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

  // Editing an existing automation when either a workbench-task id (plain
  // "once" task) or a trigger id (recurring/event prompt trigger) is present.
  const isEditing = Boolean(initial?.id || initial?.triggerId);

  const cronPreview = useMemo(
    () => (scheduleKind === "recurring" ? formatSchedule(cron) : null),
    [scheduleKind, cron],
  );

  const nameField = useAgentElement<HTMLInputElement>({
    id: "task-title",
    role: "text-input",
    label: t("taskeditor.titleLabel", { defaultValue: "Title" }),
    group: "task-editor",
    description: "Prompt automation title",
    getValue: () => name,
    onFill: (value) => setName(value),
  });
  const promptField = useAgentElement<HTMLTextAreaElement>({
    id: "task-prompt",
    role: "textarea",
    label: t("taskeditor.promptLabel", { defaultValue: "Prompt" }),
    group: "task-editor",
    description: "Prompt the agent runs for this prompt automation",
    getValue: () => prompt,
    onFill: (value) => setPrompt(value),
  });
  const cronField = useAgentElement<HTMLInputElement>({
    id: "task-cron",
    role: "text-input",
    label: t("taskeditor.cronLabel", { defaultValue: "Cron expression" }),
    group: "task-editor",
    description: "Cron expression for the recurring schedule",
    getValue: () => cron,
    onFill: (value) => setCron(value),
  });
  const eventField = useAgentElement<HTMLButtonElement>({
    id: "task-event",
    role: "select",
    label: t("taskeditor.eventLabel", { defaultValue: "Trigger event" }),
    group: "task-editor",
    description: "Trigger event that runs this prompt automation",
    options: availableEvents.map((event) => event.id),
    getValue: () => eventName,
    onFill: (value) => setEventName(value),
  });
  const cancelButton = useAgentElement<HTMLButtonElement>({
    id: "task-cancel",
    role: "button",
    label: t("taskeditor.cancel", { defaultValue: "Cancel" }),
    group: "task-editor",
    description: "Discard changes and close the editor",
    onActivate: () => onCancel?.(),
  });
  const saveButton = useAgentElement<HTMLButtonElement>({
    id: "task-save",
    role: "button",
    label: isEditing
      ? t("taskeditor.saveTask", { defaultValue: "Save prompt automation" })
      : t("taskeditor.createTask", {
          defaultValue: "Create prompt automation",
        }),
    group: "task-editor",
    description: "Save the prompt automation",
  });

  const submit = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setError(
        t("taskeditor.titleRequired", { defaultValue: "Title is required." }),
      );
      return;
    }
    if (!trimmedPrompt) {
      setError(
        t("taskeditor.promptRequired", { defaultValue: "Prompt is required." }),
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (scheduleKind === "recurring" || scheduleKind === "event") {
        // A recurring or on-event schedule is a prompt-kind trigger: the one
        // trigger clock fires `instructions` as an agent turn. No workflowId.
        const request = {
          kind: "prompt" as const,
          displayName: trimmedName,
          instructions: trimmedPrompt,
          triggerType:
            scheduleKind === "recurring"
              ? ("cron" as const)
              : ("event" as const),
          cronExpression:
            scheduleKind === "recurring" ? cron.trim() : undefined,
          eventKind: scheduleKind === "event" ? eventName.trim() : undefined,
          wakeMode: "inject_now" as const,
          enabled: true,
        };
        if (initial?.triggerId) {
          await client.updateTrigger(initial.triggerId, request);
        } else {
          await client.createTrigger(request);
          // Cross-boundary edit: this automation was a workbench "once" task and
          // is now a trigger. Delete the stale workbench task so it doesn't keep
          // existing alongside the new trigger (no duplicate).
          if (initial?.id) {
            await client.deleteWorkbenchTask(initial.id);
          }
        }
      } else {
        // Plain "once" task with no recurrence — a workbench task.
        const payload = { name: trimmedName, description: trimmedPrompt };
        if (initial?.id) {
          await client.updateWorkbenchTask(initial.id, payload);
        } else {
          await client.createWorkbenchTask(payload);
          // Cross-boundary edit: this automation was a recurring/event trigger
          // and is now a plain "once" task. Delete the stale trigger so it stops
          // firing (no duplicate).
          if (initial?.triggerId) {
            await client.deleteTrigger(initial.triggerId);
          }
        }
      }
      onSaved?.();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("taskeditor.saveError", {
              defaultValue: "Failed to save prompt automation.",
            }),
      );
    } finally {
      setBusy(false);
    }
  }, [
    name,
    prompt,
    scheduleKind,
    cron,
    eventName,
    initial?.id,
    initial?.triggerId,
    onSaved,
    t,
  ]);

  return (
    <PagePanel variant="padded" className="space-y-5">
      {error && <div className="p-2 text-sm text-danger">{error}</div>}

      <div className="space-y-2">
        <FieldLabel>
          {t("taskeditor.titleLabel", { defaultValue: "Title" })}
        </FieldLabel>
        <Input
          ref={nameField.ref}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("taskeditor.titlePlaceholder", {
            defaultValue: "Summarise yesterday's emails",
          })}
          autoFocus
          data-testid="task-editor-name"
          {...nameField.agentProps}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel>
          {t("taskeditor.promptLabel", { defaultValue: "Prompt" })}
        </FieldLabel>
        <Textarea
          ref={promptField.ref}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("taskeditor.promptPlaceholder", {
            defaultValue: "What should the agent do when this runs?",
          })}
          rows={5}
          data-testid="task-editor-prompt"
          {...promptField.agentProps}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-xs text-muted">
          {t("taskeditor.scheduleLegend", { defaultValue: "Schedule" })}
        </legend>
        <div className="flex flex-wrap gap-2">
          <ScheduleRadio
            id="task-sched-once"
            label={t("taskeditor.scheduleOnce", { defaultValue: "Once" })}
            icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "once"}
            onSelect={() => setScheduleKind("once")}
          />
          <ScheduleRadio
            id="task-sched-recurring"
            label={t("taskeditor.scheduleRecurring", {
              defaultValue: "Recurring",
            })}
            icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "recurring"}
            onSelect={() => setScheduleKind("recurring")}
          />
          <ScheduleRadio
            id="task-sched-event"
            label={t("taskeditor.scheduleEvent", { defaultValue: "On event" })}
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
                <CronPresetButton
                  key={preset.expression}
                  label={preset.label}
                  expression={preset.expression}
                  active={cron === preset.expression}
                  onSelect={setCron}
                />
              ))}
            </div>
            <Input
              ref={cronField.ref}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono text-xs"
              data-testid="task-editor-cron"
              {...cronField.agentProps}
            />
            {cronPreview && (
              <div className="text-xs text-muted-strong">
                {t("taskeditor.runsPrefix", { defaultValue: "Runs " })}
                <span className="text-txt">{cronPreview.toLowerCase()}</span>.
              </div>
            )}
          </div>
        )}

        {scheduleKind === "event" && availableEvents.length > 0 && (
          <Select value={eventName} onValueChange={setEventName}>
            <SelectTrigger
              ref={eventField.ref}
              className="w-full rounded-sm border-border/40 bg-bg text-sm text-txt"
              data-testid="task-editor-event"
              {...eventField.agentProps}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableEvents.map((event) => (
                <SelectItem key={event.id} value={event.id}>
                  {event.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </fieldset>

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <Button
            ref={cancelButton.ref}
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            {...cancelButton.agentProps}
          >
            {t("taskeditor.cancel", { defaultValue: "Cancel" })}
          </Button>
        )}
        <Button
          ref={saveButton.ref}
          variant="default"
          size="sm"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !prompt.trim()}
          data-testid="task-editor-save"
          {...saveButton.agentProps}
        >
          {busy ? <Spinner className="mr-2 h-3.5 w-3.5" /> : null}
          {isEditing
            ? t("taskeditor.saveTask", {
                defaultValue: "Save prompt automation",
              })
            : t("taskeditor.createTask", {
                defaultValue: "Create prompt automation",
              })}
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
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id,
    role: "tab",
    label,
    group: "task-schedule-kind",
    description: `Set the schedule to ${label}`,
    status: checked ? "active" : "inactive",
    onActivate: onSelect,
  });
  return (
    <label
      htmlFor={id}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs transition-colors ${
        disabled
          ? "cursor-not-allowed border-border/30 text-muted opacity-60"
          : checked
            ? "border-accent bg-accent/10 text-accent"
            : "border-border/40 text-muted-strong hover:border-border"
      }`}
    >
      <Input
        ref={ref}
        id={id}
        type="radio"
        name="task-schedule-kind"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        aria-current={checked ? "true" : undefined}
        {...agentProps}
      />
      {icon}
      {label}
    </label>
  );
}

function CronPresetButton({
  label,
  expression,
  active,
  onSelect,
}: {
  label: string;
  expression: string;
  active: boolean;
  onSelect: (expression: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `task-cron-preset-${expression.replace(/[^a-z0-9]+/gi, "-")}`,
    role: "button",
    label,
    group: "task-cron-presets",
    description: `Use the ${label} cron preset`,
    status: active ? "active" : "inactive",
    onActivate: () => onSelect(expression),
  });
  return (
    <Button
      ref={ref}
      onClick={() => onSelect(expression)}
      variant="ghost"
      size="sm"
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border/40 text-muted-strong hover:border-border"
      }`}
      {...agentProps}
    >
      {label}
    </Button>
  );
}
