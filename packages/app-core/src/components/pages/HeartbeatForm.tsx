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
import type { TriggerSummary } from "../../api/client";
import { formatDateTime, formatDurationMs } from "../../utils/format";
import {
  DURATION_UNITS,
  durationUnitLabel,
  formFromTrigger,
  localizedExecutionStatus,
  type TranslateFn,
  type TriggerFormState,
} from "./heartbeat-utils";

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
}: HeartbeatFormProps) {
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
              ? t("heartbeatsview.editHeartbeat")
              : t("heartbeatsview.createHeartbeat")}
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
                {editorEnabled
                  ? t("heartbeatsview.disable")
                  : t("heartbeatsview.enable")}
              </Button>
              <div className="w-px h-6 bg-border/50 mx-1 hidden sm:block" />
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-3 text-xs text-danger hover:border-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void onDelete()}
              >
                {t("triggersview.Delete")}
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
            <FieldLabel variant="form">{t("wallet.name")}</FieldLabel>
            <Input
              variant="form"
              value={form.displayName}
              onChange={(event) => setField("displayName", event.target.value)}
              placeholder={t("triggersview.eGDailyDigestH")}
            />
          </div>

          <div>
            <FieldLabel variant="form">
              {t("triggersview.Instructions")}
            </FieldLabel>
            <Textarea
              variant="form"
              value={form.instructions}
              onChange={(event) => setField("instructions", event.target.value)}
              placeholder={t("triggersview.WhatShouldTheAgen")}
            />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <FieldLabel variant="form">
                {t("triggersview.ScheduleType")}
              </FieldLabel>
              <FormSelect
                value={form.triggerType}
                onValueChange={(value: string) =>
                  setField(
                    "triggerType",
                    value as TriggerFormState["triggerType"],
                  )
                }
                placeholder={t("triggersview.RepeatingInterval")}
              >
                <FormSelectItem value="interval">
                  {t("triggersview.RepeatingInterval")}
                </FormSelectItem>
                <FormSelectItem value="once">
                  {t("triggersview.OneTime")}
                </FormSelectItem>
                <FormSelectItem value="cron">
                  {t("triggersview.CronSchedule")}
                </FormSelectItem>
              </FormSelect>
            </div>

            <div>
              <FieldLabel variant="form">
                {t("triggersview.WakeMode")}
              </FieldLabel>
              <FormSelect
                value={form.wakeMode}
                onValueChange={(value: string) =>
                  setField("wakeMode", value as TriggerFormState["wakeMode"])
                }
                placeholder={t("triggersview.InjectAmpWakeIm")}
              >
                <FormSelectItem value="inject_now">
                  {t("triggersview.InjectAmpWakeIm")}
                </FormSelectItem>
                <FormSelectItem value="next_autonomy_cycle">
                  {t("triggersview.QueueForNextCycle")}
                </FormSelectItem>
              </FormSelect>
            </div>
          </div>

          {form.triggerType === "interval" && (
            <div>
              <FieldLabel variant="form">
                {t("heartbeatsview.interval")}
              </FieldLabel>
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
            </div>
          )}

          {form.triggerType === "once" && (
            <div>
              <FieldLabel variant="form">
                {t("triggersview.ScheduledTimeISO")}
              </FieldLabel>
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
            <div>
              <FieldLabel variant="form">
                {t("triggersview.CronExpression5F")}
              </FieldLabel>
              <Input
                variant="form"
                className="font-mono"
                value={form.cronExpression}
                onChange={(event) =>
                  setField("cronExpression", event.target.value)
                }
                placeholder="*/15 * * * *"
              />
              <div className="mt-2 text-xs-tight text-muted">
                {t("triggersview.minuteHourDayMont")}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <FieldLabel variant="form">
                {t("triggersview.MaxRunsOptional")}
              </FieldLabel>
              <Input
                variant="form"
                value={form.maxRuns}
                onChange={(event) => setField("maxRuns", event.target.value)}
                placeholder="\u221E"
              />
            </div>

            <div className="flex items-end">
              <FieldSwitch
                checked={form.enabled}
                aria-label={t("triggersview.StartEnabled")}
                className="flex-1"
                label={t("triggersview.StartEnabled")}
                onCheckedChange={(checked) => setField("enabled", checked)}
              />
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
              disabled={triggersSaving}
              onClick={() => void onSubmit()}
            >
              {triggersSaving
                ? t("apikeyconfig.saving")
                : editingId
                  ? t("heartbeatsview.saveChanges")
                  : t("heartbeatsview.createHeartbeat")}
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
                {t("databaseview.Loading")}
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
