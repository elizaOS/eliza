import {
  Button,
  ConfirmDialog,
  client,
  Dialog,
  DialogContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TagInput,
  Textarea,
  useApp,
} from "@elizaos/app-core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarSummary,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const REMINDER_PRESETS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: "5m", minutes: 5 },
  { label: "10m", minutes: 10 },
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "1d", minutes: 1440 },
];

type RecurrencePresetValue =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "custom";

const WEEKDAY_RRULE_CODES = [
  "SU",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
] as const;

function toLocalInputValue(isoString: string | null): string {
  if (!isoString) {
    return "";
  }
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  // datetime-local input expects "YYYY-MM-DDTHH:mm"
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(localValue: string): string | null {
  if (!localValue) {
    return null;
  }
  const parsed = new Date(localValue);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nextHalfHourIso(now = new Date()): string {
  const ms = 30 * 60 * 1000;
  const start = new Date(Math.ceil(now.getTime() / ms) * ms);
  return start.toISOString();
}

function isoPlusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function basicEmailValid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function rruleForPreset(
  preset: RecurrencePresetValue,
  date: Date,
): string | null {
  switch (preset) {
    case "daily":
      return "FREQ=DAILY";
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${WEEKDAY_RRULE_CODES[date.getDay()]}`;
    case "monthly":
      return `FREQ=MONTHLY;BYMONTHDAY=${date.getDate()}`;
    case "yearly":
      return "FREQ=YEARLY";
    default:
      return null;
  }
}

function recurrencePresetLabel(
  preset: RecurrencePresetValue,
  date: Date,
): string {
  const weekdayLong = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
  }).format(date);
  switch (preset) {
    case "none":
      return "Does not repeat";
    case "daily":
      return "Daily";
    case "weekly":
      return `Weekly on ${weekdayLong}`;
    case "monthly":
      return `Monthly on day ${date.getDate()}`;
    case "yearly":
      return "Yearly";
    case "custom":
      return "Custom (RRULE)";
  }
}

const RECURRENCE_PRESETS: ReadonlyArray<RecurrencePresetValue> = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "custom",
];

export type EventEditorMode = "create" | "edit";

export interface EventEditorDefaults {
  /** ISO date used to seed the start time when opening in create mode. */
  date?: Date;
  side?: LifeOpsConnectorSide;
  calendarId?: string;
  grantId?: string;
}

export interface EventEditorDrawerProps {
  open: boolean;
  mode?: EventEditorMode;
  event: LifeOpsCalendarEvent | null;
  /** Used when `mode === "create"` to seed defaults. */
  createDefaults?: EventEditorDefaults;
  onClose: () => void;
  onSaved?: (event: LifeOpsCalendarEvent) => void;
  onCreated?: (event: LifeOpsCalendarEvent) => void;
  onDeleted?: (eventId: string) => void;
  onChat?: (event: LifeOpsCalendarEvent) => void;
}

interface FormState {
  title: string;
  startAt: string;
  endAt: string;
  notes: string;
  location: string;
  attendees: string[];
  reminderMinutes: number[];
  recurrencePreset: RecurrencePresetValue;
  customRrule: string;
  calendarId: string;
  grantId: string;
  side: LifeOpsConnectorSide;
}

function blankFormState(defaults?: EventEditorDefaults): FormState {
  const seedDate = defaults?.date ?? new Date();
  const start = nextHalfHourIso(seedDate);
  return {
    title: "",
    startAt: toLocalInputValue(start),
    endAt: toLocalInputValue(isoPlusMinutes(start, 30)),
    notes: "",
    location: "",
    attendees: [],
    reminderMinutes: [],
    recurrencePreset: "none",
    customRrule: "",
    calendarId: defaults?.calendarId ?? "",
    grantId: defaults?.grantId ?? "",
    side: defaults?.side ?? "owner",
  };
}

function formStateFromEvent(event: LifeOpsCalendarEvent): FormState {
  const attendees = event.attendees
    .map((attendee) => attendee.email?.trim() ?? "")
    .filter((email) => email.length > 0);
  return {
    title: event.title,
    startAt: toLocalInputValue(event.startAt),
    endAt: toLocalInputValue(event.endAt),
    notes: event.description ?? "",
    location: event.location ?? "",
    attendees,
    reminderMinutes: [],
    recurrencePreset: "none",
    customRrule: "",
    calendarId: event.calendarId,
    grantId: event.grantId ?? "",
    side: event.side,
  };
}

function buildRecurrenceArray(state: FormState): string[] | undefined {
  if (state.recurrencePreset === "none") {
    return undefined;
  }
  if (state.recurrencePreset === "custom") {
    const rule = state.customRrule.trim();
    if (!rule) return undefined;
    const stripped = rule.startsWith("RRULE:") ? rule.slice("RRULE:".length) : rule;
    return [stripped];
  }
  const startDate = fromLocalInputValue(state.startAt);
  if (!startDate) return undefined;
  const rule = rruleForPreset(state.recurrencePreset, new Date(startDate));
  return rule ? [rule] : undefined;
}

function attendeesToContract(
  emails: string[],
): CreateLifeOpsCalendarEventAttendee[] | undefined {
  const valid = emails
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && basicEmailValid(value));
  if (valid.length === 0) return undefined;
  return valid.map((email) => ({ email }));
}

export function EventEditorDrawer({
  open,
  mode = "edit",
  event,
  createDefaults,
  onClose,
  onSaved,
  onCreated,
  onDeleted,
  onChat,
}: EventEditorDrawerProps) {
  const { setActionNotice, t } = useApp();
  const [form, setForm] = useState<FormState>(() =>
    event ? formStateFromEvent(event) : blankFormState(createDefaults),
  );
  const [calendars, setCalendars] = useState<LifeOpsCalendarSummary[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [customReminderDraft, setCustomReminderDraft] = useState("");
  const [showCustomReminder, setShowCustomReminder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreate = mode === "create";

  // Seed form when the event changes (edit) or drawer opens in create mode.
  useEffect(() => {
    if (!open) return;
    if (isCreate) {
      setForm(blankFormState(createDefaults));
    } else if (event) {
      setForm(formStateFromEvent(event));
    }
    setError(null);
    setCustomReminderDraft("");
    setShowCustomReminder(false);
  }, [open, isCreate, event, createDefaults]);

  // Load calendar list when drawer opens. The selector is sourced from
  // `client.getLifeOpsCalendars()`; if the call fails we fall back to a
  // single "Primary" pseudo-row so the UI still renders.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCalendarsLoading(true);
    setCalendarsError(null);
    void client
      .getLifeOpsCalendars({ side: "owner" })
      .then((response) => {
        if (cancelled) return;
        setCalendars(response.calendars);
        setForm((prev) => {
          if (prev.calendarId) return prev;
          const primary =
            response.calendars.find((calendar) => calendar.primary) ??
            response.calendars[0];
          if (!primary) return prev;
          return {
            ...prev,
            calendarId: primary.calendarId,
            grantId: primary.grantId,
            side: primary.side,
          };
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setCalendars([]);
        setCalendarsError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Could not load calendars.",
        );
      })
      .finally(() => {
        if (!cancelled) setCalendarsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const calendarOptions = useMemo(() => {
    if (calendars.length > 0) return calendars;
    // Fallback row so the Select still renders something while the list is
    // loading or after a failed fetch. The ID matches what the backend uses
    // when no calendar is supplied on create/update.
    return [
      {
        provider: "google" as const,
        side: form.side,
        grantId: form.grantId,
        accountEmail: null,
        calendarId: form.calendarId || "primary",
        summary:
          form.calendarId && form.calendarId !== "primary"
            ? form.calendarId
            : "Primary",
        description: null,
        primary: true,
        accessRole: "owner",
        backgroundColor: null,
        foregroundColor: null,
        timeZone: null,
        selected: true,
        includeInFeed: true,
      },
    ] satisfies LifeOpsCalendarSummary[];
  }, [calendars, form.calendarId, form.grantId, form.side]);

  const updateForm = useCallback(<K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleReminderPreset = useCallback((minutes: number) => {
    setForm((prev) => {
      const exists = prev.reminderMinutes.includes(minutes);
      const next = exists
        ? prev.reminderMinutes.filter((value) => value !== minutes)
        : [...prev.reminderMinutes, minutes];
      next.sort((a, b) => a - b);
      return { ...prev, reminderMinutes: next };
    });
  }, []);

  const addCustomReminder = useCallback(() => {
    const parsed = Number(customReminderDraft);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const minutes = Math.floor(parsed);
    setForm((prev) => {
      if (prev.reminderMinutes.includes(minutes)) return prev;
      const next = [...prev.reminderMinutes, minutes];
      next.sort((a, b) => a - b);
      return { ...prev, reminderMinutes: next };
    });
    setCustomReminderDraft("");
  }, [customReminderDraft]);

  const handleSave = useCallback(
    async (options: { keepOpen?: boolean } = {}) => {
      setError(null);
      const titleTrimmed = form.title.trim();
      if (!titleTrimmed) return;
      const startIso = fromLocalInputValue(form.startAt);
      const endIso = fromLocalInputValue(form.endAt);
      if (!startIso || !endIso) {
        setError(
          t("eventEditor.invalidTimes", {
            defaultValue: "Pick valid start and end times.",
          }),
        );
        return;
      }

      setSaving(true);
      try {
        if (isCreate) {
          const request: CreateLifeOpsCalendarEventRequest = {
            side: form.side,
            grantId: form.grantId || undefined,
            calendarId: form.calendarId || undefined,
            title: titleTrimmed,
            description: form.notes.trim() || undefined,
            location: form.location.trim() || undefined,
            startAt: startIso,
            endAt: endIso,
            timeZone: TIME_ZONE,
            attendees: attendeesToContract(form.attendees),
            recurrence: buildRecurrenceArray(form),
            reminders:
              form.reminderMinutes.length > 0
                ? form.reminderMinutes.map((minutesBefore) => ({
                    minutesBefore,
                  }))
                : undefined,
          };
          const result = await client.createLifeOpsCalendarEvent(request);
          if (!result.event) {
            throw new Error("Calendar create returned no event.");
          }
          setActionNotice(
            t("eventEditor.created", {
              defaultValue: "Event created.",
            }),
            "success",
            2400,
          );
          onCreated?.(result.event);
          if (options.keepOpen) {
            setForm(blankFormState({ ...createDefaults, side: form.side }));
          } else {
            onClose();
          }
        } else {
          if (!event) return;
          const patch: LifeOpsCalendarEventUpdate = {
            side: event.side,
            grantId: event.grantId,
            calendarId: form.calendarId || event.calendarId,
            timeZone: event.timezone ?? TIME_ZONE,
          };
          if (titleTrimmed !== event.title) patch.title = titleTrimmed;
          if (startIso !== event.startAt) patch.startAt = startIso;
          if (endIso !== event.endAt) patch.endAt = endIso;
          if (form.notes.trim() !== (event.description ?? "")) {
            patch.notes = form.notes.trim();
          }
          if (form.location.trim() !== (event.location ?? "")) {
            patch.location = form.location.trim();
          }
          const attendeesContract = attendeesToContract(form.attendees);
          if (attendeesContract) {
            patch.attendees = attendeesContract;
          }
          const recurrence = buildRecurrenceArray(form);
          if (recurrence) {
            patch.recurrence = recurrence;
          }
          if (form.reminderMinutes.length > 0) {
            patch.reminders = form.reminderMinutes.map((minutesBefore) => ({
              minutesBefore,
            }));
          }
          const result = await client.updateLifeOpsCalendarEvent(
            event.externalId,
            patch,
          );
          setActionNotice(
            t("eventEditor.saved", { defaultValue: "Event saved." }),
            "success",
            2400,
          );
          onSaved?.(result.event);
          if (options.keepOpen) {
            setForm(formStateFromEvent(result.event));
          } else {
            onClose();
          }
        }
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : t("eventEditor.saveFailed", {
                defaultValue: "Could not save the event.",
              }),
        );
      } finally {
        setSaving(false);
      }
    },
    [
      createDefaults,
      event,
      form,
      isCreate,
      onClose,
      onCreated,
      onSaved,
      setActionNotice,
      t,
    ],
  );

  const handleDelete = useCallback(async () => {
    if (!event) return;
    setDeleting(true);
    setError(null);
    try {
      await client.deleteLifeOpsCalendarEvent(event.externalId, {
        side: event.side,
        grantId: event.grantId,
        calendarId: event.calendarId,
      });
      setActionNotice(
        t("eventEditor.deleted", { defaultValue: "Event deleted." }),
        "success",
        2400,
      );
      onDeleted?.(event.id);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("eventEditor.deleteFailed", {
              defaultValue: "Could not delete the event.",
            }),
      );
    } finally {
      setDeleting(false);
      setConfirmDeleteOpen(false);
    }
  }, [event, onClose, onDeleted, setActionNotice, t]);

  const startDate = useMemo(() => {
    const iso = fromLocalInputValue(form.startAt);
    return iso ? new Date(iso) : new Date();
  }, [form.startAt]);

  if (!isCreate && !event) {
    return null;
  }

  const titleLabel = isCreate
    ? t("eventEditor.createTitle", { defaultValue: "New event" })
    : t("eventEditor.title", { defaultValue: "Edit event" });
  const primaryActionLabel = isCreate
    ? t("eventEditor.create", { defaultValue: "Create" })
    : t("common.save", { defaultValue: "Save" });
  const primaryActionLoadingLabel = isCreate
    ? t("eventEditor.creating", { defaultValue: "Creating…" })
    : t("common.saving", { defaultValue: "Saving…" });

  const calendarSelectValue =
    form.calendarId || calendarOptions[0]?.calendarId || "";

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent
          className="fixed bottom-0 right-0 top-0 !left-auto !right-0 !top-0 m-0 h-full w-[min(28rem,100vw)] max-w-[100vw] !translate-x-0 !translate-y-0 overflow-y-auto rounded-l-2xl rounded-r-none border-l border-t-0 border-border/16 bg-bg p-0 shadow-xl duration-200 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-right-full"
          data-testid="event-editor-drawer"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/12 px-5 py-4">
            <div>
              <div className="text-sm font-semibold text-txt">{titleLabel}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="rounded-full p-1.5 text-muted transition-colors hover:bg-bg-hover/40 hover:text-txt"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 px-5 py-5">
            {error ? (
              <div className="rounded-2xl bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-title"
                className="block text-xs font-medium text-muted"
              >
                {t("common.title", { defaultValue: "Title" })}
              </label>
              <Input
                id="event-editor-title"
                value={form.title}
                onChange={(e) => updateForm("title", e.target.value)}
                placeholder={t("eventEditor.titlePlaceholder", {
                  defaultValue: "Event title",
                })}
                aria-label={t("eventEditor.titleAria", {
                  defaultValue: "Event title",
                })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="event-editor-start-at"
                  className="block text-xs font-medium text-muted"
                >
                  {t("eventEditor.startAt", { defaultValue: "Start" })}
                </label>
                <Input
                  id="event-editor-start-at"
                  type="datetime-local"
                  value={form.startAt}
                  onChange={(e) => updateForm("startAt", e.target.value)}
                  aria-label={t("eventEditor.startAtAria", {
                    defaultValue: "Start time",
                  })}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="event-editor-end-at"
                  className="block text-xs font-medium text-muted"
                >
                  {t("eventEditor.endAt", { defaultValue: "End" })}
                </label>
                <Input
                  id="event-editor-end-at"
                  type="datetime-local"
                  value={form.endAt}
                  onChange={(e) => updateForm("endAt", e.target.value)}
                  aria-label={t("eventEditor.endAtAria", {
                    defaultValue: "End time",
                  })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-location"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.location", { defaultValue: "Location" })}
              </label>
              <Input
                id="event-editor-location"
                value={form.location}
                onChange={(e) => updateForm("location", e.target.value)}
                placeholder={t("eventEditor.locationPlaceholder", {
                  defaultValue: "Location (optional)",
                })}
                aria-label={t("eventEditor.locationAria", {
                  defaultValue: "Event location",
                })}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-recurrence"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.recurrence", { defaultValue: "Repeat" })}
              </label>
              <Select
                value={form.recurrencePreset}
                onValueChange={(value) =>
                  updateForm("recurrencePreset", value as RecurrencePresetValue)
                }
              >
                <SelectTrigger
                  id="event-editor-recurrence"
                  aria-label={t("eventEditor.recurrenceAria", {
                    defaultValue: "Recurrence",
                  })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {recurrencePresetLabel(preset, startDate)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.recurrencePreset === "custom" ? (
                <Input
                  className="mt-2"
                  value={form.customRrule}
                  onChange={(e) => updateForm("customRrule", e.target.value)}
                  placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                  aria-label={t("eventEditor.customRruleAria", {
                    defaultValue: "Custom RRULE",
                  })}
                />
              ) : null}
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">
                {t("eventEditor.attendees", { defaultValue: "Attendees" })}
              </span>
              <TagInput
                items={form.attendees}
                onChange={(next) =>
                  updateForm(
                    "attendees",
                    next.filter((value) => basicEmailValid(value)),
                  )
                }
                placeholder={t("eventEditor.attendeePlaceholder", {
                  defaultValue: "Add email and press Enter",
                })}
                addLabel={t("eventEditor.attendeeAdd", {
                  defaultValue: "Add attendee",
                })}
                removeLabel={t("eventEditor.attendeeRemove", {
                  defaultValue: "Remove",
                })}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-calendar"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.calendar", { defaultValue: "Calendar" })}
              </label>
              <Select
                value={calendarSelectValue}
                onValueChange={(value) => {
                  const match = calendarOptions.find(
                    (calendar) => calendar.calendarId === value,
                  );
                  setForm((prev) => ({
                    ...prev,
                    calendarId: value,
                    grantId: match?.grantId ?? prev.grantId,
                    side: match?.side ?? prev.side,
                  }));
                }}
              >
                <SelectTrigger
                  id="event-editor-calendar"
                  aria-label={t("eventEditor.calendarAria", {
                    defaultValue: "Calendar of record",
                  })}
                >
                  <SelectValue
                    placeholder={
                      calendarsLoading
                        ? t("eventEditor.calendarLoading", {
                            defaultValue: "Loading…",
                          })
                        : t("eventEditor.calendarPlaceholder", {
                            defaultValue: "Select calendar",
                          })
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {calendarOptions.map((calendar) => (
                    <SelectItem
                      key={`${calendar.grantId}:${calendar.calendarId}`}
                      value={calendar.calendarId}
                    >
                      {calendar.summary}
                      {calendar.accountEmail
                        ? ` · ${calendar.accountEmail}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {calendarsError ? (
                <div className="text-[10px] text-danger">{calendarsError}</div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">
                {t("eventEditor.reminders", { defaultValue: "Reminders" })}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {REMINDER_PRESETS.map((preset) => {
                  const active = form.reminderMinutes.includes(preset.minutes);
                  return (
                    <button
                      key={preset.minutes}
                      type="button"
                      onClick={() => toggleReminderPreset(preset.minutes)}
                      aria-pressed={active}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                        active
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-border/30 text-muted hover:border-border/60 hover:text-txt"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setShowCustomReminder((prev) => !prev)}
                  aria-pressed={showCustomReminder}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    showCustomReminder
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border/30 text-muted hover:border-border/60 hover:text-txt"
                  }`}
                >
                  {t("eventEditor.reminderCustom", { defaultValue: "Custom" })}
                </button>
              </div>
              {form.reminderMinutes.some(
                (minutes) =>
                  !REMINDER_PRESETS.some(
                    (preset) => preset.minutes === minutes,
                  ),
              ) ? (
                <div className="flex flex-wrap gap-1.5">
                  {form.reminderMinutes
                    .filter(
                      (minutes) =>
                        !REMINDER_PRESETS.some(
                          (preset) => preset.minutes === minutes,
                        ),
                    )
                    .map((minutes) => (
                      <span
                        key={minutes}
                        className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
                      >
                        {minutes}m
                        <button
                          type="button"
                          aria-label={t("eventEditor.reminderRemove", {
                            defaultValue: "Remove reminder",
                          })}
                          onClick={() => toggleReminderPreset(minutes)}
                          className="rounded-full p-0.5 hover:bg-accent/20"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                </div>
              ) : null}
              {showCustomReminder ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    value={customReminderDraft}
                    onChange={(e) => setCustomReminderDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomReminder();
                      }
                    }}
                    placeholder={t("eventEditor.reminderCustomPlaceholder", {
                      defaultValue: "Minutes before",
                    })}
                    aria-label={t("eventEditor.reminderCustomAria", {
                      defaultValue: "Custom reminder minutes",
                    })}
                    className="w-32"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl px-3 text-xs"
                    onClick={addCustomReminder}
                  >
                    {t("common.add", { defaultValue: "Add" })}
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-notes"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.notes", { defaultValue: "Notes" })}
              </label>
              <Textarea
                id="event-editor-notes"
                value={form.notes}
                onChange={(e) => updateForm("notes", e.target.value)}
                placeholder={t("eventEditor.notesPlaceholder", {
                  defaultValue: "Add notes…",
                })}
                className="min-h-20"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/12 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {!isCreate && onChat && event ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-xs font-semibold text-muted"
                  onClick={() => onChat(event)}
                >
                  {t("common.chat", { defaultValue: "Chat" })}
                </Button>
              ) : null}
              {!isCreate ? (
                <Button
                  variant="surfaceDestructive"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-xs font-semibold"
                  disabled={deleting || saving}
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  {t("common.delete", { defaultValue: "Delete" })}
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                onClick={onClose}
                disabled={saving}
              >
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                disabled={saving || !form.title.trim()}
                onClick={() => void handleSave({ keepOpen: true })}
              >
                {saving
                  ? primaryActionLoadingLabel
                  : t("eventEditor.saveAndContinue", {
                      defaultValue: "Save & continue",
                    })}
              </Button>
              <Button
                size="sm"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                disabled={saving || !form.title.trim()}
                onClick={() => void handleSave()}
              >
                {saving ? primaryActionLoadingLabel : primaryActionLabel}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("eventEditor.confirmDeleteTitle", {
          defaultValue: "Delete event?",
        })}
        message={t("eventEditor.confirmDeleteDescription", {
          defaultValue:
            "This will delete the event from your calendar. This cannot be undone.",
        })}
        confirmLabel={t("common.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </>
  );
}
