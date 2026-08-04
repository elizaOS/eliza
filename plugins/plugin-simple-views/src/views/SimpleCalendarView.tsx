/**
 * Read-only Calendar surface backed by the authoritative Simple Views snapshot.
 * The viewed date comes only from its explicit planner-visible selection
 * capability; event mutations never move the calendar behind the user's back.
 * Chat remains the only interactive control plane.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Clock3 } from "lucide-react";
import { useMemo } from "react";
import { todayDateKey } from "../date-key.js";
import type { SimpleCalendarEvent } from "../types.js";
import { useSimpleViewsState } from "./useSimpleViewsState.js";
import {
  COLOR_MATERIALS,
  GLASS_PANEL_STYLE,
  SECONDARY_TEXT_STYLE,
  VIEW_ROOT_STYLE,
  VIEW_SCROLL_STYLE,
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
}: {
  day: Date;
  cursor: Date;
  selectedDate: string;
  events: SimpleCalendarEvent[];
}) {
  const key = dateKey(day);
  const dayEvents = eventsOnDate(events, key);
  const selected = key === selectedDate;
  const currentMonth = day.getUTCMonth() === cursor.getUTCMonth();
  const today = key === todayDateKey();
  const cell = useAgentElement<HTMLDivElement>({
    id: `calendar-day-${key}`,
    label: formatSelectedDate(key),
    role: "card",
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
  });

  return (
    <div
      ref={cell.ref}
      {...cell.agentProps}
      aria-current={today ? "date" : undefined}
      style={{
        boxSizing: "border-box",
        minWidth: 0,
        minHeight: "clamp(38px, 7vw, 62px)",
        borderRadius: 11,
        padding: "6px clamp(4px, .8vw, 8px)",
        background: selected
          ? "color-mix(in srgb, var(--surface, rgba(255,255,255,.08)) 88%, transparent)"
          : currentMonth
            ? "color-mix(in srgb, var(--surface, rgba(255,255,255,.06)) 78%, transparent)"
            : "transparent",
        color: currentMonth
          ? "var(--txt, #f5f5f5)"
          : "var(--muted, rgba(255,255,255,.5))",
        boxShadow: selected ? "inset 0 0 0 1px rgba(255,255,255,.78)" : "none",
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 5,
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
        <span
          role="img"
          aria-label={`${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"} on ${formatSelectedDate(key)}`}
          title={`${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`}
          style={{
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            minWidth: 0,
            color: "var(--muted-strong, rgba(255,255,255,.76))",
            fontSize: 9,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flex: "0 0 auto",
              borderRadius: 999,
              background: COLOR_MATERIALS[dayEvents[0].color].dot,
            }}
          />
          <span aria-hidden>{dayEvents.length}</span>
        </span>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: SimpleCalendarEvent }) {
  const row = useAgentElement<HTMLElement>({
    id: `calendar-event-${event.id}`,
    label: `Calendar event ${event.title}`,
    role: "card",
    group: "calendar-agenda",
    description: `${event.date} at ${event.time}. ${event.notes}`,
    status: event.color,
  });
  const material = COLOR_MATERIALS[event.color];

  return (
    <article
      ref={row.ref}
      {...row.agentProps}
      style={{
        display: "grid",
        gridTemplateColumns: "4px minmax(0, 1fr)",
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
    </article>
  );
}

export function SimpleCalendarView() {
  const { snapshot, loading, error } = useSimpleViewsState();
  const events = snapshot?.events ?? [];
  const selectedDate = snapshot?.selectedDate ?? todayDateKey();
  const cursor = monthStart(parseDateKey(selectedDate));
  const selectedEvents = useMemo(
    () => eventsOnDate(events, selectedDate),
    [events, selectedDate],
  );
  const days = useMemo(() => calendarDays(cursor), [cursor]);
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

  return (
    <main
      aria-busy={loading}
      aria-label={`Calendar. ${headerDetail}`}
      data-testid="simple-calendar-view"
      style={VIEW_ROOT_STYLE}
    >
      {snapshot ? (
        <div
          data-testid="simple-calendar-scroll-region"
          style={{
            ...VIEW_SCROLL_STYLE,
            display: "grid",
            // A fixed track minimum avoids circular percentage sizing when the
            // landscape chat rail reduces the routed surface's inline space.
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 14,
            alignItems: "start",
          }}
        >
          {error ? (
            <div
              role="alert"
              style={{
                ...GLASS_PANEL_STYLE,
                gridColumn: "1 / -1",
                padding: 14,
                color: "var(--status-danger, #ff857a)",
              }}
            >
              {error}
            </div>
          ) : null}
          <section
            aria-label="Calendar month"
            style={{
              ...GLASS_PANEL_STYLE,
              padding: "14px clamp(4px, 1.6vw, 16px)",
            }}
          >
            <h2
              style={{
                margin: "0 0 13px",
                fontSize: 16,
                lineHeight: 1.3,
                fontWeight: 740,
              }}
            >
              {formatMonth(cursor)}
            </h2>
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
                />
              ))}
            </div>
          </section>

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
              <Clock3 size={16} aria-hidden style={{ color: "var(--muted)" }} />
            </div>
            {selectedEvents.length === 0 ? (
              <p style={{ ...SECONDARY_TEXT_STYLE, margin: 0 }}>
                Ask Eliza in chat to schedule something on this date.
              </p>
            ) : (
              selectedEvents.map((event) => (
                <EventRow key={event.id} event={event} />
              ))
            )}
          </section>
        </div>
      ) : (
        <div
          data-testid="simple-calendar-scroll-region"
          style={VIEW_SCROLL_STYLE}
        >
          <ViewState
            loading={loading}
            error={error}
            empty={false}
            emptyTitle=""
            emptyBody=""
          />
        </div>
      )}
    </main>
  );
}

export default SimpleCalendarView;
