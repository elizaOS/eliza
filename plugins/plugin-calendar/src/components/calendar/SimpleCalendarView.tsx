/**
 * Chat-first Calendar projection over the canonical multi-provider feed. The
 * surface is intentionally read-only: the CALENDAR action owns mutations,
 * while this view refreshes after chat actions and renders the local month and
 * today's agenda without introducing a second calendar store.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { useViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import { Clock3 } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { useCalendarWeek } from "../../hooks/useCalendarWeek.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const ROOT_STYLE: CSSProperties = {
  boxSizing: "border-box",
  position: "relative",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
  color: "var(--txt, #f5f5f5)",
  fontFamily: "inherit",
};

const SCROLL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  position: "absolute",
  inset: 0,
  minWidth: 0,
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "clamp(8px, 2.4vw, 24px)",
  paddingTop: "calc(clamp(8px, 2.4vw, 24px) + var(--safe-area-top, 0px))",
  // Content remains visible through the translucent chat chrome, while the
  // clearance keeps the final agenda row reachable above it on every layout.
  paddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-clearance, 5.25rem))",
  paddingInlineEnd:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-side-clearance, 0px))",
  scrollPaddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-clearance, 5.25rem))",
};

const PANEL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  border: "none",
  borderRadius: 22,
  background:
    "color-mix(in srgb, var(--card, rgba(16,16,16,.88)) 76%, transparent)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,.10), 0 18px 48px rgba(0,0,0,.20)",
  backdropFilter: "blur(24px) saturate(145%)",
  WebkitBackdropFilter: "blur(24px) saturate(145%)",
};

const SECONDARY_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--muted, rgba(255,255,255,.58))",
  fontSize: 13,
  lineHeight: 1.45,
};

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day"): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (!value) throw new Error(`Calendar date is missing ${type}.`);
    return value;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseLocalDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) throw new Error("Calendar date is invalid.");
  return new Date(year, month - 1, day, 12);
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function calendarDays(cursor: Date): Date[] {
  const first = monthStart(cursor);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function formatMonth(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

function formatSelectedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(parseLocalDateKey(value));
}

function eventDateKey(event: LifeOpsCalendarEvent): string {
  return localDateKey(new Date(event.startAt));
}

function eventsOnDate(
  events: LifeOpsCalendarEvent[],
  date: string,
): LifeOpsCalendarEvent[] {
  return events
    .filter((event) => eventDateKey(event) === date)
    .toSorted((left, right) => left.startAt.localeCompare(right.startAt));
}

function formatTime(event: LifeOpsCalendarEvent): string {
  if (event.isAllDay) return "All day";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(event.startAt));
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
  events: LifeOpsCalendarEvent[];
}) {
  const key = localDateKey(day);
  const dayEvents = eventsOnDate(events, key);
  const selected = key === selectedDate;
  const currentMonth = day.getMonth() === cursor.getMonth();
  const today = key === localDateKey(new Date());
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
        {day.getDate()}
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
          style={{
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
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
              borderRadius: 999,
              background: "#35df8d",
            }}
          />
          <span aria-hidden>{dayEvents.length}</span>
        </span>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: LifeOpsCalendarEvent }) {
  const row = useAgentElement<HTMLElement>({
    id: `calendar-event-${event.id}`,
    label: `Calendar event ${event.title}`,
    role: "card",
    group: "calendar-agenda",
    description: `${formatTime(event)}. ${event.description}`,
    status: event.status,
  });

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
      <span aria-hidden style={{ borderRadius: 999, background: "#35df8d" }} />
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
            {event.title.trim() || "Untitled event"}
          </strong>
          <span style={{ ...SECONDARY_STYLE, flex: "0 0 auto", fontSize: 11 }}>
            {formatTime(event)}
          </span>
        </div>
        {event.description.trim() ? (
          <p
            style={{
              ...SECONDARY_STYLE,
              marginTop: 3,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {event.description.trim()}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function StatusCard({ message }: { message: string }) {
  return (
    <div role="alert" style={{ ...PANEL_STYLE, padding: 18 }}>
      <strong style={{ display: "block", fontSize: 14 }}>{message}</strong>
    </div>
  );
}

export function SimpleCalendarView() {
  const calendar = useCalendarWeek({ viewMode: "month" });
  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, () => {
    void calendar.refresh();
  }, [calendar.refresh]);

  const selectedDate = localDateKey(calendar.baseDate);
  const cursor = useMemo(
    () => monthStart(calendar.baseDate),
    [calendar.baseDate],
  );
  const days = useMemo(() => calendarDays(cursor), [cursor]);
  const selectedEvents = useMemo(
    () => eventsOnDate(calendar.events, selectedDate),
    [calendar.events, selectedDate],
  );
  const loaded = calendar.feedState !== null;
  const detail = calendar.error
    ? loaded
      ? `${calendar.events.length} events · refresh unavailable`
      : "Calendar unavailable"
    : calendar.loading && !loaded
      ? "Loading calendar…"
      : `${calendar.events.length} ${calendar.events.length === 1 ? "event" : "events"}`;

  return (
    <main
      aria-busy={calendar.loading}
      aria-label={`Calendar. ${detail}`}
      data-testid="simple-calendar-view"
      style={ROOT_STYLE}
    >
      <div
        data-testid="simple-calendar-scroll-region"
        style={{
          ...SCROLL_STYLE,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 14,
          alignItems: "start",
        }}
      >
        {calendar.error ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <StatusCard message={calendar.error} />
          </div>
        ) : calendar.status === "unavailable" ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <StatusCard message="Calendar sources are unavailable." />
          </div>
        ) : null}

        {!loaded && calendar.loading ? (
          <div role="status" style={{ ...PANEL_STYLE, padding: 24 }}>
            Loading…
          </div>
        ) : (
          <>
            <section
              aria-label="Calendar month"
              style={{
                ...PANEL_STYLE,
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
                    key={localDateKey(day)}
                    day={day}
                    cursor={cursor}
                    selectedDate={selectedDate}
                    events={calendar.events}
                  />
                ))}
              </div>
            </section>

            <section
              aria-label={`Events for ${selectedDate}`}
              style={{ ...PANEL_STYLE, padding: 16 }}
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
                  <p style={{ ...SECONDARY_STYLE, marginTop: 3, fontSize: 11 }}>
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
                <p style={SECONDARY_STYLE}>
                  Ask Eliza in chat to schedule something for today.
                </p>
              ) : (
                selectedEvents.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

export default SimpleCalendarView;
