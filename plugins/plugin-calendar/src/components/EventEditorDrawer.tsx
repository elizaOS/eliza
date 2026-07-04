/**
 * Owner-facing drawer for creating and editing a calendar event: title, time
 * window, calendar/account selection, and attendees, submitting through the
 * augmented `@elizaos/ui` client to the calendar routes. Mounted by the
 * calendar views when the owner adds or edits an event.
 */
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarSummary,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TagEditor,
  Textarea,
} from "@elizaos/ui/components";
import { useAppSelector } from "@elizaos/ui/state";
import {
  Check,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import "../api/client-calendar.js";
import type { CalendarClientMethods } from "../api/client-calendar.js";

const calendarClient = client as typeof client & CalendarClientMethods;

type EditorMode = "edit" | "create";

function EventEditorInput({
  mode,
  field,
  label,
  description,
  inputType,
  value,
  placeholder,
  ariaLabel,
  onChange,
}: {
  mode: EditorMode;
  field: string;
  label: string;
  description: string;
  inputType?: string;
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: `event-${mode}-${field}`,
    role: inputType === "datetime-local" ? "text-input" : "text-input",
    label,
    group: "lifeops-event-editor",
    description,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Input
      ref={ref}
      id={`event-editor-${field}`}
      type={inputType}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      {...agentProps}
    />
  );
}

function EventEditorNotes({
  mode,
  value,
  placeholder,
  onChange,
}: {
  mode: EditorMode;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: `event-${mode}-notes`,
    role: "textarea",
    label: "Event notes",
    group: "lifeops-event-editor",
    description: "Notes for the calendar event",
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Textarea
      ref={ref}
      id="event-editor-notes"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="min-h-20"
      {...agentProps}
    />
  );
}

function EventEditorActionButton({
  agentId,
  label,
  description,
  children,
  ...buttonProps
}: {
  agentId: string;
  label: string;
  description: string;
  children: ReactNode;
} & ComponentProps<typeof Button>) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "lifeops-event-editor",
    description,
  });
  return (
    <Button ref={ref} {...buttonProps} {...agentProps}>
      {children}
    </Button>
  );
}

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const APPLE_CALENDAR_GRANT_ID = "apple-calendar";
const APPLE_CALENDAR_PROVIDER = "apple_calendar";

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
    notes: event.description,
    location: event.location,
    attendees,
    calendarId: event.calendarId,
    grantId: event.grantId ?? "",
    side: event.side,
  };
}

function attendeesToContract(
  emails: string[],
): CreateLifeOpsCalendarEventAttendee[] {
  const valid = emails
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && basicEmailValid(value))
    .map((value) => value.toLowerCase());
  const deduped = [...new Set(valid)];
  return deduped.map((email) => ({ email }));
}

function normalizedEmailList(emails: string[]): string[] {
  return attendeesToContract(emails)
    .map((attendee) => attendee.email)
    .sort();
}

function calendarOptionValue(
  calendar: Pick<LifeOpsCalendarSummary, "side" | "grantId" | "calendarId">,
): string {
  return [calendar.side, calendar.grantId, calendar.calendarId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function EventEditorCalendarSelect({
  mode,
  calendarOptions,
  value,
  placeholder,
  ariaLabel,
  onSelect,
}: {
  mode: EditorMode;
  calendarOptions: LifeOpsCalendarSummary[];
  value: string;
  placeholder: string;
  ariaLabel: string;
  onSelect: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `event-${mode}-calendar`,
    role: "select",
    label: "Calendar of record",
    group: "lifeops-event-editor",
    description: "Calendar that will own this event",
    options: calendarOptions.map((calendar) => calendarOptionValue(calendar)),
    getValue: () => value,
    onFill: onSelect,
  });
  return (
    <Select value={value} onValueChange={onSelect}>
      <SelectTrigger
        ref={ref}
        id="event-editor-calendar"
        aria-label={ariaLabel}
        {...agentProps}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {calendarOptions.map((calendar) => (
          <SelectItem
            key={`${calendar.side}:${calendar.grantId}:${calendar.calendarId}`}
            value={calendarOptionValue(calendar)}
          >
            <span>{calendar.summary}</span>
            {calendar.accountEmail ? (
              <>
                <span
                  className="mx-1.5 inline-block h-1 w-1 rounded-full bg-current opacity-55"
                  aria-hidden
                />
                <span>{calendar.accountEmail}</span>
              </>
            ) : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function sameCalendarIdentity(
  calendar: Pick<LifeOpsCalendarSummary, "side" | "grantId" | "calendarId">,
  state: Pick<FormState, "side" | "grantId" | "calendarId">,
): boolean {
  return (
    calendar.side === state.side &&
    calendar.grantId === state.grantId &&
    calendar.calendarId === state.calendarId
  );
}

function findSelectedCalendarOption(
  calendars: LifeOpsCalendarSummary[],
  state: Pick<FormState, "side" | "grantId" | "calendarId">,
): LifeOpsCalendarSummary | null {
  const exact = calendars.find((calendar) =>
    sameCalendarIdentity(calendar, state),
  );
  if (exact) return exact;
  if (state.grantId) return null;
  const matches = calendars.filter(
    (calendar) =>
      calendar.side === state.side && calendar.calendarId === state.calendarId,
  );
  return matches.length === 1 ? matches[0] : null;
}

function didAttendeesChange(
  formAttendees: string[],
  event: LifeOpsCalendarEvent,
): boolean {
  const previous = normalizedEmailList(
    event.attendees
      .map((attendee) => attendee.email?.trim() ?? "")
      .filter((email) => email.length > 0),
  );
  const next = normalizedEmailList(formAttendees);
  return JSON.stringify(previous) !== JSON.stringify(next);
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
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
  const [form, setForm] = useState<FormState>(() =>
    event ? formStateFromEvent(event) : blankFormState(createDefaults),
  );
  const [calendars, setCalendars] = useState<LifeOpsCalendarSummary[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreate = mode === "create";
  const calendarRequestSide = isCreate
    ? (createDefaults?.side ?? "owner")
    : (event?.side ?? "owner");

  // Seed form when the event changes (edit) or drawer opens in create mode.
  useEffect(() => {
    if (!open) return;
    if (isCreate) {
      setForm(blankFormState(createDefaults));
    } else if (event) {
      setForm(formStateFromEvent(event));
    }
    setError(null);
  }, [open, isCreate, event, createDefaults]);

  // Load calendar list when drawer opens. The selector is sourced from
  // `calendarClient.getLifeOpsCalendars()`; if the call fails we fall back to a
  // single "Primary" pseudo-row so the UI still renders.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCalendarsLoading(true);
    setCalendarsError(null);
    void calendarClient
      .getLifeOpsCalendars({ side: calendarRequestSide })
      .then((response) => {
        if (cancelled) return;
        setCalendars(response.calendars);
        setForm((prev) => {
          if (prev.calendarId) {
            const selected = findSelectedCalendarOption(
              response.calendars,
              prev,
            );
            return selected && !prev.grantId
              ? {
                  ...prev,
                  grantId: selected.grantId,
                  side: selected.side,
                }
              : prev;
          }
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
  }, [open, calendarRequestSide]);

  const calendarOptions = useMemo(() => {
    if (calendars.length > 0) return calendars;
    // Fallback row so the Select still renders something while the list is
    // loading or after a failed fetch. The ID matches what the backend uses
    // when no calendar is supplied on create/update.
    return [
      {
        provider:
          form.grantId === APPLE_CALENDAR_GRANT_ID
            ? APPLE_CALENDAR_PROVIDER
            : "google",
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

  const updateForm = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

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
          const attendees = attendeesToContract(form.attendees);
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
            attendees: attendees.length > 0 ? attendees : undefined,
          };
          const result =
            await calendarClient.createLifeOpsCalendarEvent(request);
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
            setForm(
              blankFormState({
                ...createDefaults,
                side: form.side,
                grantId: form.grantId,
                calendarId: form.calendarId,
              }),
            );
          } else {
            onClose();
          }
        } else {
          if (!event) return;
          const patch: LifeOpsCalendarEventUpdate = {
            side: form.side,
            grantId: form.grantId || event.grantId,
            calendarId: form.calendarId || event.calendarId,
            timeZone: event.timezone ?? TIME_ZONE,
          };
          if (titleTrimmed !== event.title) patch.title = titleTrimmed;
          if (startIso !== event.startAt) patch.startAt = startIso;
          if (endIso !== event.endAt) patch.endAt = endIso;
          if (form.notes.trim() !== event.description) {
            patch.notes = form.notes.trim();
          }
          if (form.location.trim() !== event.location) {
            patch.location = form.location.trim();
          }
          if (didAttendeesChange(form.attendees, event)) {
            patch.attendees = attendeesToContract(form.attendees);
          }
          const result = await calendarClient.updateLifeOpsCalendarEvent(
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
      await calendarClient.deleteLifeOpsCalendarEvent(event.externalId, {
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
    ? t("eventEditor.creating", { defaultValue: "Creating event" })
    : t("common.saving", { defaultValue: "Saving event" });

  const selectedCalendarOption = findSelectedCalendarOption(
    calendarOptions,
    form,
  );
  const calendarSelectValue = selectedCalendarOption
    ? calendarOptionValue(selectedCalendarOption)
    : "";

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent
          className="fixed bottom-0 right-0 top-0 !left-auto !right-0 !top-0 m-0 h-full w-[min(28rem,100vw)] max-w-[100vw] !translate-x-0 !translate-y-0 overflow-y-auto bg-bg p-0 duration-200 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-right-full"
          data-testid="event-editor-drawer"
        >
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div>
              <div className="text-sm font-semibold text-txt">{titleLabel}</div>
            </div>
            <Button
              unstyled
              type="button"
              onClick={onClose}
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="p-1.5 text-muted transition-colors hover:text-txt"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-4 px-5 py-5">
            {error ? (
              <div className="px-1 py-1 text-xs text-danger">{error}</div>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-title"
                className="block text-xs font-medium text-muted"
              >
                {t("common.title", { defaultValue: "Title" })}
              </label>
              <EventEditorInput
                mode={mode}
                field="title"
                label="Event title"
                description="Title of the calendar event"
                value={form.title}
                onChange={(value) => updateForm("title", value)}
                placeholder={t("eventEditor.titlePlaceholder", {
                  defaultValue: "Event title",
                })}
                ariaLabel={t("eventEditor.titleAria", {
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
                <EventEditorInput
                  mode={mode}
                  field="start-at"
                  label="Event start time"
                  description="Start date and time of the event"
                  inputType="datetime-local"
                  value={form.startAt}
                  onChange={(value) => updateForm("startAt", value)}
                  ariaLabel={t("eventEditor.startAtAria", {
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
                <EventEditorInput
                  mode={mode}
                  field="end-at"
                  label="Event end time"
                  description="End date and time of the event"
                  inputType="datetime-local"
                  value={form.endAt}
                  onChange={(value) => updateForm("endAt", value)}
                  ariaLabel={t("eventEditor.endAtAria", {
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
              <EventEditorInput
                mode={mode}
                field="location"
                label="Event location"
                description="Location of the calendar event"
                value={form.location}
                onChange={(value) => updateForm("location", value)}
                placeholder={t("eventEditor.locationPlaceholder", {
                  defaultValue: "Location (optional)",
                })}
                ariaLabel={t("eventEditor.locationAria", {
                  defaultValue: "Event location",
                })}
              />
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">
                {t("eventEditor.attendees", { defaultValue: "Attendees" })}
              </span>
              <TagEditor
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
              <EventEditorCalendarSelect
                mode={mode}
                calendarOptions={calendarOptions}
                value={calendarSelectValue}
                placeholder={
                  calendarsLoading
                    ? t("eventEditor.calendarLoading", {
                        defaultValue: "Calendar sync",
                      })
                    : t("eventEditor.calendarPlaceholder", {
                        defaultValue: "Select calendar",
                      })
                }
                ariaLabel={t("eventEditor.calendarAria", {
                  defaultValue: "Calendar of record",
                })}
                onSelect={(value) => {
                  const match = calendarOptions.find(
                    (calendar) => calendarOptionValue(calendar) === value,
                  );
                  if (!match) return;
                  setForm((prev) => ({
                    ...prev,
                    calendarId: match.calendarId,
                    grantId: match.grantId,
                    side: match.side,
                  }));
                }}
              />
              {calendarsError ? (
                <div className="text-[10px] text-danger">{calendarsError}</div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-notes"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.notes", { defaultValue: "Notes" })}
              </label>
              <EventEditorNotes
                mode={mode}
                value={form.notes}
                onChange={(value) => updateForm("notes", value)}
                placeholder={t("eventEditor.notesPlaceholder", {
                  defaultValue: "Notes",
                })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {!isCreate && onChat && event ? (
                <EventEditorActionButton
                  agentId={`event-${mode}-chat`}
                  label="Chat about event"
                  description="Open chat about this event"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted"
                  onClick={() => onChat(event)}
                >
                  <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only">
                    {t("common.chat", { defaultValue: "Chat" })}
                  </span>
                </EventEditorActionButton>
              ) : null}
              {!isCreate ? (
                <EventEditorActionButton
                  agentId={`event-${mode}-delete`}
                  label="Delete event"
                  description="Delete this calendar event"
                  variant="surfaceDestructive"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={deleting || saving}
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                  <span className="sr-only">
                    {t("common.delete", { defaultValue: "Delete" })}
                  </span>
                </EventEditorActionButton>
              ) : null}
            </div>
            <div className="flex gap-2">
              <EventEditorActionButton
                agentId={`event-${mode}-cancel`}
                label="Cancel event editor"
                description="Close the event editor without saving"
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={onClose}
                disabled={saving}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </span>
              </EventEditorActionButton>
              <EventEditorActionButton
                agentId={`event-${mode}-save-continue`}
                label="Save and continue"
                description="Save the event and keep the editor open"
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={saving || !form.title.trim()}
                onClick={() => void handleSave({ keepOpen: true })}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className="sr-only">
                  {saving
                    ? primaryActionLoadingLabel
                    : t("eventEditor.saveAndContinue", {
                        defaultValue: "Save and continue",
                      })}
                </span>
              </EventEditorActionButton>
              <EventEditorActionButton
                agentId={`event-${mode}-save`}
                label={isCreate ? "Create event" : "Save event"}
                description="Save the calendar event and close the editor"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={saving || !form.title.trim()}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : isCreate ? (
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className="sr-only">
                  {saving ? primaryActionLoadingLabel : primaryActionLabel}
                </span>
              </EventEditorActionButton>
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
