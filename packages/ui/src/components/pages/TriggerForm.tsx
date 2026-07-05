/**
 * Create/edit form for a workflow trigger (cron or event), with run-history,
 * enable toggle, run-now, save-as-template, and delete affordances. Fully
 * controlled: all form state and mutation callbacks are owned by the parent
 * (`TriggersView`) and passed in, so this file is presentation plus local
 * validation (e.g. cron-expression checking) only.
 */
import { useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import type { TriggerSummary, WorkflowDefinition } from "../../api/client";
import { formatDateTime, formatDurationMs } from "../../utils/format";
import {
  detectUiHostCapabilities,
  intervalHostWarning,
} from "../../utils/host-capabilities";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { FieldLabel } from "../ui/field";
import { FieldSwitch } from "../ui/field-switch";
import { FormSelect, FormSelectItem } from "../ui/form-select";
import { Input } from "../ui/input";
import { StatusDot } from "../ui/status-badge";
import { Textarea } from "../ui/textarea";
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
} from "./trigger-form-utils";

const EVENT_KIND_OPTIONS = [
  {
    value: "message.received",
    labelKey: "triggerform.event.messageReceived",
    defaultLabel: "Message received",
  },
  {
    value: "discord.message.received",
    labelKey: "triggerform.event.discordMessage",
    defaultLabel: "Discord message",
  },
  {
    value: "telegram.message.received",
    labelKey: "triggerform.event.telegramMessage",
    defaultLabel: "Telegram message",
  },
  {
    value: "gmail.message.received",
    labelKey: "triggerform.event.gmailMessage",
    defaultLabel: "Gmail message",
  },
  {
    value: "calendar.event.ended",
    labelKey: "triggerform.event.calendarEventEnded",
    defaultLabel: "Calendar event ended",
  },
] as const;

// ── Agent-surface select wrapper ────────────────────────────────────
// FormSelect is a Radix Select and forwards neither a ref nor DOM props, so we
// wrap it in a registered element that drives its controlled state via onFill.
function AgentSelectField({
  id,
  label,
  group,
  description,
  value,
  options,
  onFill,
  children,
}: {
  id: string;
  label: string;
  group: string;
  description?: string;
  value: string;
  options?: readonly string[];
  onFill: (value: string) => void;
  children: React.ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
    id,
    role: "select",
    label,
    group,
    description,
    options,
    getValue: () => value,
    onFill,
  });
  return (
    <div ref={ref} {...agentProps}>
      {children}
    </div>
  );
}

function DurationValueInput({
  form,
  setField,
}: {
  form: TriggerFormState;
  setField: TriggerFormProps["setField"];
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "trigger-duration-value",
    role: "number-input",
    label: "Repeat interval value",
    group: "trigger-schedule",
    description: "How many duration units between runs",
    getValue: () => form.durationValue,
    onFill: (value) => setField("durationValue", value),
  });
  return (
    <Input
      ref={ref}
      type="number"
      min="1"
      variant="form"
      value={form.durationValue}
      onChange={(event) => setField("durationValue", event.target.value)}
      placeholder="1"
      {...agentProps}
    />
  );
}

function ScheduledAtInput({
  form,
  setField,
  t,
}: {
  form: TriggerFormState;
  setField: TriggerFormProps["setField"];
  t: TranslateFn;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "trigger-scheduled-at",
    role: "text-input",
    label: t("triggerform.runAt", { defaultValue: "Run at" }),
    group: "trigger-schedule",
    description: "Date and time to run a one-time trigger",
    getValue: () => form.scheduledAtIso,
    onFill: (value) => setField("scheduledAtIso", value),
  });
  return (
    <Input
      ref={ref}
      type="datetime-local"
      variant="form"
      value={form.scheduledAtIso}
      onChange={(event) => setField("scheduledAtIso", event.target.value)}
      {...agentProps}
    />
  );
}

// ── Props ──────────────────────────────────────────────────────────

export interface TriggerFormProps {
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

export function TriggerForm({
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
}: TriggerFormProps) {
  const cronInvalid =
    form.triggerType === "cron" &&
    !validateCronExpression(form.cronExpression).ok;

  const runNowButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-run-now",
    role: "button",
    label: t("triggersview.RunNow"),
    group: "trigger-toolbar",
    description: "Run the trigger being edited immediately",
    onActivate: () => {
      if (editingId) void onRunSelectedTrigger(editingId);
    },
  });
  const toggleEnabledButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-toggle-enabled",
    role: "button",
    label: editorEnabled ? t("common.disable") : t("common.enable"),
    group: "trigger-toolbar",
    status: editorEnabled ? "active" : "inactive",
    description: "Enable or disable the trigger being edited",
    onActivate: () => {
      if (editingId) void onToggleTriggerEnabled(editingId, editorEnabled);
    },
  });
  const deleteButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-delete",
    role: "button",
    label: t("common.delete"),
    group: "trigger-toolbar",
    description: "Delete the trigger being edited",
    onActivate: () => void onDelete(),
  });
  const displayNameInput = useAgentElement<HTMLInputElement>({
    id: "trigger-display-name",
    role: "text-input",
    label: t("triggerform.taskName", { defaultValue: "Task name" }),
    group: "trigger-form",
    description: "Display name for this scheduled task or workflow",
    getValue: () => form.displayName,
    onFill: (value) => setField("displayName", value),
  });
  const maxRunsInput = useAgentElement<HTMLInputElement>({
    id: "trigger-max-runs",
    role: "text-input",
    label: t("triggerform.stopAfter", { defaultValue: "Stop after" }),
    group: "trigger-form",
    description: "Maximum number of runs before the trigger stops",
    getValue: () => form.maxRuns,
    onFill: (value) => setField("maxRuns", value),
  });
  const enabledSwitch = useAgentElement<HTMLButtonElement>({
    id: "trigger-enabled",
    role: "toggle",
    label: t("triggerform.enabled", { defaultValue: "Enabled" }),
    group: "trigger-form",
    status: form.enabled ? "active" : "inactive",
    description: "Whether this trigger is enabled",
    onActivate: () => setField("enabled", !form.enabled),
  });
  const saveTemplateButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-save-template",
    role: "button",
    label: t("triggersview.SaveAsTemplate", {
      defaultValue: "Save as template",
    }),
    group: "trigger-form",
    description: "Save the current form as a reusable template",
    onActivate: () => saveFormAsTemplate(),
  });
  const submitButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-submit",
    role: "button",
    label: editingId
      ? (submitLabelEdit ?? t("triggersview.saveChanges"))
      : (submitLabelCreate ?? t("triggersview.createTrigger")),
    group: "trigger-form",
    description: "Save the trigger (create or update)",
    onActivate: () => void onSubmit(),
  });
  const cancelButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-cancel",
    role: "button",
    label: t("common.cancel"),
    group: "trigger-form",
    description: "Cancel editing and revert changes",
  });

  return (
    /* Flat — no card/border. The shell owns the page's horizontal padding. */
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
              ? (kickerLabelEdit ?? t("triggersview.editTrigger"))
              : (kickerLabelCreate ?? t("triggersview.createTrigger"))}
          </FieldLabel>
          <h2 className="text-2xl font-semibold text-txt">{modalTitle}</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {editingId && (
            <>
              <Button
                ref={runNowButton.ref}
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs"
                disabled={triggersSaving}
                onClick={() => void onRunSelectedTrigger(editingId)}
                {...runNowButton.agentProps}
              >
                {t("triggersview.RunNow")}
              </Button>
              <Button
                ref={toggleEnabledButton.ref}
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs"
                onClick={() =>
                  void onToggleTriggerEnabled(editingId, editorEnabled)
                }
                {...toggleEnabledButton.agentProps}
              >
                {editorEnabled ? t("common.disable") : t("common.enable")}
              </Button>
              <Button
                ref={deleteButton.ref}
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs text-danger hover:border-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void onDelete()}
                {...deleteButton.agentProps}
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
          className="grid gap-8"
          data-testid="trigger-editor-panel"
        >
          <div>
            <FieldLabel variant="form">
              {form.kind === "workflow"
                ? t("triggerform.scheduleName", {
                    defaultValue: "Schedule name",
                  })
                : t("triggerform.taskName", { defaultValue: "Task name" })}
            </FieldLabel>
            <Input
              ref={displayNameInput.ref}
              variant="form"
              value={form.displayName}
              onChange={(event) => setField("displayName", event.target.value)}
              placeholder={t("triggersview.eGDailyDigestH")}
              {...displayNameInput.agentProps}
            />
          </div>

          {/* Flat — no card/border. Sections separate by whitespace + type scale. */}
          <div className="grid gap-4">
            <div className="text-sm font-medium text-txt">
              {t("triggerform.whatItDoes", { defaultValue: "What it does" })}
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

          <div className="grid gap-4">
            <div className="text-sm font-medium text-txt">
              {t("triggerform.whenItStarts", {
                defaultValue: "When it starts",
              })}
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div>
                <FieldLabel variant="form">
                  {t("triggerform.triggerType", {
                    defaultValue: "Trigger type",
                  })}
                </FieldLabel>
                <AgentSelectField
                  id="trigger-trigger-type"
                  label={t("triggerform.triggerType", {
                    defaultValue: "Trigger type",
                  })}
                  group="trigger-form"
                  description="How the trigger fires (interval, once, cron, or event)"
                  value={form.triggerType}
                  options={["interval", "once", "cron", "event"]}
                  onFill={(value) =>
                    setField(
                      "triggerType",
                      value as TriggerFormState["triggerType"],
                    )
                  }
                >
                  <FormSelect
                    value={form.triggerType}
                    onValueChange={(value: string) =>
                      setField(
                        "triggerType",
                        value as TriggerFormState["triggerType"],
                      )
                    }
                    placeholder={t("triggerform.repeatingInterval", {
                      defaultValue: "Repeating interval",
                    })}
                  >
                    <FormSelectItem value="interval">
                      {t("triggerform.repeatingInterval", {
                        defaultValue: "Repeating interval",
                      })}
                    </FormSelectItem>
                    <FormSelectItem value="once">
                      {t("triggerform.oneTime", { defaultValue: "One time" })}
                    </FormSelectItem>
                    <FormSelectItem value="cron">
                      {t("triggerform.cronSchedule", {
                        defaultValue: "Cron schedule",
                      })}
                    </FormSelectItem>
                    <FormSelectItem value="event">
                      {t("triggerform.event.label", {
                        defaultValue: "Event",
                      })}
                    </FormSelectItem>
                  </FormSelect>
                </AgentSelectField>
              </div>

              <div>
                <FieldLabel variant="form">
                  {t("triggerform.whenItFires", {
                    defaultValue: "When it fires",
                  })}
                </FieldLabel>
                <AgentSelectField
                  id="trigger-wake-mode"
                  label={t("triggerform.whenItFires", {
                    defaultValue: "When it fires",
                  })}
                  group="trigger-form"
                  description="Whether to interrupt now or queue for the next cycle"
                  value={form.wakeMode}
                  options={["inject_now", "next_autonomy_cycle"]}
                  onFill={(value) =>
                    setField("wakeMode", value as TriggerFormState["wakeMode"])
                  }
                >
                  <FormSelect
                    value={form.wakeMode}
                    onValueChange={(value: string) =>
                      setField(
                        "wakeMode",
                        value as TriggerFormState["wakeMode"],
                      )
                    }
                    placeholder={t("triggerform.interruptAndRunNow", {
                      defaultValue: "Interrupt and run now",
                    })}
                  >
                    <FormSelectItem value="inject_now">
                      {t("triggerform.interruptAndRunNow", {
                        defaultValue: "Interrupt and run now",
                      })}
                    </FormSelectItem>
                    <FormSelectItem value="next_autonomy_cycle">
                      {t("triggerform.queueForNextCycle", {
                        defaultValue: "Queue for next cycle",
                      })}
                    </FormSelectItem>
                  </FormSelect>
                </AgentSelectField>
              </div>
            </div>

            {form.triggerType === "interval" && (
              <div>
                <FieldLabel variant="form">
                  {t("triggerform.repeatEvery", {
                    defaultValue: "Repeat every",
                  })}
                </FieldLabel>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
                  <DurationValueInput form={form} setField={setField} />
                  <AgentSelectField
                    id="trigger-duration-unit"
                    label="Repeat interval unit"
                    group="trigger-schedule"
                    description="The unit of time between runs (minutes, hours, days…)"
                    value={form.durationUnit}
                    options={DURATION_UNITS.map((unit) => unit.unit)}
                    onFill={(value) =>
                      setField(
                        "durationUnit",
                        value as TriggerFormState["durationUnit"],
                      )
                    }
                  >
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
                  </AgentSelectField>
                </div>
                <IntervalHostWarningBanner form={form} />
              </div>
            )}

            {form.triggerType === "once" && (
              <div>
                <FieldLabel variant="form">
                  {t("triggerform.runAt", { defaultValue: "Run at" })}
                </FieldLabel>
                <ScheduledAtInput form={form} setField={setField} t={t} />
              </div>
            )}

            {form.triggerType === "cron" && (
              <CronInputSection form={form} setField={setField} t={t} />
            )}

            {form.triggerType === "event" && (
              <EventInputSection form={form} setField={setField} t={t} />
            )}

            <SchedulePreview form={form} t={t} />
          </div>

          <div className="grid gap-4">
            <div className="text-sm font-medium text-txt">
              {t("triggerform.runBehavior", {
                defaultValue: "Run behavior",
              })}
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div>
                <FieldLabel variant="form">
                  {t("triggerform.stopAfter", {
                    defaultValue: "Stop after",
                  })}
                </FieldLabel>
                <Input
                  ref={maxRunsInput.ref}
                  variant="form"
                  value={form.maxRuns}
                  onChange={(event) => setField("maxRuns", event.target.value)}
                  placeholder={t("triggerform.unlimited", {
                    defaultValue: "Unlimited",
                  })}
                  {...maxRunsInput.agentProps}
                />
              </div>

              <div className="flex items-end">
                <FieldSwitch
                  ref={enabledSwitch.ref}
                  checked={form.enabled}
                  aria-label={t("triggerform.enabled", {
                    defaultValue: "Enabled",
                  })}
                  className="flex-1"
                  label={t("triggerform.enabled", {
                    defaultValue: "Enabled",
                  })}
                  onCheckedChange={(checked) => setField("enabled", checked)}
                  {...enabledSwitch.agentProps}
                />
              </div>
            </div>
          </div>
        </PagePanel>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {form.displayName.trim() && (
            <Button
              ref={saveTemplateButton.ref}
              variant="ghost"
              size="sm"
              className="h-auto px-0 py-0 text-xs font-medium text-muted underline-offset-2 transition-colors hover:bg-transparent hover:text-accent hover:underline"
              onClick={saveFormAsTemplate}
              {...saveTemplateButton.agentProps}
            >
              {t("triggersview.SaveAsTemplate", {
                defaultValue: "Save as template",
              })}
            </Button>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              ref={submitButton.ref}
              variant="default"
              size="sm"
              className="h-10 px-6 text-sm text-white hover:text-white"
              disabled={
                triggersSaving ||
                (form.kind === "workflow" && !form.workflowId) ||
                cronInvalid
              }
              onClick={() => void onSubmit()}
              {...submitButton.agentProps}
            >
              {triggersSaving
                ? t("common.saving")
                : editingId
                  ? (submitLabelEdit ?? t("triggersview.saveChanges"))
                  : (submitLabelCreate ?? t("triggersview.createTrigger"))}
            </Button>

            <Button
              ref={cancelButton.ref}
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
              {...cancelButton.agentProps}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>

        {editingId && (
          <TriggerRunHistory
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

  const promptKindButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-kind-prompt",
    role: "tab",
    label: t("triggerform.prompt", { defaultValue: "Prompt" }),
    group: "trigger-kind",
    status: form.kind === "text" ? "active" : "inactive",
    description: "Run a free-text prompt when this trigger fires",
    onActivate: () => setField("kind", "text"),
  });
  const workflowKindButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-kind-workflow",
    role: "tab",
    label: t("triggerform.workflow", { defaultValue: "Workflow" }),
    group: "trigger-kind",
    status: form.kind === "workflow" ? "active" : "inactive",
    description: "Run a saved workflow when this trigger fires",
    onActivate: () => setField("kind", "workflow"),
  });
  const instructionsTextarea = useAgentElement<HTMLTextAreaElement>({
    id: "trigger-instructions",
    role: "textarea",
    label: t("triggerform.prompt", { defaultValue: "Prompt" }),
    group: "trigger-kind",
    description: "Prompt text the agent runs when this trigger fires",
    getValue: () => form.instructions,
    onFill: (value) => setField("instructions", value),
  });
  const goToWorkflowsButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-go-to-workflows",
    role: "button",
    label: t("triggers.goToWorkflows"),
    group: "trigger-kind",
    description: "Navigate to the workflows list to create a workflow",
    onActivate: () => onGoToWorkflows(),
  });

  return (
    <div>
      <FieldLabel variant="form" id={toggleLabelId}>
        {t("triggerform.runs", { defaultValue: "Runs" })}
      </FieldLabel>
      <div className="mt-1.5 flex gap-2">
        <Button
          ref={promptKindButton.ref}
          aria-pressed={form.kind === "text"}
          onClick={() => setField("kind", "text")}
          variant="ghost"
          size="sm"
          className={`rounded-sm border px-3 py-1.5 text-sm font-medium transition-colors ${
            form.kind === "text"
              ? "border-accent bg-accent/10 text-accent"
              : "border-border/40 text-muted hover:border-border hover:text-txt"
          }`}
          {...promptKindButton.agentProps}
        >
          {t("triggerform.prompt", { defaultValue: "Prompt" })}
        </Button>
        <Button
          ref={workflowKindButton.ref}
          aria-pressed={form.kind === "workflow"}
          onClick={() => setField("kind", "workflow")}
          variant="ghost"
          size="sm"
          className={`rounded-sm border px-3 py-1.5 text-sm font-medium transition-colors ${
            form.kind === "workflow"
              ? "border-accent bg-accent/10 text-accent"
              : "border-border/40 text-muted hover:border-border hover:text-txt"
          }`}
          {...workflowKindButton.agentProps}
        >
          {t("triggerform.workflow", { defaultValue: "Workflow" })}
        </Button>
      </div>

      {form.kind === "text" && (
        <div className="mt-4">
          <FieldLabel variant="form">
            {t("triggerform.prompt", { defaultValue: "Prompt" })}
          </FieldLabel>
          <Textarea
            ref={instructionsTextarea.ref}
            variant="form"
            value={form.instructions}
            onChange={(event) => setField("instructions", event.target.value)}
            placeholder={t("triggersview.WhatShouldTheAgen")}
            {...instructionsTextarea.agentProps}
          />
        </div>
      )}

      {/* Workflow picker */}
      {form.kind === "workflow" && (
        <div className="mt-4">
          {workflowsError === "unavailable" ||
          (!workflowsLoading && workflows.length === 0) ? (
            <div role="status" className="text-sm text-muted">
              <p>{t("triggers.workflowUnavailable")}</p>
              <Button
                ref={goToWorkflowsButton.ref}
                variant="ghost"
                size="sm"
                className="mt-2 h-auto px-0 py-0 text-xs font-medium text-accent underline-offset-2 hover:bg-transparent hover:underline"
                onClick={onGoToWorkflows}
                {...goToWorkflowsButton.agentProps}
              >
                {t("triggers.goToWorkflows")}
              </Button>
            </div>
          ) : (
            <>
              <FieldLabel variant="form" htmlFor="trigger-workflow-select">
                {t("triggerform.workflow", { defaultValue: "Workflow" })}
              </FieldLabel>
              <AgentSelectField
                id="trigger-workflow-select"
                label={t("triggerform.workflow", {
                  defaultValue: "Workflow",
                })}
                group="trigger-kind"
                description="The saved workflow to run when this trigger fires"
                value={form.workflowId}
                options={workflows.map((wf) => wf.id)}
                onFill={(value) => {
                  const wf = workflows.find((w) => w.id === value);
                  setField("workflowId", value);
                  setField("workflowName", wf?.name ?? "");
                }}
              >
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
              </AgentSelectField>
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

function CronExampleButton({
  expr,
  labelKey,
  setField,
  t,
}: {
  expr: string;
  labelKey: string;
  setField: TriggerFormProps["setField"];
  t: TranslateFn;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `trigger-cron-example-${expr.replace(/[^a-z0-9]+/gi, "-")}`,
    role: "button",
    label: `${t(labelKey)} (${expr})`,
    group: "trigger-cron",
    description: `Fill the cron expression with ${expr}`,
    onActivate: () => setField("cronExpression", expr),
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="h-6 px-2 py-0 text-xs font-mono"
      onClick={() => setField("cronExpression", expr)}
      {...agentProps}
    >
      {t(labelKey)}
    </Button>
  );
}

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

  const cronInput = useAgentElement<HTMLInputElement>({
    id: "trigger-cron-expression",
    role: "text-input",
    label: t("triggerform.cronSchedule", { defaultValue: "Cron schedule" }),
    group: "trigger-cron",
    status: isInvalid ? "error" : undefined,
    description: "Cron expression controlling when the trigger fires",
    getValue: () => form.cronExpression,
    onFill: (value) => setField("cronExpression", value),
  });

  return (
    <div>
      <FieldLabel variant="form">
        {t("triggerform.cronSchedule", { defaultValue: "Cron schedule" })}
      </FieldLabel>
      <Input
        ref={cronInput.ref}
        variant="form"
        className="font-mono"
        value={form.cronExpression}
        onChange={(event) => setField("cronExpression", event.target.value)}
        placeholder="*/15 * * * *"
        aria-invalid={isInvalid}
        aria-describedby={isInvalid ? cronErrorId : undefined}
        {...cronInput.agentProps}
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
          {t("triggerform.cronFieldOrder", {
            defaultValue: "minute hour day month weekday",
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">
          {t("triggers.cronExampleHint")}
        </span>
        {CRON_EXAMPLES.map(({ expr, labelKey }) => (
          <CronExampleButton
            key={expr}
            expr={expr}
            labelKey={labelKey}
            setField={setField}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function EventInputSection({
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
  const isCustomEvent = !EVENT_KIND_OPTIONS.some(
    (option) => option.value === form.eventKind,
  );

  const customEventInput = useAgentElement<HTMLInputElement>({
    id: "trigger-event-name",
    role: "text-input",
    label: t("triggerform.event.name", { defaultValue: "Event name" }),
    group: "trigger-event",
    description: "Custom event name in namespace.subject.verb form",
    getValue: () => form.eventKind,
    onFill: (value) => setField("eventKind", value),
  });

  return (
    <div className="grid gap-3">
      <div>
        <FieldLabel variant="form">
          {t("triggerform.event.label", { defaultValue: "Event" })}
        </FieldLabel>
        <AgentSelectField
          id="trigger-event-kind"
          label={t("triggerform.event.label", { defaultValue: "Event" })}
          group="trigger-event"
          description="The event that fires this trigger"
          value={isCustomEvent ? "__custom" : form.eventKind}
          options={[...EVENT_KIND_OPTIONS.map((o) => o.value), "__custom"]}
          onFill={(value) => {
            if (value === "__custom") {
              setField("eventKind", "");
              return;
            }
            setField("eventKind", value);
          }}
        >
          <FormSelect
            value={isCustomEvent ? "__custom" : form.eventKind}
            onValueChange={(value: string) => {
              if (value === "__custom") {
                setField("eventKind", "");
                return;
              }
              setField("eventKind", value);
            }}
            placeholder={t("triggerform.event.messageReceived", {
              defaultValue: "Message received",
            })}
          >
            {EVENT_KIND_OPTIONS.map((option) => (
              <FormSelectItem key={option.value} value={option.value}>
                {t(option.labelKey, { defaultValue: option.defaultLabel })}
              </FormSelectItem>
            ))}
            <FormSelectItem value="__custom">
              {t("triggerform.event.custom", {
                defaultValue: "Custom event",
              })}
            </FormSelectItem>
          </FormSelect>
        </AgentSelectField>
      </div>

      {isCustomEvent && (
        <div>
          <FieldLabel variant="form">
            {t("triggerform.event.name", { defaultValue: "Event name" })}
          </FieldLabel>
          <Input
            ref={customEventInput.ref}
            variant="form"
            className="font-mono"
            value={form.eventKind}
            onChange={(event) => setField("eventKind", event.target.value)}
            placeholder="namespace.subject.verb"
            {...customEventInput.agentProps}
          />
        </div>
      )}

      {form.eventKind.trim() && (
        <div className="text-xs text-muted">
          {t("triggerform.event.runsWhen", {
            eventName: humanizeEventKind(form.eventKind),
            defaultValue: "Runs when {{eventName}} arrives.",
          })}
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
  const [previewNow, setPreviewNow] = useState<Date | null>(null);

  useEffect(() => {
    setPreviewNow(new Date());
    const id = window.setInterval(() => setPreviewNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const preview = useMemo(() => {
    if (!previewNow) return null;
    const now = previewNow;

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
    previewNow,
    t,
  ]);

  if (!preview) return null;

  return (
    <div role="status" aria-live="polite" className="text-sm">
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
          {t("triggerform.preview.waitingFor", {
            eventName: preview.label,
            defaultValue: "Waiting for {{eventName}}.",
          })}
        </p>
      ) : (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {t("triggerform.preview.nextRuns", {
              defaultValue: "Next runs",
            })}
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

function TriggerRunHistory({
  editingId,
  triggers,
  triggerRunsById,
  loadTriggerRuns,
  t,
}: {
  editingId: string;
  triggers: TriggerSummary[];
  triggerRunsById: TriggerFormProps["triggerRunsById"];
  loadTriggerRuns: (triggerId: string) => Promise<void>;
  t: TranslateFn;
}) {
  const refreshRunsButton = useAgentElement<HTMLButtonElement>({
    id: "trigger-refresh-runs",
    role: "button",
    label: t("common.refresh"),
    group: "trigger-history",
    description: "Reload the run history for the trigger being edited",
    onActivate: () => void loadTriggerRuns(editingId),
  });
  return (
    <div className="mt-10 grid gap-8 pt-8">
      <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted">
            {t("triggersview.maxRuns")}
          </dt>
          <dd className="mt-1.5 text-txt font-medium">
            {(() => {
              const trigger = triggers.find(
                (trigger) => trigger.id === editingId,
              );
              return trigger?.maxRuns
                ? trigger.maxRuns
                : t("triggersview.unlimited");
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
                fallback: t("triggersview.notYetRun"),
              });
            })()}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted">
            {t("triggersview.nextRun")}
          </dt>
          <dd className="mt-1.5 text-txt font-medium">
            {(() => {
              const trigger = triggers.find(
                (trigger) => trigger.id === editingId,
              );
              return formatDateTime(trigger?.nextRunAtMs, {
                fallback: t("triggersview.notScheduled"),
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
            ref={refreshRunsButton.ref}
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs-tight"
            onClick={() => void loadTriggerRuns(editingId)}
            {...refreshRunsButton.agentProps}
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
                  <div key={run.triggerRunId} className="text-sm">
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
                              fallback: t("triggersview.emDash"),
                            })}
                          </span>
                        </div>
                        <div className="text-xs-tight text-muted/80">
                          {formatDurationMs(run.latencyMs)} &middot;{" "}
                          <span className="font-mono text-muted/60">
                            {run.source}
                          </span>
                        </div>
                        {run.error && (
                          <div className="mt-2.5 text-xs text-danger/90 bg-danger/10 border border-danger/20 p-2.5 rounded-sm whitespace-pre-wrap font-mono leading-relaxed">
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
