import { Button, Input } from "@elizaos/ui";
import { ChevronDown, Clock3, PencilLine, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  CreateTriggerRequest,
  TriggerSummary,
  UpdateTriggerRequest,
} from "../api/client";
import { useApp } from "../state";
import { confirmDesktopAction } from "../utils";
import { formatDateTime, formatDurationMs } from "./format";
import { StatusBadge, StatusDot } from "./ui-badges";

type TriggerType = "interval" | "once" | "cron";
type TriggerWakeMode = "inject_now" | "next_autonomy_cycle";
type TranslateFn = (
  key: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
) => string;

const DURATION_UNITS = [
  {
    unit: "seconds",
    ms: 1000,
    labelKey: "heartbeatsview.durationUnitSeconds",
  },
  {
    unit: "minutes",
    ms: 60_000,
    labelKey: "heartbeatsview.durationUnitMinutes",
  },
  {
    unit: "hours",
    ms: 3_600_000,
    labelKey: "heartbeatsview.durationUnitHours",
  },
  {
    unit: "days",
    ms: 86_400_000,
    labelKey: "heartbeatsview.durationUnitDays",
  },
] as const;

type DurationUnit = (typeof DURATION_UNITS)[number]["unit"];

const FIELD_LABEL_CLASS = "mb-1.5 block text-xs font-medium text-muted";
const INPUT_CLASS =
  "h-10 w-full rounded-xl border-border/60 bg-bg/70 px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:ring-accent";
const SELECT_CLASS =
  "h-10 w-full rounded-xl border border-border/60 bg-bg/70 px-3 py-2 text-sm outline-none focus:border-accent";
const TEXTAREA_CLASS =
  "min-h-[120px] w-full resize-y rounded-xl border border-border/60 bg-bg/70 px-3 py-2 text-sm outline-none focus:border-accent";

function bestFitUnit(ms: number): { value: number; unit: DurationUnit } {
  for (let i = DURATION_UNITS.length - 1; i >= 0; i -= 1) {
    const unit = DURATION_UNITS[i];
    if (ms >= unit.ms && ms % unit.ms === 0) {
      return { value: ms / unit.ms, unit: unit.unit };
    }
  }
  return { value: ms / 1000, unit: "seconds" };
}

function durationToMs(value: number, unit: DurationUnit): number {
  const found = DURATION_UNITS.find((candidate) => candidate.unit === unit);
  return value * (found?.ms ?? 1000);
}

function durationUnitLabel(unit: DurationUnit, t: TranslateFn): string {
  const found = DURATION_UNITS.find((candidate) => candidate.unit === unit);
  return found ? t(found.labelKey) : unit;
}

interface TriggerFormState {
  displayName: string;
  instructions: string;
  triggerType: TriggerType;
  wakeMode: TriggerWakeMode;
  scheduledAtIso: string;
  cronExpression: string;
  maxRuns: string;
  enabled: boolean;
  durationValue: string;
  durationUnit: DurationUnit;
}

const emptyForm: TriggerFormState = {
  displayName: "",
  instructions: "",
  triggerType: "interval",
  wakeMode: "inject_now",
  scheduledAtIso: "",
  cronExpression: "0 * * * *",
  maxRuns: "",
  enabled: true,
  durationValue: "1",
  durationUnit: "hours",
};

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function scheduleLabel(trigger: TriggerSummary, t: TranslateFn): string {
  if (trigger.triggerType === "interval") {
    return `${t("heartbeatsview.every")} ${formatDurationMs(trigger.intervalMs)}`;
  }
  if (trigger.triggerType === "once") {
    return trigger.scheduledAtIso
      ? t("heartbeatsview.onceAt", {
          time: formatDateTime(trigger.scheduledAtIso),
        })
      : t("heartbeatsview.once");
  }
  if (trigger.triggerType === "cron") {
    return `${t("heartbeatsview.cronPrefix")} ${trigger.cronExpression ?? "—"}`;
  }
  return trigger.triggerType;
}

function formFromTrigger(trigger: TriggerSummary): TriggerFormState {
  const intervalMs = trigger.intervalMs ?? 3_600_000;
  const { value, unit } = bestFitUnit(intervalMs);
  return {
    displayName: trigger.displayName,
    instructions: trigger.instructions,
    triggerType: trigger.triggerType,
    wakeMode: trigger.wakeMode,
    scheduledAtIso: trigger.scheduledAtIso ?? "",
    cronExpression: trigger.cronExpression ?? "0 * * * *",
    maxRuns: trigger.maxRuns ? String(trigger.maxRuns) : "",
    enabled: trigger.enabled,
    durationValue: String(value),
    durationUnit: unit,
  };
}

function buildCreateRequest(form: TriggerFormState): CreateTriggerRequest {
  const maxRuns = parsePositiveInteger(form.maxRuns);
  return {
    displayName: form.displayName.trim(),
    instructions: form.instructions.trim(),
    triggerType: form.triggerType,
    wakeMode: form.wakeMode,
    enabled: form.enabled,
    intervalMs:
      form.triggerType === "interval"
        ? durationToMs(Number(form.durationValue) || 1, form.durationUnit)
        : undefined,
    scheduledAtIso:
      form.triggerType === "once" ? form.scheduledAtIso.trim() : undefined,
    cronExpression:
      form.triggerType === "cron" ? form.cronExpression.trim() : undefined,
    maxRuns,
  };
}

function buildUpdateRequest(form: TriggerFormState): UpdateTriggerRequest {
  return { ...buildCreateRequest(form) };
}

function validateForm(form: TriggerFormState, t: TranslateFn): string | null {
  if (!form.displayName.trim()) {
    return t("heartbeatsview.validationDisplayNameRequired");
  }
  if (!form.instructions.trim()) {
    return t("heartbeatsview.validationInstructionsRequired");
  }
  if (form.triggerType === "interval") {
    const value = Number(form.durationValue);
    if (!Number.isFinite(value) || value <= 0) {
      return t("heartbeatsview.validationIntervalPositive");
    }
  }
  if (form.triggerType === "once") {
    const raw = form.scheduledAtIso.trim();
    if (!raw) return t("heartbeatsview.validationScheduledTimeRequired");
    if (!Number.isFinite(Date.parse(raw))) {
      return t("heartbeatsview.validationScheduledTimeInvalid");
    }
  }
  if (form.triggerType === "cron") {
    const cronTrimmed = form.cronExpression.trim();
    if (!cronTrimmed) return t("heartbeatsview.validationCronRequired");
    const cronParts = cronTrimmed.split(/\s+/);
    if (cronParts.length !== 5) {
      return t("heartbeatsview.validationCronFiveFields");
    }
    const ranges = [
      { name: t("heartbeatsview.cronFieldMinute") },
      { name: t("heartbeatsview.cronFieldHour") },
      { name: t("heartbeatsview.cronFieldDay") },
      { name: t("heartbeatsview.cronFieldMonth") },
      { name: t("heartbeatsview.cronFieldWeekday") },
    ];
    for (let index = 0; index < 5; index += 1) {
      if (!/^[\d,\-*/]+$/.test(cronParts[index])) {
        return t("heartbeatsview.validationCronInvalidField", {
          field: ranges[index]?.name ?? "",
          value: cronParts[index] ?? "",
        });
      }
    }
  }
  if (form.maxRuns.trim() && !parsePositiveInteger(form.maxRuns)) {
    return t("heartbeatsview.validationMaxRunsPositive");
  }
  return null;
}

function toneForLastStatus(
  status?: string,
): "success" | "warning" | "danger" | "muted" {
  if (!status) return "muted";
  if (status === "success" || status === "completed") return "success";
  if (status === "skipped" || status === "queued") return "warning";
  if (status === "error" || status === "failed") return "danger";
  return "muted";
}

function wakeModeLabel(
  wakeMode: TriggerWakeMode,
  t: (key: string) => string,
): string {
  return wakeMode === "inject_now"
    ? t("triggersview.InjectAmpWakeIm")
    : t("triggersview.QueueForNextCycle");
}

function localizedExecutionStatus(status: string, t: TranslateFn): string {
  switch (status) {
    case "success":
      return t("heartbeatsview.statusSuccess");
    case "completed":
      return t("heartbeatsview.statusCompleted");
    case "skipped":
      return t("heartbeatsview.statusSkipped");
    case "queued":
      return t("heartbeatsview.statusQueued");
    case "error":
      return t("heartbeatsview.statusError");
    case "failed":
      return t("heartbeatsview.statusFailed");
    default:
      return status;
  }
}

function runCountLabel(count: number, t: TranslateFn): string {
  return count === 1
    ? t("heartbeatsview.runCountSingle", { count })
    : t("heartbeatsview.runCountPlural", { count });
}

export function HeartbeatsView() {
  const {
    triggers = [],
    triggersLoading = false,
    triggersSaving = false,
    triggerRunsById = {},
    triggerHealth: _triggerHealth = null,
    triggerError = null,
    loadTriggers = async () => {},
    createTrigger = async () => null,
    updateTrigger = async () => null,
    deleteTrigger = async () => true,
    runTriggerNow = async () => true,
    loadTriggerRuns = async () => {},
    loadTriggerHealth = async () => {},
    t,
  } = useApp();

  const [form, setForm] = useState<TriggerFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const selectedRuns = useMemo(() => {
    if (!selectedTriggerId) return [];
    return triggerRunsById[selectedTriggerId] ?? [];
  }, [selectedTriggerId, triggerRunsById]);

  useEffect(() => {
    void loadTriggerHealth();
    void loadTriggers();
  }, [loadTriggerHealth, loadTriggers]);

  useEffect(() => {
    if (!selectedTriggerId) return;
    if (!triggers.some((trigger) => trigger.id === selectedTriggerId)) {
      setSelectedTriggerId(null);
    }
  }, [selectedTriggerId, triggers]);

  useEffect(() => {
    if (!editorOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditorOpen(false);
        setEditingId(null);
        setForm(emptyForm);
        setFormError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editorOpen]);

  const resetEditor = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormError(null);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    resetEditor();
  };

  const openCreateEditor = () => {
    resetEditor();
    setEditorOpen(true);
  };

  const openEditEditor = (trigger: TriggerSummary) => {
    setEditingId(trigger.id);
    setForm(formFromTrigger(trigger));
    setFormError(null);
    setSelectedTriggerId(trigger.id);
    setEditorOpen(true);
  };

  const setField = <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => setForm((previous) => ({ ...previous, [key]: value }));

  const toggleExpandedTrigger = (triggerId: string) => {
    const nextTriggerId = selectedTriggerId === triggerId ? null : triggerId;
    setSelectedTriggerId(nextTriggerId);
    if (nextTriggerId) {
      void loadTriggerRuns(nextTriggerId);
    }
  };

  const onSubmit = async () => {
    const error = validateForm(form, t);
    if (error) {
      setFormError(error);
      return;
    }

    setFormError(null);

    if (editingId) {
      const updated = await updateTrigger(editingId, buildUpdateRequest(form));
      if (updated) {
        setSelectedTriggerId(updated.id);
        closeEditor();
      }
      return;
    }

    const created = await createTrigger(buildCreateRequest(form));
    if (created) {
      setSelectedTriggerId(created.id);
      void loadTriggerRuns(created.id);
      closeEditor();
    }
  };

  const onDelete = async () => {
    if (!editingId) return;
    const confirmed = await confirmDesktopAction({
      title: t("heartbeatsview.deleteTitle"),
      message: t("heartbeatsview.deleteMessage", { name: form.displayName }),
      confirmLabel: t("triggersview.Delete"),
      cancelLabel: t("onboarding.cancel"),
      type: "warning",
    });
    if (!confirmed) return;

    const deleted = await deleteTrigger(editingId);
    if (!deleted) return;

    if (selectedTriggerId === editingId) {
      setSelectedTriggerId(null);
    }
    closeEditor();
  };

  const onRunSelectedTrigger = async (triggerId: string) => {
    setSelectedTriggerId(triggerId);
    await runTriggerNow(triggerId);
  };

  const onToggleTriggerEnabled = async (
    triggerId: string,
    currentlyEnabled: boolean,
  ) => {
    const updated = await updateTrigger(triggerId, {
      enabled: !currentlyEnabled,
    });
    if (updated && editingId === updated.id) {
      setForm(formFromTrigger(updated));
    }
  };

  const modalTitle = editingId
    ? t("heartbeatsview.editTitle", {
        name: form.displayName.trim() || t("heartbeatsview.heartbeatSingular"),
      })
    : t("heartbeatsview.newHeartbeat");
  const editorEnabled =
    editingId != null
      ? (triggers.find((trigger) => trigger.id === editingId)?.enabled ??
        form.enabled)
      : form.enabled;

  return (
    <>
      <div className="flex min-h-[calc(100vh-9rem)] w-full flex-col gap-5 pb-6 sm:gap-6">
        <div className="flex flex-col gap-4 px-1 lg:flex-row lg:items-end lg:justify-between">
          <Button
            variant="default"
            size="sm"
            className="h-10 px-4 text-sm shadow-sm"
            onClick={openCreateEditor}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("heartbeatsview.newHeartbeat")}
          </Button>
        </div>

        <div className="flex min-h-[60vh] flex-1 flex-col overflow-hidden rounded-[1.35rem] border border-border/60 bg-card/80 shadow-[0_18px_40px_rgba(0,0,0,0.18)]">
          {triggerError && (
            <div className="mx-4 mt-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger sm:mx-6">
              {triggerError}
            </div>
          )}

          {triggers.length === 0 && !triggersLoading ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bg/70">
                <Clock3 className="h-7 w-7 text-muted" />
              </div>
              <div className="mt-5 text-base font-medium text-txt">
                {t("triggersview.NoTriggersConfigur")}
              </div>
              <div className="mt-2 max-w-md text-sm leading-6 text-muted">
                {t("heartbeatsview.emptyStateDescription")}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {triggers.map((trigger, index) => {
                const isExpanded = selectedTriggerId === trigger.id;
                const hasLoadedRuns = Object.hasOwn(
                  triggerRunsById,
                  trigger.id,
                );
                const runs = isExpanded ? selectedRuns : [];

                return (
                  <div
                    key={trigger.id}
                    className={index === 0 ? "" : "border-t border-border/50"}
                  >
                    <div className="px-4 py-4 sm:px-6 sm:py-5">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <button
                          type="button"
                          onClick={() => toggleExpandedTrigger(trigger.id)}
                          className="group flex min-w-0 flex-1 items-start gap-3 text-left"
                        >
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors group-hover:text-txt">
                            <Clock3 className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-semibold text-txt">
                                {trigger.displayName}
                              </span>
                              <StatusBadge
                                label={
                                  trigger.enabled
                                    ? t("heartbeatsview.statusActive")
                                    : t("heartbeatsview.statusPaused")
                                }
                                tone={trigger.enabled ? "success" : "muted"}
                                withDot
                              />
                              {trigger.lastStatus && (
                                <StatusBadge
                                  label={localizedExecutionStatus(
                                    trigger.lastStatus,
                                    t,
                                  )}
                                  tone={toneForLastStatus(trigger.lastStatus)}
                                />
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                              <span>{scheduleLabel(trigger, t)}</span>
                              {trigger.nextRunAtMs && (
                                <span>
                                  {t("heartbeatsview.nextInline", {
                                    time: formatDateTime(trigger.nextRunAtMs),
                                  })}
                                </span>
                              )}
                              {trigger.runCount > 0 && (
                                <span>
                                  {runCountLabel(trigger.runCount, t)}
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronDown
                            className={`mt-1 h-4 w-4 shrink-0 text-muted transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          />
                        </button>

                        <div className="flex items-center gap-2 pl-[52px] lg:pl-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-3 text-xs"
                            disabled={triggersSaving}
                            onClick={() =>
                              void onRunSelectedTrigger(trigger.id)
                            }
                          >
                            {t("triggersview.RunNow")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-3 text-xs"
                            onClick={() => openEditEditor(trigger)}
                          >
                            <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                            {t("triggersview.Edit")}
                          </Button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-4 grid gap-5 border-t border-border/50 pt-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
                          <div className="space-y-4">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                                {t("triggersview.Instructions")}
                              </div>
                              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-txt/90">
                                {trigger.instructions}
                              </p>
                            </div>

                            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
                              <div>
                                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                                  {t("triggersview.WakeMode")}
                                </dt>
                                <dd className="mt-1 text-txt">
                                  {wakeModeLabel(trigger.wakeMode, t)}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                                  {t("heartbeatsview.maxRuns")}
                                </dt>
                                <dd className="mt-1 text-txt">
                                  {trigger.maxRuns
                                    ? trigger.maxRuns
                                    : t("heartbeatsview.unlimited")}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                                  {t("triggersview.LastRun")}
                                </dt>
                                <dd className="mt-1 text-txt">
                                  {formatDateTime(trigger.lastRunAtIso, {
                                    fallback: t("heartbeatsview.notYetRun"),
                                  })}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                                  {t("heartbeatsview.nextRun")}
                                </dt>
                                <dd className="mt-1 text-txt">
                                  {formatDateTime(trigger.nextRunAtMs, {
                                    fallback: t("heartbeatsview.notScheduled"),
                                  })}
                                </dd>
                              </div>
                            </dl>

                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 px-3 text-xs"
                                disabled={triggersSaving}
                                onClick={() =>
                                  void onToggleTriggerEnabled(
                                    trigger.id,
                                    trigger.enabled,
                                  )
                                }
                              >
                                {trigger.enabled
                                  ? t("heartbeatsview.disable")
                                  : t("heartbeatsview.enable")}
                              </Button>
                            </div>
                          </div>

                          <div className="space-y-3 rounded-2xl bg-bg/45 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                                {t("triggersview.RunHistory")}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 px-3 text-xs"
                                onClick={() => void loadTriggerRuns(trigger.id)}
                              >
                                {t("heartbeatsview.refresh")}
                              </Button>
                            </div>

                            {!hasLoadedRuns ? (
                              <div className="py-2 text-sm text-muted">
                                {t("heartbeatsview.loading")}
                              </div>
                            ) : runs.length === 0 ? (
                              <div className="py-2 text-sm text-muted">
                                {t("triggersview.NoRunsRecordedYet")}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {runs
                                  .slice()
                                  .reverse()
                                  .map((run) => (
                                    <div
                                      key={run.triggerRunId}
                                      className="rounded-xl bg-card/70 px-3 py-3 text-sm"
                                    >
                                      <div className="flex items-start gap-2">
                                        <StatusDot
                                          status={run.status}
                                          className="mt-1"
                                        />
                                        <div className="min-w-0 flex-1">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium text-txt">
                                              {localizedExecutionStatus(
                                                run.status,
                                                t,
                                              )}
                                            </span>
                                            <span className="text-xs text-muted">
                                              {formatDateTime(run.finishedAt, {
                                                fallback: t(
                                                  "heartbeatsview.emDash",
                                                ),
                                              })}
                                            </span>
                                          </div>
                                          <div className="mt-1 text-xs text-muted">
                                            {formatDurationMs(run.latencyMs)} ·{" "}
                                            {run.source}
                                          </div>
                                          {run.error && (
                                            <div className="mt-2 text-xs text-danger">
                                              {run.error}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {editorOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 px-4 py-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeEditor();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeEditor();
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-label={modalTitle}
          tabIndex={-1}
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[1.5rem] border border-border/60 bg-card shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
            <div className="flex items-start justify-between gap-4 border-b border-border/50 px-5 py-4 sm:px-6">
              <div className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                  {editingId
                    ? t("heartbeatsview.editHeartbeat")
                    : t("heartbeatsview.createHeartbeat")}
                </div>
                <h2 className="text-lg font-semibold text-txt">{modalTitle}</h2>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={closeEditor}
              >
                {t("heartbeatsview.close")}
              </Button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {triggerError && (
                <div className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                  {triggerError}
                </div>
              )}

              <div className="grid gap-4">
                <div>
                  <span className={FIELD_LABEL_CLASS}>
                    {t("triggersview.Name")}
                  </span>
                  <Input
                    className={INPUT_CLASS}
                    value={form.displayName}
                    onChange={(event) =>
                      setField("displayName", event.target.value)
                    }
                    placeholder={t("triggersview.eGDailyDigestH")}
                  />
                </div>

                <div>
                  <span className={FIELD_LABEL_CLASS}>
                    {t("triggersview.Instructions")}
                  </span>
                  <textarea
                    className={TEXTAREA_CLASS}
                    value={form.instructions}
                    onChange={(event) =>
                      setField("instructions", event.target.value)
                    }
                    placeholder={t("triggersview.WhatShouldTheAgen")}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <span className={FIELD_LABEL_CLASS}>
                      {t("triggersview.ScheduleType")}
                    </span>
                    <select
                      className={SELECT_CLASS}
                      value={form.triggerType}
                      onChange={(event) =>
                        setField(
                          "triggerType",
                          event.target.value as TriggerType,
                        )
                      }
                    >
                      <option value="interval">
                        {t("triggersview.RepeatingInterval")}
                      </option>
                      <option value="once">{t("triggersview.OneTime")}</option>
                      <option value="cron">
                        {t("triggersview.CronSchedule")}
                      </option>
                    </select>
                  </div>

                  <div>
                    <span className={FIELD_LABEL_CLASS}>
                      {t("triggersview.WakeMode")}
                    </span>
                    <select
                      className={SELECT_CLASS}
                      value={form.wakeMode}
                      onChange={(event) =>
                        setField(
                          "wakeMode",
                          event.target.value as TriggerWakeMode,
                        )
                      }
                    >
                      <option value="inject_now">
                        {t("triggersview.InjectAmpWakeIm")}
                      </option>
                      <option value="next_autonomy_cycle">
                        {t("triggersview.QueueForNextCycle")}
                      </option>
                    </select>
                  </div>
                </div>

                {form.triggerType === "interval" && (
                  <div>
                    <span className={FIELD_LABEL_CLASS}>
                      {t("heartbeatsview.interval")}
                    </span>
                    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
                      <Input
                        type="number"
                        min="1"
                        className={INPUT_CLASS}
                        value={form.durationValue}
                        onChange={(event) =>
                          setField("durationValue", event.target.value)
                        }
                        placeholder="1"
                      />
                      <select
                        className={SELECT_CLASS}
                        value={form.durationUnit}
                        onChange={(event) =>
                          setField(
                            "durationUnit",
                            event.target.value as DurationUnit,
                          )
                        }
                      >
                        {DURATION_UNITS.map((unit) => (
                          <option key={unit.unit} value={unit.unit}>
                            {durationUnitLabel(unit.unit, t)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {form.triggerType === "once" && (
                  <div>
                    <span className={FIELD_LABEL_CLASS}>
                      {t("triggersview.ScheduledTimeISO")}
                    </span>
                    <Input
                      type="datetime-local"
                      className={INPUT_CLASS}
                      value={form.scheduledAtIso}
                      onChange={(event) =>
                        setField("scheduledAtIso", event.target.value)
                      }
                    />
                  </div>
                )}

                {form.triggerType === "cron" && (
                  <div>
                    <span className={FIELD_LABEL_CLASS}>
                      {t("triggersview.CronExpression5F")}
                    </span>
                    <Input
                      className={`${INPUT_CLASS} font-mono`}
                      value={form.cronExpression}
                      onChange={(event) =>
                        setField("cronExpression", event.target.value)
                      }
                      placeholder="*/15 * * * *"
                    />
                    <div className="mt-2 text-[11px] text-muted">
                      {t("triggersview.minuteHourDayMont")}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <span className={FIELD_LABEL_CLASS}>
                      {t("triggersview.MaxRunsOptional")}
                    </span>
                    <Input
                      className={INPUT_CLASS}
                      value={form.maxRuns}
                      onChange={(event) =>
                        setField("maxRuns", event.target.value)
                      }
                      placeholder="∞"
                    />
                  </div>

                  <div className="flex items-end">
                    <label className="inline-flex cursor-pointer select-none items-center gap-2 rounded-xl bg-bg/55 px-3 py-3 text-sm text-txt">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(event) =>
                          setField("enabled", event.target.checked)
                        }
                      />
                      {t("triggersview.StartEnabled")}
                    </label>
                  </div>
                </div>

                {formError && (
                  <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {formError}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-5 py-4 sm:px-6">
              <Button
                variant="default"
                size="sm"
                className="h-10 px-4 text-sm shadow-sm"
                disabled={triggersSaving}
                onClick={() => void onSubmit()}
              >
                {triggersSaving
                  ? t("heartbeatsview.saving")
                  : editingId
                    ? t("heartbeatsview.saveChanges")
                    : t("heartbeatsview.createHeartbeat")}
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="h-10 px-4 text-sm"
                onClick={closeEditor}
              >
                {t("onboarding.cancel")}
              </Button>

              {editingId && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 px-4 text-sm"
                    disabled={triggersSaving}
                    onClick={() => void onRunSelectedTrigger(editingId)}
                  >
                    {t("triggersview.RunNow")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 px-4 text-sm"
                    onClick={() =>
                      void onToggleTriggerEnabled(editingId, editorEnabled)
                    }
                  >
                    {editorEnabled
                      ? t("heartbeatsview.disable")
                      : t("heartbeatsview.enable")}
                  </Button>
                  <span className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 px-4 text-sm text-danger hover:border-danger"
                    onClick={() => void onDelete()}
                  >
                    {t("triggersview.Delete")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
