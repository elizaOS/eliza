import {
  Button,
  ConfirmDialog,
  client,
  Dialog,
  DialogContent,
  Input,
  Textarea,
  useApp,
} from "@elizaos/app-core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/lifeops";
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type CalendarEventPatch = {
  title?: string;
  startAt?: string;
  endAt?: string;
  description?: string;
  minutesBefore?: number[];
};

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

export interface EventEditorDrawerProps {
  open: boolean;
  event: LifeOpsCalendarEvent | null;
  onClose: () => void;
  onSaved?: (event: LifeOpsCalendarEvent) => void;
  onDeleted?: (eventId: string) => void;
  onChat?: (event: LifeOpsCalendarEvent) => void;
}

export function EventEditorDrawer({
  open,
  event,
  onClose,
  onSaved,
  onDeleted,
  onChat,
}: EventEditorDrawerProps) {
  const { setActionNotice, t } = useApp();
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notes, setNotes] = useState("");
  const [reminders, setReminders] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!event) {
      return;
    }
    setTitle(event.title);
    setStartAt(toLocalInputValue(event.startAt));
    setEndAt(toLocalInputValue(event.endAt));
    setNotes(event.description ?? "");
    setReminders("");
    setError(null);
  }, [event]);

  const handleSave = useCallback(async () => {
    if (!event) {
      return;
    }
    const patch: CalendarEventPatch = {};
    if (title.trim() && title.trim() !== event.title) {
      patch.title = title.trim();
    }
    const nextStartAt = fromLocalInputValue(startAt);
    if (nextStartAt && nextStartAt !== event.startAt) {
      patch.startAt = nextStartAt;
    }
    const nextEndAt = fromLocalInputValue(endAt);
    if (nextEndAt && nextEndAt !== event.endAt) {
      patch.endAt = nextEndAt;
    }
    if (notes.trim() !== (event.description ?? "")) {
      patch.description = notes.trim();
    }
    const minutesBefore = reminders
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (minutesBefore.length > 0) {
      patch.minutesBefore = minutesBefore;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await client.updateLifeOpsCalendarEvent(event.externalId, {
        side: event.side,
        grantId: event.grantId,
        calendarId: event.calendarId,
        title: patch.title,
        startAt: patch.startAt,
        endAt: patch.endAt,
        timeZone: event.timezone ?? undefined,
        notes: patch.description,
        reminders: patch.minutesBefore?.map((minutesBefore) => ({
          minutesBefore,
        })),
      });
      setActionNotice(
        t("eventEditor.saved", {
          defaultValue: "Event saved.",
        }),
        "success",
        2400,
      );
      onSaved?.(result.event);
      onClose();
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
  }, [
    endAt,
    event,
    notes,
    onClose,
    onSaved,
    reminders,
    setActionNotice,
    startAt,
    t,
    title,
  ]);

  const handleDelete = useCallback(async () => {
    if (!event) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await client.deleteLifeOpsCalendarEvent(event.externalId, {
        side: event.side,
        grantId: event.grantId,
        calendarId: event.calendarId,
      });
      setActionNotice(
        t("eventEditor.deleted", {
          defaultValue: "Event deleted.",
        }),
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

  if (!event) {
    return null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent
          className="fixed bottom-0 right-0 top-0 m-0 h-full w-full max-w-sm translate-x-0 translate-y-0 overflow-y-auto rounded-l-2xl rounded-r-none border-l border-t-0 border-border/16 bg-bg p-0 shadow-xl duration-200 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-right-full sm:w-96"
          data-testid="event-editor-drawer"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/12 px-5 py-4">
            <div>
              <div className="text-sm font-semibold text-txt">
                {t("eventEditor.title", {
                  defaultValue: "Edit event",
                })}
              </div>
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
                value={title}
                onChange={(e) => setTitle(e.target.value)}
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
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
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
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  aria-label={t("eventEditor.endAtAria", {
                    defaultValue: "End time",
                  })}
                />
              </div>
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
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("eventEditor.notesPlaceholder", {
                  defaultValue: "Add notes…",
                })}
                className="min-h-20"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-reminders"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.reminders", {
                  defaultValue: "Reminders (minutes before, comma-separated)",
                })}
              </label>
              <Input
                id="event-editor-reminders"
                value={reminders}
                onChange={(e) => setReminders(e.target.value)}
                placeholder={t("eventEditor.remindersPlaceholder", {
                  defaultValue: "e.g. 10, 30, 60",
                })}
                aria-label={t("eventEditor.remindersAria", {
                  defaultValue: "Reminder minutes before event",
                })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/12 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {onChat ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-xs font-semibold text-muted"
                  onClick={() => onChat(event)}
                >
                  {t("common.chat", { defaultValue: "Chat" })}
                </Button>
              ) : null}
              <Button
                variant="surfaceDestructive"
                size="sm"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                disabled={deleting || saving}
                onClick={() => setConfirmDeleteOpen(true)}
              >
                {t("common.delete", { defaultValue: "Delete" })}
              </Button>
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
                size="sm"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                disabled={saving || !title.trim()}
                onClick={() => void handleSave()}
              >
                {saving
                  ? t("common.saving", { defaultValue: "Saving…" })
                  : t("common.save", { defaultValue: "Save" })}
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
