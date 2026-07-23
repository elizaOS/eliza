/**
 * Calendar view for chat-driven view switching and
 * event CRUD. A deterministic 42-day grid, selected-day agenda, and compact
 * editor all consume the same server-owned snapshot, including changes made by
 * the agent while another app surface is active.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { todayDateKey } from "../date-key.js";
import type { SimpleCalendarEvent, StickyColor } from "../types.js";
import { useSimpleViewsState } from "./useSimpleViewsState.js";
import {
  AgentAction,
  AgentInput,
  AgentTextarea,
  COLOR_MATERIALS,
  ColorPicker,
  GLASS_PANEL_STYLE,
  handleRenderedMutationFailure,
  LABEL_STYLE,
  SECONDARY_TEXT_STYLE,
  VIEW_ROOT_STYLE,
  ViewState,
} from "./viewPrimitives.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value: string): Date {
  const [year = 1970, month = 1, day = 1] = value
    .split("-")
    .map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day));
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, amount: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1),
  );
}

function calendarDays(cursor: Date): Date[] {
  const first = monthStart(cursor);
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setUTCDate(gridStart.getUTCDate() + index);
    return day;
  });
}

function formatMonth(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatSelectedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parseDateKey(value));
}

function formatTime(value: string): string {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

function eventsOnDate(
  events: SimpleCalendarEvent[],
  date: string,
): SimpleCalendarEvent[] {
  return events
    .filter((event) => event.date === date)
    .toSorted((left, right) =>
      `${left.time}:${left.title}`.localeCompare(
        `${right.time}:${right.title}`,
      ),
    );
}

function CalendarDay({
  day,
  cursor,
  selectedDate,
  events,
  disabled,
  onSelect,
}: {
  day: Date;
  cursor: Date;
  selectedDate: string;
  events: SimpleCalendarEvent[];
  disabled: boolean;
  onSelect: (date: string) => void;
}) {
  const key = dateKey(day);
  const dayEvents = eventsOnDate(events, key);
  const selected = key === selectedDate;
  const currentMonth = day.getUTCMonth() === cursor.getUTCMonth();
  const today = key === todayDateKey();
  const control = useAgentElement<HTMLButtonElement>({
    id: `calendar-day-${key}`,
    label: `Select ${formatSelectedDate(key)}`,
    role: "button",
    group: "calendar-grid",
    description:
      dayEvents.length === 0
        ? "No events"
        : `${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`,
    status: selected
      ? "selected"
      : currentMonth
        ? "current-month"
        : "outside-month",
    onActivate: () => {
      if (!disabled) onSelect(key);
    },
  });

  return (
    <button
      ref={control.ref}
      type="button"
      {...control.agentProps}
      disabled={disabled}
      onClick={() => onSelect(key)}
      style={{
        boxSizing: "border-box",
        minWidth: 0,
        minHeight: "clamp(38px, 7vw, 62px)",
        border: "none",
        borderRadius: 11,
        padding: "6px clamp(4px, .8vw, 8px)",
        background: selected
          ? "var(--accent-subtle, rgba(255,106,31,.15))"
          : currentMonth
            ? "color-mix(in srgb, var(--surface, rgba(255,255,255,.06)) 78%, transparent)"
            : "transparent",
        color: currentMonth
          ? "var(--txt, #f5f5f5)"
          : "var(--muted, rgba(255,255,255,.5))",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.64 : 1,
        boxShadow: selected ? "inset 0 0 0 2px var(--accent, #ff6a1f)" : "none",
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 5,
        transition: "background 150ms ease, opacity 150ms ease",
      }}
    >
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 3,
          fontSize: 12,
          fontWeight: selected ? 760 : 650,
        }}
      >
        {day.getUTCDate()}
        {today ? (
          <span
            aria-hidden
            title="Today"
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "var(--accent, #ff6a1f)",
            }}
          />
        ) : null}
      </span>
      {dayEvents.length > 0 ? (
        <span style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {dayEvents.slice(0, 4).map((event) => (
            <span
              key={event.id}
              title={event.title}
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: COLOR_MATERIALS[event.color].dot,
              }}
            />
          ))}
          {dayEvents.length > 4 ? (
            <span
              style={{
                fontSize: 9,
                lineHeight: "6px",
                color: "var(--muted-strong)",
              }}
            >
              +{dayEvents.length - 4}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function EventRow({
  event,
  editing,
  disabled,
  onEdit,
  onDelete,
}: {
  event: SimpleCalendarEvent;
  editing: boolean;
  disabled: boolean;
  onEdit: (event: SimpleCalendarEvent) => void;
  onDelete: (event: SimpleCalendarEvent) => void;
}) {
  const row = useAgentElement<HTMLElement>({
    id: `calendar-event-${event.id}`,
    label: `Calendar event ${event.title}`,
    role: "card",
    group: "calendar-agenda",
    description: `${event.date} at ${event.time}. ${event.notes}`,
    status: editing ? "editing" : event.color,
  });
  const material = COLOR_MATERIALS[event.color];

  return (
    <article
      ref={row.ref}
      {...row.agentProps}
      style={{
        display: "grid",
        gridTemplateColumns: "4px minmax(0, 1fr) auto",
        gap: 10,
        alignItems: "stretch",
        padding: "10px 0",
      }}
    >
      <span
        aria-hidden
        style={{ borderRadius: 999, background: material.dot }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            minWidth: 0,
          }}
        >
          <strong
            style={{ fontSize: 13, lineHeight: 1.4, overflowWrap: "anywhere" }}
          >
            {event.title}
          </strong>
          <span
            style={{ ...SECONDARY_TEXT_STYLE, flex: "0 0 auto", fontSize: 11 }}
          >
            {formatTime(event.time)}
          </span>
        </div>
        {event.notes ? (
          <p
            style={{
              ...SECONDARY_TEXT_STYLE,
              marginTop: 3,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {event.notes}
          </p>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 1 }}>
        <AgentAction
          agentId={`calendar-edit-event-${event.id}`}
          agentLabel={`Edit event ${event.title}`}
          agentGroup="calendar-agenda"
          agentStatus={editing ? "active" : "idle"}
          variant="quiet"
          compact
          disabled={disabled}
          onClick={() => onEdit(event)}
          title="Edit event"
        >
          <Pencil size={14} aria-hidden />
        </AgentAction>
        <AgentAction
          agentId={`calendar-delete-event-${event.id}`}
          agentLabel={`Delete event ${event.title}`}
          agentGroup="calendar-agenda"
          variant="quiet"
          compact
          disabled={disabled}
          onClick={() => onDelete(event)}
          title="Delete event"
        >
          <Trash2 size={14} aria-hidden />
        </AgentAction>
      </div>
    </article>
  );
}

export function SimpleCalendarView() {
  const { snapshot, loading, busy, error, refresh, mutate } =
    useSimpleViewsState();
  const events = snapshot?.events ?? [];
  const selectedDate = snapshot?.selectedDate ?? todayDateKey();
  const snapshotSelectedDate = snapshot?.selectedDate ?? null;
  const headerDetail = error
    ? snapshot
      ? `Sync unavailable · revision ${snapshot.revision}`
      : "Calendar unavailable"
    : loading
      ? snapshot
        ? `Refreshing… · revision ${snapshot.revision}`
        : "Loading shared calendar…"
      : snapshot
        ? `${events.length} ${events.length === 1 ? "event" : "events"} · revision ${snapshot.revision}`
        : "Calendar unavailable";
  const [cursor, setCursor] = useState(() =>
    monthStart(parseDateKey(selectedDate)),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(selectedDate);
  const [time, setTime] = useState("09:00");
  const [notes, setNotes] = useState("");
  const [color, setColor] = useState<StickyColor>("green");

  const editingEvent = useMemo(
    () => events.find((event) => event.id === editingId) ?? null,
    [editingId, events],
  );
  const selectedEvents = useMemo(
    () => eventsOnDate(events, selectedDate),
    [events, selectedDate],
  );
  const days = useMemo(() => calendarDays(cursor), [cursor]);

  useEffect(() => {
    if (!snapshotSelectedDate || editingId) return;
    setDate(snapshotSelectedDate);
  }, [editingId, snapshotSelectedDate]);

  useEffect(() => {
    if (!snapshotSelectedDate) return;
    setCursor(monthStart(parseDateKey(snapshotSelectedDate)));
  }, [snapshotSelectedDate]);

  const resetEditor = useCallback(
    (nextDate = selectedDate) => {
      setEditingId(null);
      setTitle("");
      setDate(nextDate);
      setTime("09:00");
      setNotes("");
      setColor("green");
    },
    [selectedDate],
  );

  useEffect(() => {
    if (editingId && snapshot && !editingEvent)
      resetEditor(snapshot.selectedDate);
  }, [editingEvent, editingId, resetEditor, snapshot]);

  const selectDate = useCallback(
    async (nextDate: string) => {
      if (busy) return;
      setDate(nextDate);
      try {
        await mutate("select-calendar-date", { date: nextDate });
      } catch (cause) {
        // error-policy:J4 useSimpleViewsState records expected Error failures for this view's alert.
        handleRenderedMutationFailure(cause);
      }
    },
    [busy, mutate],
  );

  const goToday = useCallback(() => {
    const today = todayDateKey();
    setCursor(monthStart(parseDateKey(today)));
    void selectDate(today);
  }, [selectDate]);

  const editEvent = useCallback((event: SimpleCalendarEvent) => {
    setEditingId(event.id);
    setTitle(event.title);
    setDate(event.date);
    setTime(event.time);
    setNotes(event.notes);
    setColor(event.color);
  }, []);

  const submit = useCallback(async () => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || busy) return;
    try {
      if (editingId) {
        await mutate("update-calendar-event", {
          id: editingId,
          title: normalizedTitle,
          date,
          time,
          notes,
          color,
        });
      } else {
        await mutate("create-calendar-event", {
          title: normalizedTitle,
          date,
          time,
          notes,
          color,
        });
      }
      resetEditor(date);
    } catch (cause) {
      // error-policy:J4 useSimpleViewsState records expected Error failures for this view's alert.
      handleRenderedMutationFailure(cause);
    }
  }, [busy, color, date, editingId, mutate, notes, resetEditor, time, title]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const deleteEvent = useCallback(
    async (event: SimpleCalendarEvent) => {
      if (busy) return;
      try {
        await mutate("delete-calendar-event", { id: event.id });
        if (editingId === event.id) resetEditor();
      } catch (cause) {
        // error-policy:J4 useSimpleViewsState records expected Error failures for this view's alert.
        handleRenderedMutationFailure(cause);
      }
    },
    [busy, editingId, mutate, resetEditor],
  );

  return (
    <main
      aria-busy={loading || busy}
      aria-label={`Calendar. ${headerDetail}`}
      data-testid="simple-calendar-view"
      style={VIEW_ROOT_STYLE}
    >
      <ViewState
        loading={loading && !snapshot}
        error={!snapshot ? error : null}
        empty={false}
        emptyTitle=""
        emptyBody=""
        onRetry={() => void refresh()}
      />

      {snapshot ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 370px), 1fr))",
            gap: 14,
            alignItems: "start",
          }}
        >
          <section
            aria-label="Calendar month"
            style={{
              ...GLASS_PANEL_STYLE,
              padding: "14px clamp(4px, 1.6vw, 16px)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                marginBottom: 13,
              }}
            >
              <h2
                style={{
                  margin: 0,
                  flex: 1,
                  minWidth: 0,
                  fontSize: 16,
                  lineHeight: 1.3,
                  fontWeight: 740,
                }}
              >
                {formatMonth(cursor)}
              </h2>
              <AgentAction
                agentId="calendar-previous-month"
                agentLabel="Show previous month"
                agentGroup="calendar-navigation"
                compact
                disabled={busy}
                onClick={() => setCursor((current) => addMonths(current, -1))}
                title="Previous month"
              >
                <ChevronLeft size={17} aria-hidden />
              </AgentAction>
              <AgentAction
                agentId="calendar-today"
                agentLabel="Select today"
                agentGroup="calendar-navigation"
                disabled={busy}
                onClick={goToday}
              >
                Today
              </AgentAction>
              <AgentAction
                agentId="calendar-next-month"
                agentLabel="Show next month"
                agentGroup="calendar-navigation"
                compact
                disabled={busy}
                onClick={() => setCursor((current) => addMonths(current, 1))}
                title="Next month"
              >
                <ChevronRight size={17} aria-hidden />
              </AgentAction>
            </div>

            <div
              aria-hidden
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                gap: 3,
                marginBottom: 5,
              }}
            >
              {WEEKDAYS.map((weekday) => (
                <span
                  key={weekday}
                  style={{
                    color: "var(--muted, rgba(255,255,255,.58))",
                    fontSize: 10,
                    fontWeight: 680,
                    textAlign: "center",
                  }}
                >
                  {weekday.slice(0, 1)}
                </span>
              ))}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                gap: 3,
              }}
            >
              {days.map((day) => (
                <CalendarDay
                  key={dateKey(day)}
                  day={day}
                  cursor={cursor}
                  selectedDate={selectedDate}
                  events={events}
                  disabled={busy}
                  onSelect={(nextDate) => void selectDate(nextDate)}
                />
              ))}
            </div>
          </section>

          <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
            <section
              aria-label={`Events for ${selectedDate}`}
              style={{ ...GLASS_PANEL_STYLE, padding: 16 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: selectedEvents.length > 0 ? 6 : 12,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 15,
                      lineHeight: 1.35,
                      fontWeight: 720,
                    }}
                  >
                    {formatSelectedDate(selectedDate)}
                  </h2>
                  <p
                    style={{
                      ...SECONDARY_TEXT_STYLE,
                      marginTop: 3,
                      fontSize: 11,
                    }}
                  >
                    {selectedEvents.length === 0
                      ? "No plans yet"
                      : `${selectedEvents.length} ${selectedEvents.length === 1 ? "event" : "events"}`}
                  </p>
                </div>
                <Clock3
                  size={16}
                  aria-hidden
                  style={{ color: "var(--muted)" }}
                />
              </div>
              {selectedEvents.length === 0 ? (
                <p style={{ ...SECONDARY_TEXT_STYLE, margin: 0 }}>
                  Add an event below, or ask Eliza to schedule one on this date.
                </p>
              ) : (
                selectedEvents.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    editing={editingId === event.id}
                    disabled={busy}
                    onEdit={editEvent}
                    onDelete={(candidate) => void deleteEvent(candidate)}
                  />
                ))
              )}
            </section>

            <form
              onSubmit={handleSubmit}
              style={{
                ...GLASS_PANEL_STYLE,
                display: "grid",
                gap: 12,
                padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 15,
                      lineHeight: 1.35,
                      fontWeight: 720,
                    }}
                  >
                    {editingEvent ? "Edit event" : "New event"}
                  </h2>
                  <p
                    style={{
                      ...SECONDARY_TEXT_STYLE,
                      marginTop: 3,
                      fontSize: 11,
                    }}
                  >
                    {editingEvent
                      ? "Update the shared calendar entry."
                      : "Create it here or through chat."}
                  </p>
                </div>
                {editingEvent ? (
                  <AgentAction
                    agentId="calendar-cancel-edit"
                    agentLabel="Cancel calendar event edit"
                    agentGroup="calendar-compose"
                    variant="quiet"
                    compact
                    disabled={busy}
                    onClick={() => resetEditor()}
                    title="Cancel editing"
                  >
                    <X size={16} aria-hidden />
                  </AgentAction>
                ) : null}
              </div>

              <label htmlFor="calendar-event-title" style={LABEL_STYLE}>
                Title
                <AgentInput
                  agentId="calendar-event-title"
                  agentLabel="Calendar event title"
                  agentGroup="calendar-compose"
                  value={title}
                  onValue={setTitle}
                  maxLength={240}
                  placeholder="Event title"
                  disabled={busy}
                />
              </label>
              <div
                data-testid="calendar-event-schedule-fields"
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
                  gap: 10,
                }}
              >
                <label htmlFor="calendar-event-date" style={LABEL_STYLE}>
                  Date
                  <AgentInput
                    agentId="calendar-event-date"
                    agentLabel="Calendar event date"
                    agentGroup="calendar-compose"
                    value={date}
                    onValue={setDate}
                    type="date"
                    disabled={busy}
                  />
                </label>
                <label htmlFor="calendar-event-time" style={LABEL_STYLE}>
                  Time
                  <AgentInput
                    agentId="calendar-event-time"
                    agentLabel="Calendar event time"
                    agentGroup="calendar-compose"
                    value={time}
                    onValue={setTime}
                    type="time"
                    disabled={busy}
                  />
                </label>
              </div>
              <label htmlFor="calendar-event-notes" style={LABEL_STYLE}>
                Details
                <AgentTextarea
                  agentId="calendar-event-notes"
                  agentLabel="Calendar event details"
                  agentGroup="calendar-compose"
                  value={notes}
                  onValue={setNotes}
                  maxLength={20_000}
                  placeholder="Optional details…"
                  disabled={busy}
                  rows={3}
                  style={{ minHeight: 82 }}
                />
              </label>
              <div style={{ ...LABEL_STYLE, gap: 8 }}>
                Color
                <ColorPicker
                  value={color}
                  onChange={setColor}
                  group="calendar-compose"
                />
              </div>
              <AgentAction
                agentId="calendar-save-event"
                agentLabel={
                  editingEvent
                    ? "Save calendar event changes"
                    : "Create calendar event"
                }
                agentGroup="calendar-compose"
                agentStatus={
                  busy ? "loading" : editingEvent ? "editing" : "ready"
                }
                variant="primary"
                disabled={busy || !title.trim() || !date || !time}
                onClick={() => void submit()}
              >
                {editingEvent ? (
                  <Check size={16} aria-hidden />
                ) : (
                  <Plus size={16} aria-hidden />
                )}
                {busy ? "Saving…" : editingEvent ? "Save changes" : "Add event"}
              </AgentAction>
              {error ? (
                <p
                  role="alert"
                  style={{
                    ...SECONDARY_TEXT_STYLE,
                    color: "var(--status-danger, #ff857a)",
                  }}
                >
                  {error}
                </p>
              ) : null}
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default SimpleCalendarView;
