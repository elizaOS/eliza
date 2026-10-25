/** Prompt automations use the existing trigger API for Once, cron and events. */

import { resolveDefaultTimeZone } from "@elizaos/contracts";
import { Calendar, Clock3, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { client } from "../../api/client";
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
import { validateCronExpression } from "./trigger-form-utils";

/** How the simple automation recurs. Drives which persistence path runs. */
export type TaskScheduleKind = "once" | "recurring" | "event";

export interface TaskEditorInitialValue {
  /** Retained for legacy workbench rows; their removed API cannot be edited here. */
  id?: string;
  /** Canonical prompt trigger identity, preserved across schedule changes. */
  triggerId?: string;
  name: string;
  prompt: string;
  scheduleKind: TaskScheduleKind;
  cronExpression: string;
  eventName: string;
  scheduledAtIso: string;
  timezone: string;
  enabled: boolean;
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
  const localTimeZone = resolveDefaultTimeZone();
  const [scheduledAt, setScheduledAt] = useState(() => {
    if (!initial?.scheduledAtIso) return "";
    const date = new Date(initial.scheduledAtIso);
    return Number.isFinite(date.getTime())
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, -1)
      : "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep legacy rows visible, but never create a duplicate while editing one.
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
  const scheduledField = useAgentElement<HTMLInputElement>({
    id: "task-scheduled-at",
    role: "text-input",
    label: t("triggerform.runAt", { defaultValue: "Run at" }),
    group: "task-editor",
    description: "Explicit date and time for the one-time prompt",
    getValue: () => scheduledAt,
    onFill: setScheduledAt,
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
      if (initial?.id && !initial.triggerId) {
        throw new Error(
          "This legacy task cannot be edited as a prompt automation.",
        );
      }
      let scheduledAtIso: string | undefined;
      if (scheduleKind === "once") {
        const date = new Date(scheduledAt);
        const unchangedPausedTime =
          initial?.enabled === false &&
          date.getTime() === Date.parse(initial.scheduledAtIso ?? "");
        if (
          !Number.isFinite(date.getTime()) ||
          (!unchangedPausedTime && date.getTime() <= Date.now())
        ) {
          throw new Error("Choose a future run time for this one-time prompt.");
        }
        scheduledAtIso = date.toISOString();
      }
      if (scheduleKind === "recurring") {
        const validation = validateCronExpression(cron);
        if (!validation.ok) throw new Error(validation.message);
      }
      if (scheduleKind === "event" && !eventName.trim()) {
        throw new Error("Choose an event for this prompt.");
      }
      const request = {
        kind: "prompt" as const,
        displayName: trimmedName,
        instructions: trimmedPrompt,
        triggerType:
          scheduleKind === "recurring" ? ("cron" as const) : scheduleKind,
        scheduledAtIso,
        cronExpression: scheduleKind === "recurring" ? cron.trim() : undefined,
        eventKind: scheduleKind === "event" ? eventName.trim() : undefined,
        timezone: initial?.triggerId ? initial.timezone : localTimeZone,
      };
      if (initial?.triggerId) {
        // Same record for every schedule kind. Preserve disabled/wake policy.
        await client.updateTrigger(initial.triggerId, request);
      } else {
        await client.createTrigger({
          ...request,
          wakeMode: "inject_now",
          enabled: true,
        });
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
    scheduledAt,
    localTimeZone,
    initial?.timezone,
    initial?.enabled,
    initial?.scheduledAtIso,
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
            icon={<Zap className="size-3.5" aria-hidden />}
            checked={scheduleKind === "once"}
            onSelect={() => setScheduleKind("once")}
          />
          <ScheduleRadio
            id="task-sched-recurring"
            label={t("taskeditor.scheduleRecurring", {
              defaultValue: "Recurring",
            })}
            icon={<Clock3 className="size-3.5" aria-hidden />}
            checked={scheduleKind === "recurring"}
            onSelect={() => setScheduleKind("recurring")}
          />
          <ScheduleRadio
            id="task-sched-event"
            label={t("taskeditor.scheduleEvent", { defaultValue: "On event" })}
            icon={<Calendar className="size-3.5" aria-hidden />}
            checked={scheduleKind === "event"}
            onSelect={() => setScheduleKind("event")}
            disabled={availableEvents.length === 0}
          />
        </div>

        {scheduleKind === "once" && (
          <div className="space-y-2">
            <FieldLabel htmlFor="task-scheduled-at-input">
              {t("triggerform.runAt", { defaultValue: "Run at" })} (
              {localTimeZone})
            </FieldLabel>
            <Input
              id="task-scheduled-at-input"
              ref={scheduledField.ref}
              type="datetime-local"
              step="0.001"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              data-testid="task-editor-scheduled-at"
              {...scheduledField.agentProps}
            />
          </div>
        )}

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
              variant="config"
              density="compact"
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
          {busy ? <Spinner className="mr-2 size-3.5" /> : null}
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
      variant="choice"
      size="tiny"
      shape="circle"
      {...agentProps}
      data-state={active ? "on" : "off"}
    >
      {label}
    </Button>
  );
}
