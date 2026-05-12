import {
  Button,
  FieldLabel,
  FieldSwitch,
  FormSelect,
  FormSelectItem,
  Input,
  PagePanel,
  StatusDot,
  Textarea,
} from "@elizaos/ui";
import { useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type { TriggerSummary, WorkflowDefinition } from "../../api/client";
import { formatDateTime, formatDurationMs } from "../../utils/format";
import {
  detectUiHostCapabilities,
  intervalHostWarning,
} from "../../utils/host-capabilities";
import {
  DURATION_UNITS,
  durationToMs,
  durationUnitLabel,
  formFromTrigger,
  humanizeEventKind,
  localizedExecutionStatus,
  nextRunsForCron,
  nextRunsForInterval,
  type TranslateFn,
  type TriggerFormState,
  validateCronExpression,
} from "./heartbeat-utils";

const EVENT_KIND_OPTIONS = [
  {
    value: "message.received",
    label: "Message received",
  },
  {
    value: "discord.message.received",
    label: "Discord message",
  },
  {
    value: "telegram.message.received",
    label: "Telegram message",
  },
  {
    value: "gmail.message.received",
    label: "Gmail message",
  },
  {
    value: "calendar.event.ended",
    label: "Calendar event ended",
  },
] as const;

// ── Props ──────────────────────────────────────────────────────────

export interface HeartbeatFormProps {
  /** Current form state. */
  form: TriggerFormState;
  /** ID of the trigger being edited, or null when creating. */
  editingId: string | null;
  /** Whether the trigger (or form default) is enabled. */
  editorEnabled: boolean;
  /** Computed modal/editor title. */
  modalTitle: string;
  /** Form validation error message, if any. */
  formError: string | null;
  /** True while a save/create request is in flight. */
  triggersSaving: boolean;
  /** Template notice banner text. */
  templateNotice: string | null;
  /** All triggers (used for looking up the editing trigger's metadata). */
  triggers: TriggerSummary[];
  /** Run history keyed by trigger ID. */
  triggerRunsById: Record<string, import("../../api").TriggerRunRecord[]>;
  /** Translation function. */
  t: TranslateFn;
  /** Currently selected trigger ID. */
  selectedTriggerId: string | null;
  /** Set a single form field value. */
  setField: <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => void;
  /** Replace the entire form state. */
  setForm: (
    form: TriggerFormState | ((prev: TriggerFormState) => TriggerFormState),
  ) => void;
  /** Set form error message. */
  setFormError: (error: string | null) => void;
  /** Close the editor panel. */
  closeEditor: () => void;
  /** Submit the form (create or update). */
  onSubmit: () => Promise<void>;
  /** Delete the trigger being edited. */
  onDelete: () => Promise<void>;
  /** Run a trigger immediately. */
  onRunSelectedTrigger: (triggerId: string) => Promise<void>;
  /** Toggle a trigger's enabled state. */
  onToggleTriggerEnabled: (
    triggerId: string,
    currentlyEnabled: boolean,
  ) => Promise<void>;
  /** Save the current form as a template. */
  saveFormAsTemplate: () => void;
  /** Load run history for a trigger. */
  loadTriggerRuns: (triggerId: string) => Promise<void>;
  /** Optional override for the create-mode kicker label. */
  kickerLabelCreate?: string;
  /** Optional override for the edit-mode kicker label. */
  kickerLabelEdit?: string;
  /** Optional override for the create submit label. */
  submitLabelCreate?: string;
  /** Optional override for the edit submit label. */
  submitLabelEdit?: string;
}

export function HeartbeatForm({
  form,
  editingId,
  editorEnabled,
  modalTitle,
  formError,
  triggersSaving,
  templateNotice,
  triggers,
  triggerRunsById,
  t,
  selectedTriggerId,
  setField,
  setForm,
  setFormError,
  closeEditor,
  onSubmit,
  onDelete,
  onRunSelectedTrigger,
  onToggleTriggerEnabled,
  saveFormAsTemplate,
  loadTriggerRuns,
  kickerLabelCreate,
  kickerLabelEdit,
  submitLabelCreate,
  submitLabelEdit,
}: HeartbeatFormProps) {
  const cronInvalid =
    form.triggerType === "cron" &&
    !validateCronExpression(form.cronExpression).ok;

  return (
    <div className="w-full px-4 pb-8 pt-0 sm:px-5 sm:pb-8 sm:pt-1 lg:px-7 lg:pb-8 lg:pt-1 xl:px-8">
      {templateNotice && (
        <PagePanel.Notice
          tone="accent"
          className="mb-4 animate-[fadeIn_0.2s_ease] text-xs font-medium"
        >
          {templateNotice}
        </PagePanel.Notice>
      )}
      <div className="mb-3 flex flex-col justify-between gap-2 lg:flex-row lg:items-start">
        <div className="max-w-3xl space-y-1">
          <FieldLabel variant="kicker">
            {editingId
              ? (kickerLabelEdit ?? t("heartbeatsview.editHeartbeat"))
              : (kickerLabelCreate ?? t("heartbeatsview.createHeartbeat"))}
          </FieldLabel>
          <h2 className="text-2xl font-semibold text-txt">{modalTitle}</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {editingId && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs"
                disabled={triggersSaving}
                onClick={() => void onRunSelectedTrigger(editingId)}
              >
                {t("triggersview.RunNow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs"
                onClick={() =>
                  void onToggleTriggerEnabled(editingId, editorEnabled)
                }
              >
                {editorEnabled ? t("common.disable") : t("common.enable")}
              </Button>
              <div className="w-px h-6 bg-border/50 mx-1 hidden sm:block" />
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs text-danger hover:border-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void onDelete()}
              >
                {t("common.delete")}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {formError && (
          <PagePanel.Notice tone="danger" className="text-sm">
            {formError}
          </PagePanel.Notice>
        )}

        <PagePanel
          variant="padded"
          className="grid gap-5"
          data-testid="heartbeats-editor-panel"
        >
          <div>
            <FieldLabel variant="form">
              {form.kind === "workflow" ? "Schedule name" : "Task name"}
            </FieldLabel>
            <Input
              variant="form"
              value={form.displayName}
              onChange={(event) => setField("displayName", event.target.value)}
              placeholder={t("triggersview.eGDailyDigestH")}
            />
          </div>

          <div className="grid gap-4 rounded-xl border border-border/30 bg-bg/20 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              What it does
            </div>
            <TriggerKindSection
              form={form}
              setField={setField}
              t={t}
              onGoToWorkflows={() => {
                window.dispatchEvent(
                  new CustomEvent("eliza:automations:setFilter", {
                    detail: { filter: "workflows" },
                  }),
                );
              }}
            />
          </div>

          <div className="grid gap-4 rounded-xl border border-border/30 bg-bg/20 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              When it starts
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div>
                <FieldLabel variant="form">Trigger type</FieldLabel>
                <FormSelect
                  value={form.triggerType}
                  onValueChange={(value: string) =>
                    setField(
                      "triggerType",
                      value as TriggerFormState["triggerType"],
                    )
                  }
                  placeholder="Repeating interval"
                >
                  <FormSelectItem value="interval">
                    Repeating interval
                  </FormSelectItem>
                  <FormSelectItem value="once">One time</FormSelectItem>
                  <FormSelectItem value="cron">Cron schedule</FormSelectItem>
                  <FormSelectItem value="event">Event</FormSelectItem>
                </FormSelect>
              </div>

              <div>
                <FieldLabel variant="form">When it fires</FieldLabel>
                <FormSelect
                  value={form.wakeMode}
                  onValueChange={(value: string) =>
                    setField("wakeMode", value as TriggerFormState["wakeMode"])
                  }
                  placeholder="Interrupt and run now"
                >
                  <FormSelectItem value="inject_now">
                    Interrupt and run now
                  </FormSelectItem>
                  <FormSelectItem value="next_autonomy_cycle">
                    Queue for next cycle
                  </FormSelectItem>
                </FormSelect>
              </div>
            </div>

            {form.triggerType === "interval" && (
              <div>
                <FieldLabel variant="form">Repeat every</FieldLabel>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
                  <Input
                    type="number"
                    min="1"
                    variant="form"
                    value={form.durationValue}
                    onChange={(event) =>
                      setField("durationValue", event.target.value)
                    }
                    placeholder="1"
                  />
                  <FormSelect
                    value={form.durationUnit}
                    onValueChange={(value: string) =>
                      setField(
                        "durationUnit",
                        value as TriggerFormState["durationUnit"],
                      )
                    }
                    placeholder={durationUnitLabel(form.durationUnit, t)}
                  >
                    {DURATION_UNITS.map((unit) => (
                      <FormSelectItem key={unit.unit} value={unit.unit}>
                        {durationUnitLabel(unit.unit, t)}
                      </FormSelectItem>
                    ))}
                  </FormSelect>
                </div>
                <IntervalHostWarningBanner form={form} />
              </div>
            )}

            {form.triggerType === "once" && (
              <div>
                <FieldLabel variant="form">Run at</FieldLabel>
                <Input
                  type="datetime-local"
                  variant="form"
                  value={form.scheduledAtIso}
                  onChange={(event) =>
                    setField("scheduledAtIso", event.target.value)
                  }
                />
              </div>
            )}

            {form.triggerType === "cron" && (
              <CronInputSection form={form} setField={setField} t={t} />
            )}

            {form.triggerType === "event" && (
              <EventInputSection form={form} setField={setField} />
            )}

            <SchedulePreview form={form} t={t} />
          </div>

          <div className="grid gap-4 rounded-xl border border-border/30 bg-bg/20 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Run behavior
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div>
                <FieldLabel variant="form">Stop after</FieldLabel>
                <Input
                  variant="form"
                  value={form.maxRuns}
                  onChange={(event) => setField("maxRuns", event.target.value)}
                  placeholder="Unlimited"
                />
              </div>

              <div className="flex items-end">
                <FieldSwitch
                  checked={form.enabled}
                  aria-label="Enabled"
                  className="flex-1"
                  label="Enabled"
                  onCheckedChange={(checked) => setField("enabled", checked)}
                />
              </div>
            </div>
          </div>
        </PagePanel>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {form.displayName.trim() && (
            <button
              type="button"
              className="text-xs font-medium text-muted transition-colors hover:text-accent underline-offset-2 hover:underline"
              onClick={saveFormAsTemplate}
            >
              {t("heartbeatsview.SaveAsTemplate", {
                defaultValue: "Save as template",
              })}
            </button>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              variant="default"
              size="sm"
              className="h-10 px-6 text-sm text-white shadow-sm hover:text-white dark:text-white dark:hover:text-white"
              disabled={
                triggersSaving ||
                (form.kind === "workflow" && !form.workflowId) ||
                cronInvalid
              }
              onClick={() => void onSubmit()}
            >
              {triggersSaving
                ? t("common.saving")
                : editingId
                  ? (submitLabelEdit ?? t("heartbeatsview.saveChanges"))
                  : (submitLabelCreate ?? t("heartbeatsview.createHeartbeat"))}
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="h-10 px-6 text-sm"
              onClick={() => {
                if (editingId && selectedTriggerId === editingId) {
                  const trigger = triggers.find(
                    (trigger) => trigger.id === editingId,
                  );
                  if (trigger) {
                    setForm(formFromTrigger(trigger));
                    setFormError(null);
                  }
                } else {
                  closeEditor();
                }
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>

        {editingId && (
          <HeartbeatRunHistory
            editingId={editingId}
            triggers={triggers}
            triggerRunsById={triggerRunsById}
            loadTriggerRuns={loadTriggerRuns}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

// ── Trigger kind section (what to run) ────────────────────────────

function TriggerKindSection({
  form,
  setField,
  t,
  onGoToWorkflows,
}: {
  form: TriggerFormState;
  setField: <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => void;
  t: TranslateFn;
  onGoToWorkflows: () => void;
}) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsError, setWorkflowsError] = useState<"unavailable" | null>(
    null,
  );
  const [workflowsLoading, setWorkflowsLoading] = useState(false);

  useEffect(() => {
    if (form.kind !== "workflow") return;
    let cancelled = false;
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    client
      .listWorkflowDefinitions()
      .then((list) => {
        if (cancelled) return;
        setWorkflows([...list].sort((a, b) => a.name.localeCompare(b.name)));
        setWorkflowsError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkflowsError("unavailable");
      })
      .finally(() => {
        if (!cancelled) setWorkflowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.kind]);

  const toggleLabelId = "trigger-kind-toggle-label";

  return (
    <div>
      <FieldLabel variant="form" id={toggleLabelId}>
        Runs
      </FieldLabel>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          aria-pressed={form.kind === "text"}
          onClick={() => setField("kind", "text")}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            form.kind === "text"
              ? "border-accent bg-accent/10 text-accent"
              : "border-border/40 text-muted hover:border-border hover:text-txt"
          }`}
        >
          Prompt
        </button>
        <button
          type="button"
          aria-pressed={form.kind === "workflow"}
          onClick={() => setField("kind", "workflow")}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            form.kind === "workflow"
              ? "border-accent bg-accent/10 text-accent"
              : "border-border/40 text-muted hover:border-border hover:text-txt"
          }`}
        >
          Workflow
        </button>
      </div>

      {form.kind === "text" && (
        <div className="mt-4">
          <FieldLabel variant="form">Prompt</FieldLabel>
          <Textarea
            variant="form"
            value={form.instructions}
            onChange={(event) => setField("instructions", event.target.value)}
            placeholder={t("triggersview.WhatShouldTheAgen")}
          />
        </div>
      )}

      {/* Workflow picker */}
      {form.kind === "workflow" && (
        <div className="mt-4">
          {workflowsError === "unavailable" ||
          (!workflowsLoading && workflows.length === 0) ? (
            <div
              role="status"
              className="rounded-lg border border-border/30 bg-bg/30 px-4 py-3 text-sm text-muted"
            >
              <p>{t("triggers.workflowUnavailable")}</p>
              <button
                type="button"
                className="mt-2 text-xs font-medium text-accent underline-offset-2 hover:underline"
                onClick={onGoToWorkflows}
              >
                {t("triggers.goToWorkflows")}
              </button>
            </div>
          ) : (
            <>
              <FieldLabel variant="form" htmlFor="trigger-workflow-select">
                Workflow
              </FieldLabel>
              <FormSelect
                value={form.workflowId}
                onValueChange={(value: string) => {
                  const wf = workflows.find((w) => w.id === value);
                  setField("workflowId", value);
                  setField("workflowName", wf?.name ?? "");
                }}
                placeholder={
                  workflowsLoading
                    ? t("appsview.Loading")
                    : t("triggers.workflowPlaceholder")
                }
              >
                {workflows.map((wf) => (
                  <FormSelectItem key={wf.id} value={wf.id}>
                    {wf.name}
                  </FormSelectItem>
                ))}
              </FormSelect>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Cron input with inline validation + example chips ─────────────

const CRON_EXAMPLES = [
  { expr: "0 9 * * 1-5", labelKey: "triggers.cronExample.weekdaysNine" },
  { expr: "*/15 * * * *", labelKey: "triggers.cronExample.every15min" },
  { expr: "0 0 1 * *", labelKey: "triggers.cronExample.monthly" },
] as const;

function CronInputSection({
  form,
  setField,
  t,
}: {
  form: TriggerFormState;
  setField: <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => void;
  t: TranslateFn;
}) {
  const cronErrorId = "cron-expression-error";
  const validationResult = validateCronExpression(form.cronExpression);
  const isInvalid = !validationResult.ok;

  return (
    <div>
      <FieldLabel variant="form">Cron schedule</FieldLabel>
      <Input
        variant="form"
        className="font-mono"
        value={form.cronExpression}
        onChange={(event) => setField("cronExpression", event.target.value)}
        placeholder="*/15 * * * *"
        aria-invalid={isInvalid}
        aria-describedby={isInvalid ? cronErrorId : undefined}
      />
      {isInvalid ? (
        <p
          id={cronErrorId}
          className="mt-1.5 text-xs font-medium text-danger"
          role="alert"
        >
          {t("triggers.cronError")} {validationResult.message}
        </p>
      ) : (
        <div className="mt-2 text-xs-tight text-muted">
          minute hour day month weekday
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">
          {t("triggers.cronExampleHint")}
        </span>
        {CRON_EXAMPLES.map(({ expr, labelKey }) => (
          <Button
            key={expr}
            variant="outline"
            size="sm"
            className="h-6 px-2 py-0 text-xs font-mono"
            onClick={() => setField("cronExpression", expr)}
          >
            {t(labelKey)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function EventInputSection({
  form,
  setField,
}: {
  form: TriggerFormState;
  setField: <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => void;
}) {
  const isCustomEvent = !EVENT_KIND_OPTIONS.some(
    (option) => option.value === form.eventKind,
  );
  return (
    <div className="grid gap-3">
      <div>
        <FieldLabel variant="form">Event</FieldLabel>
        <FormSelect
          value={isCustomEvent ? "__custom" : form.eventKind}
          onValueChange={(value: string) => {
            if (value === "__custom") {
              setField("eventKind", "");
              return;
            }
            setField("eventKind", value);
          }}
          placeholder="Message received"
        >
          {EVENT_KIND_OPTIONS.map((option) => (
            <FormSelectItem key={option.value} value={option.value}>
              {option.label}
            </FormSelectItem>
          ))}
          <FormSelectItem value="__custom">Custom event</FormSelectItem>
        </FormSelect>
      </div>

      {isCustomEvent && (
        <div>
          <FieldLabel variant="form">Event name</FieldLabel>
          <Input
            variant="form"
            className="font-mono"
            value={form.eventKind}
            onChange={(event) => setField("eventKind", event.target.value)}
            placeholder="namespace.subject.verb"
          />
        </div>
      )}

      {form.eventKind.trim() && (
        <div className="rounded-lg border border-border/30 bg-bg/30 px-4 py-3 text-xs text-muted">
          Runs when{" "}
          <span className="font-medium text-txt">
            {humanizeEventKind(form.eventKind)}
          </span>{" "}
          arrives.
        </div>
      )}
    </div>
  );
}

// ── Mobile / browser cadence warning ─────────────────────────────

function IntervalHostWarningBanner({ form }: { form: TriggerFormState }) {
  const warning = useMemo(() => {
    const value = Number(form.durationValue);
    if (!Number.isFinite(value) || value <= 0) {
      return { show: false, message: "", label: "" };
    }
    const intervalMs = durationToMs(value, form.durationUnit);
    const host = detectUiHostCapabilities();
    const { show, message } = intervalHostWarning(host, intervalMs);
    return { show, message, label: host.label };
  }, [form.durationValue, form.durationUnit]);

  if (!warning.show) return null;
  return (
    <PagePanel.Notice
      tone="warning"
      className="mt-3 text-xs"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{warning.label}</span>
        <span>{warning.message}</span>
      </div>
    </PagePanel.Notice>
  );
}

// ── Schedule preview ("Next runs: …") ────────────────────────────

function SchedulePreview({
  form,
  t,
}: {
  form: TriggerFormState;
  t: TranslateFn;
}) {
  const preview = useMemo(() => {
    const now = new Date();

    if (form.triggerType === "interval") {
      const value = Number(form.durationValue);
      if (!Number.isFinite(value) || value <= 0) {
        return {
          kind: "error" as const,
          message: t("triggers.scheduleIntervalError"),
        };
      }
      const intervalMs = durationToMs(value, form.durationUnit);
      const dates = nextRunsForInterval(intervalMs, 3, now);
      return { kind: "dates" as const, dates };
    }

    if (form.triggerType === "once") {
      const raw = form.scheduledAtIso.trim();
      if (!raw || !Number.isFinite(Date.parse(raw))) return null;
      const date = new Date(raw);
      const isPast = date.getTime() <= now.getTime();
      return { kind: "once" as const, date, isPast };
    }

    if (form.triggerType === "cron") {
      const result = validateCronExpression(form.cronExpression);
      if (!result.ok) return null;
      const dates = nextRunsForCron(form.cronExpression, 3, now);
      if (dates.length === 0) return null;
      return { kind: "dates" as const, dates };
    }

    if (form.triggerType === "event") {
      return {
        kind: "event" as const,
        label: humanizeEventKind(form.eventKind || "event"),
      };
    }

    return null;
  }, [
    form.triggerType,
    form.durationValue,
    form.durationUnit,
    form.scheduledAtIso,
    form.cronExpression,
    form.eventKind,
    t,
  ]);

  if (!preview) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border/30 bg-bg/30 px-4 py-3 text-sm"
    >
      {preview.kind === "error" ? (
        <p className="text-xs font-medium text-danger">{preview.message}</p>
      ) : preview.kind === "once" ? (
        <div>
          {preview.isPast && (
            <p className="mb-1 text-xs font-medium text-warning">
              {t("triggers.scheduleOnceInPast")}
            </p>
          )}
          <p className="text-xs text-muted">
            {t("triggers.scheduleOnceLabel", {
              time: formatDateTime(preview.date),
            })}
          </p>
        </div>
      ) : preview.kind === "event" ? (
        <p className="text-xs text-muted">
          Waiting for{" "}
          <span className="font-medium text-txt">{preview.label}</span>.
        </p>
      ) : (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Next runs
          </p>
          <ul className="space-y-0.5">
            {preview.dates.map((date) => (
              <li
                key={date.getTime()}
                className="text-xs text-txt/80 before:mr-1.5 before:content-['•']"
              >
                {formatDateTime(date)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Run history sub-section (shown when editing) ───────────────────

function HeartbeatRunHistory({
  editingId,
  triggers,
  triggerRunsById,
  loadTriggerRuns,
  t,
}: {
  editingId: string;
  triggers: TriggerSummary[];
  triggerRunsById: HeartbeatFormProps["triggerRunsById"];
  loadTriggerRuns: (triggerId: string) => Promise<void>;
  t: TranslateFn;
}) {
  return (
    <div className="mt-10 grid gap-8 pt-8">
      <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted">
            {t("heartbeatsview.maxRuns")}
          </dt>
          <dd className="mt-1.5 text-txt font-medium">
            {(() => {
              const trigger = triggers.find(
                (trigger) => trigger.id === editingId,
              );
              return trigger?.maxRuns
                ? trigger.maxRuns
                : t("heartbeatsview.unlimited");
            })()}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted">
            {t("triggersview.LastRun")}
          </dt>
          <dd className="mt-1.5 text-txt font-medium">
            {(() => {
              const trigger = triggers.find(
                (trigger) => trigger.id === editingId,
              );
              return formatDateTime(trigger?.lastRunAtIso, {
                fallback: t("heartbeatsview.notYetRun"),
              });
            })()}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted">
            {t("heartbeatsview.nextRun")}
          </dt>
          <dd className="mt-1.5 text-txt font-medium">
            {(() => {
              const trigger = triggers.find(
                (trigger) => trigger.id === editingId,
              );
              return formatDateTime(trigger?.nextRunAtMs, {
                fallback: t("heartbeatsview.notScheduled"),
              });
            })()}
          </dd>
        </PagePanel.SummaryCard>
      </dl>

      <PagePanel variant="padded" className="space-y-4">
        <div className="flex items-center justify-between gap-3 pb-3">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
            {t("triggersview.RunHistory")}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs-tight"
            onClick={() => void loadTriggerRuns(editingId)}
          >
            {t("common.refresh")}
          </Button>
        </div>

        {(() => {
          const hasLoadedRuns = Object.hasOwn(triggerRunsById, editingId);
          const runs = triggerRunsById[editingId] ?? [];

          if (!hasLoadedRuns) {
            return (
              <div className="py-6 text-sm text-muted/70 flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-muted/30 border-t-muted/80 rounded-full animate-spin" />{" "}
                {t("appsview.Loading")}
              </div>
            );
          }
          if (runs.length === 0) {
            return (
              <div className="py-6 text-sm text-muted/70 italic">
                {t("triggersview.NoRunsRecordedYet")}
              </div>
            );
          }

          return (
            <div className="space-y-3">
              {runs
                .slice()
                .reverse()
                .map((run) => (
                  <div
                    key={run.triggerRunId}
                    className="rounded-xl bg-bg/30 border border-border/20 px-4 py-3 text-sm transition-colors hover:bg-bg/50"
                  >
                    <div className="flex items-start gap-3">
                      <StatusDot
                        status={run.status}
                        className="mt-1 flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                          <span className="font-medium text-txt">
                            {localizedExecutionStatus(run.status, t)}
                          </span>
                          <span className="text-xs text-muted">
                            {formatDateTime(run.finishedAt, {
                              fallback: t("heartbeatsview.emDash"),
                            })}
                          </span>
                        </div>
                        <div className="text-xs-tight text-muted/80">
                          {formatDurationMs(run.latencyMs)} &middot;{" "}
                          <span className="font-mono text-muted/60 bg-bg/40 px-1 py-0.5 rounded">
                            {run.source}
                          </span>
                        </div>
                        {run.error && (
                          <div className="mt-2.5 text-xs text-danger/90 bg-danger/10 border border-danger/20 p-2.5 rounded-lg whitespace-pre-wrap font-mono leading-relaxed">
                            {run.error}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          );
        })()}
      </PagePanel>
    </div>
  );
}
