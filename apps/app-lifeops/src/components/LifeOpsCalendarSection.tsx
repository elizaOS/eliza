/**
 * LifeOpsCalendarSection — calendar view with week/day/month toggle.
 *
 * Default: week grid (7 cols, hour rows). Toggle: Week / Day / Month.
 * Calendar events are rendered as colored blocks; clicking an event opens
 * EventEditorDrawer and calls select({ type: "event", eventId }).
 *
 * Data comes from useCalendarWeek which calls client.getLifeOpsCalendarFeed().
 */

import {
  Badge,
  Button,
  SegmentedControl,
  Spinner,
  useApp,
} from "@elizaos/app-core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/lifeops";
import { useMemo, useState } from "react";
import {
  type CalendarViewMode,
  useCalendarWeek,
} from "../hooks/useCalendarWeek.js";
import { EventEditorDrawer } from "./EventEditorDrawer.js";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function formatTimeOfDay(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(parsed));
}

function formatDayHeader(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

function toLocalDayKey(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const d = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${d}`;
}

function buildWeekDays(windowStart: Date, count: number): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(windowStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function groupEventsByDay(
  events: LifeOpsCalendarEvent[],
): Map<string, LifeOpsCalendarEvent[]> {
  const map = new Map<string, LifeOpsCalendarEvent[]>();
  for (const event of events) {
    const key = toLocalDayKey(new Date(event.startAt));
    const existing = map.get(key);
    if (existing) {
      existing.push(event);
    } else {
      map.set(key, [event]);
    }
  }
  return map;
}

// Rotate through a small palette of soft colors for event blocks.
const EVENT_COLORS = [
  "bg-blue-500/20 text-blue-300 border-blue-500/30",
  "bg-violet-500/20 text-violet-300 border-violet-500/30",
  "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  "bg-amber-500/20 text-amber-300 border-amber-500/30",
  "bg-rose-500/20 text-rose-300 border-rose-500/30",
];

function eventColorClass(index: number): string {
  return EVENT_COLORS[index % EVENT_COLORS.length] ?? EVENT_COLORS[0];
}

// ---------------------------------------------------------------------------
// Event block
// ---------------------------------------------------------------------------

function EventBlock({
  event,
  colorIndex,
  selected,
  onClick,
}: {
  event: LifeOpsCalendarEvent;
  colorIndex: number;
  selected: boolean;
  onClick: () => void;
}) {
  const colorClass = eventColorClass(colorIndex);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border px-2 py-1.5 text-left transition-opacity ${colorClass} ${
        selected ? "ring-1 ring-accent/60" : "hover:opacity-90"
      }`}
      aria-pressed={selected}
    >
      <div className="truncate text-xs font-medium">{event.title}</div>
      {!event.isAllDay ? (
        <div className="mt-0.5 text-[11px] opacity-80">
          {formatTimeOfDay(event.startAt)}
        </div>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Week grid
// ---------------------------------------------------------------------------

function WeekGrid({
  days,
  eventsByDay,
  selectedEventId,
  onSelectEvent,
}: {
  days: Date[];
  eventsByDay: Map<string, LifeOpsCalendarEvent[]>;
  selectedEventId: string | null;
  onSelectEvent: (event: LifeOpsCalendarEvent) => void;
}) {
  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
    >
      {days.map((day) => {
        const key = toLocalDayKey(day);
        const dayEvents = eventsByDay.get(key) ?? [];
        const isToday = key === toLocalDayKey(new Date());
        return (
          <div
            key={key}
            className="min-h-24 overflow-hidden rounded-2xl bg-bg/28 p-2"
          >
            <div
              className={`mb-2 text-[11px] font-medium ${
                isToday ? "text-accent" : "text-muted"
              }`}
            >
              {formatDayHeader(day)}
            </div>
            <div className="space-y-1">
              {dayEvents.map((event, i) => (
                <EventBlock
                  key={event.id}
                  event={event}
                  colorIndex={i}
                  selected={event.id === selectedEventId}
                  onClick={() => onSelectEvent(event)}
                />
              ))}
              {dayEvents.length === 0 ? (
                <div className="text-[11px] text-muted/50">—</div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

function DayView({
  day,
  events,
  selectedEventId,
  onSelectEvent,
}: {
  day: Date;
  events: LifeOpsCalendarEvent[];
  selectedEventId: string | null;
  onSelectEvent: (event: LifeOpsCalendarEvent) => void;
}) {
  const { t } = useApp();
  return (
    <div>
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        {formatDayHeader(day)}
      </div>
      {events.length === 0 ? (
        <div className="text-xs text-muted">
          {t("lifeopsCalendar.noEventsToday", {
            defaultValue: "Nothing scheduled.",
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event, i) => (
            <EventBlock
              key={event.id}
              event={event}
              colorIndex={i}
              selected={event.id === selectedEventId}
              onClick={() => onSelectEvent(event)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month list (simplified — full month grid is complex; render as a day list)
// ---------------------------------------------------------------------------

function MonthList({
  eventsByDay,
  windowStart,
  windowEnd,
  selectedEventId,
  onSelectEvent,
}: {
  eventsByDay: Map<string, LifeOpsCalendarEvent[]>;
  windowStart: Date;
  windowEnd: Date;
  selectedEventId: string | null;
  onSelectEvent: (event: LifeOpsCalendarEvent) => void;
}) {
  const { t } = useApp();
  const days = buildWeekDays(
    windowStart,
    Math.ceil((windowEnd.getTime() - windowStart.getTime()) / 86_400_000),
  );
  const daysWithEvents = days.filter((d) => {
    const key = toLocalDayKey(d);
    return (eventsByDay.get(key) ?? []).length > 0;
  });

  if (daysWithEvents.length === 0) {
    return (
      <div className="text-xs text-muted">
        {t("lifeopsCalendar.noEventsMonth", {
          defaultValue: "Nothing scheduled this month.",
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {daysWithEvents.map((day) => {
        const key = toLocalDayKey(day);
        const dayEvents = eventsByDay.get(key) ?? [];
        return (
          <div key={key}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {formatDayHeader(day)}
            </div>
            <div className="space-y-1">
              {dayEvents.map((event, i) => (
                <EventBlock
                  key={event.id}
                  event={event}
                  colorIndex={i}
                  selected={event.id === selectedEventId}
                  onClick={() => onSelectEvent(event)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface LifeOpsCalendarSectionProps {
  /** Optional override — defaults to reading from LifeOpsSelectionContext. */
  selection?: LifeOpsSelection;
  /** Optional override — defaults to writing to LifeOpsSelectionContext. */
  onSelect?: (args: Partial<LifeOpsSelection> | null) => void;
}

export function LifeOpsCalendarSection(
  props: LifeOpsCalendarSectionProps = {},
) {
  const ctx = useLifeOpsSelection();
  const selection = props.selection ?? ctx.selection;
  const onSelect = props.onSelect ?? ctx.select;
  const { t } = useApp();
  const calendar = useCalendarWeek();
  const [drawerEvent, setDrawerEvent] = useState<LifeOpsCalendarEvent | null>(
    null,
  );

  const selectedEventId = selection.eventId ?? null;

  const eventsByDay = useMemo(
    () => groupEventsByDay(calendar.events),
    [calendar.events],
  );

  const weekDays = useMemo(() => {
    switch (calendar.viewMode) {
      case "day":
        return buildWeekDays(calendar.windowStart, 1);
      case "month":
        return buildWeekDays(calendar.windowStart, 31);
      default:
        return buildWeekDays(calendar.windowStart, 7);
    }
  }, [calendar.viewMode, calendar.windowStart]);

  const handleSelectEvent = (event: LifeOpsCalendarEvent) => {
    onSelect({ eventId: event.id });
    setDrawerEvent(event);
  };

  const VIEW_ITEMS: Array<{ value: CalendarViewMode; label: string }> = [
    {
      value: "day",
      label: t("lifeopsCalendar.day", { defaultValue: "Day" }),
    },
    {
      value: "week",
      label: t("lifeopsCalendar.week", { defaultValue: "Week" }),
    },
    {
      value: "month",
      label: t("lifeopsCalendar.month", { defaultValue: "Month" }),
    },
  ];

  return (
    <>
      <section
        className="overflow-hidden rounded-3xl border border-border/16 bg-card/18"
        data-testid="lifeops-calendar-section"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold text-txt">
              {t("lifeopsCalendar.heading", { defaultValue: "Calendar" })}
            </div>
            {calendar.events.length > 0 ? (
              <Badge variant="outline" className="text-2xs">
                {calendar.events.length}
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-xl px-2.5 text-xs"
              onClick={() => void calendar.refresh()}
              disabled={calendar.loading}
            >
              {calendar.loading
                ? t("common.loading", { defaultValue: "Loading" })
                : t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <SegmentedControl<CalendarViewMode>
              aria-label={t("lifeopsCalendar.viewModeAria", {
                defaultValue: "Calendar view",
              })}
              value={calendar.viewMode}
              onValueChange={calendar.setViewMode}
              items={VIEW_ITEMS}
              className="border-border/28 bg-card/24 p-0.5"
              buttonClassName="min-h-7 px-3 py-1 text-xs"
            />
          </div>
        </div>

        <div className="border-t border-border/12 px-4 py-4">
          {calendar.error ? (
            <div className="rounded-2xl bg-danger/10 px-3 py-2 text-xs text-danger">
              {calendar.error}
            </div>
          ) : calendar.loading && calendar.events.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted">
              <Spinner size={14} />
              {t("lifeopsCalendar.loading", {
                defaultValue: "Loading events…",
              })}
            </div>
          ) : calendar.viewMode === "week" ? (
            <WeekGrid
              days={weekDays}
              eventsByDay={eventsByDay}
              selectedEventId={selectedEventId}
              onSelectEvent={handleSelectEvent}
            />
          ) : calendar.viewMode === "day" ? (
            <DayView
              day={weekDays[0] ?? calendar.windowStart}
              events={
                eventsByDay.get(
                  toLocalDayKey(weekDays[0] ?? calendar.windowStart),
                ) ?? []
              }
              selectedEventId={selectedEventId}
              onSelectEvent={handleSelectEvent}
            />
          ) : (
            <MonthList
              eventsByDay={eventsByDay}
              windowStart={calendar.windowStart}
              windowEnd={calendar.windowEnd}
              selectedEventId={selectedEventId}
              onSelectEvent={handleSelectEvent}
            />
          )}
        </div>
      </section>

      <EventEditorDrawer
        open={drawerEvent !== null}
        event={drawerEvent}
        onClose={() => {
          setDrawerEvent(null);
        }}
        onSaved={(updatedEvent) => {
          void calendar.refresh();
          setDrawerEvent(updatedEvent);
        }}
        onDeleted={() => {
          void calendar.refresh();
          setDrawerEvent(null);
          onSelect({ eventId: null });
        }}
      />
    </>
  );
}
