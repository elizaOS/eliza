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
  TagEditor,
  Textarea,
  useApp,
} from "@elizaos/ui";
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
    notes: event.description ?? "",
    location: event.location ?? "",
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
  const { setActionNotice, t } = useApp();
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
  // `client.getLifeOpsCalendars()`; if the call fails we fall back to a
  // single "Primary" pseudo-row so the UI still renders.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCalendarsLoading(true);
    setCalendarsError(null);
    void client
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
          if (form.notes.trim() !== (event.description ?? "")) {
            patch.notes = form.notes.trim();
          }
          if (form.location.trim() !== (event.location ?? "")) {
            patch.location = form.location.trim();
          }
          if (didAttendeesChange(form.attendees, event)) {
            patch.attendees = attendeesToContract(form.attendees);
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
              <Select
                value={calendarSelectValue}
                onValueChange={(value) => {
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
                      key={`${calendar.side}:${calendar.grantId}:${calendar.calendarId}`}
                      value={calendarOptionValue(calendar)}
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
