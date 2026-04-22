/**
 * LifeOpsCalendarSection — Google Calendar-style week/day/month views.
 *
 * Day/week views render an hour-by-hour grid and position events by their
 * actual start/end time. Month view renders a 5-6 row day grid. Events get
 * deterministic category colours derived from their calendar/account id so
 * the same feed keeps the same colour across renders.
 */

import { Button, SegmentedControl, Spinner, useApp } from "@elizaos/app-core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/lifeops";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  type CalendarViewMode,
  useCalendarWeek,
} from "../hooks/useCalendarWeek.js";
import { EventEditorDrawer } from "./EventEditorDrawer.js";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 23;
const HOUR_HEIGHT_PX = 48;

function formatTimeOfDay(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(parsed));
}

function formatWeekdayShort(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    timeZone: TIME_ZONE,
  }).format(date);
}

function formatDayNumber(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

function formatMonthHeader(start: Date, end: Date): string {
  const startMonth = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(start);
  const endMonth = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(end);
  return startMonth === endMonth ? startMonth : `${startMonth} – ${endMonth}`;
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

function buildDays(start: Date, count: number): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
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
    if (existing) existing.push(event);
    else map.set(key, [event]);
  }
  return map;
}

// Google-Calendar-inspired palette. Each entry is a self-contained class
// pair so we can render filled blocks or tinted pills from the same source.
const EVENT_PALETTE = [
  {
    bg: "bg-blue-500/85",
    softBg: "bg-blue-500/18",
    border: "border-blue-500/60",
    text: "text-blue-50",
    softText: "text-blue-200",
    dot: "bg-blue-400",
  },
  {
    bg: "bg-violet-500/85",
    softBg: "bg-violet-500/18",
    border: "border-violet-500/60",
    text: "text-violet-50",
    softText: "text-violet-200",
    dot: "bg-violet-400",
  },
  {
    bg: "bg-emerald-500/85",
    softBg: "bg-emerald-500/18",
    border: "border-emerald-500/60",
    text: "text-emerald-50",
    softText: "text-emerald-200",
    dot: "bg-emerald-400",
  },
  {
    bg: "bg-amber-500/85",
    softBg: "bg-amber-500/18",
    border: "border-amber-500/60",
    text: "text-amber-50",
    softText: "text-amber-200",
    dot: "bg-amber-400",
  },
  {
    bg: "bg-rose-500/85",
    softBg: "bg-rose-500/18",
    border: "border-rose-500/60",
    text: "text-rose-50",
    softText: "text-rose-200",
    dot: "bg-rose-400",
  },
  {
    bg: "bg-cyan-500/85",
    softBg: "bg-cyan-500/18",
    border: "border-cyan-500/60",
    text: "text-cyan-50",
    softText: "text-cyan-200",
    dot: "bg-cyan-400",
  },
] as const;

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function paletteFor(event: LifeOpsCalendarEvent) {
  const seed = event.accountEmail || event.calendarId || event.id;
  return EVENT_PALETTE[hashString(seed) % EVENT_PALETTE.length];
}

interface EventPosition {
  topPct: number;
  heightPct: number;
}

function positionEventInDay(event: LifeOpsCalendarEvent): EventPosition | null {
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  const dayStart = new Date(start);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  const dayEnd = new Date(start);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
  const totalMs = dayEnd.getTime() - dayStart.getTime();
  const clampedStart = Math.max(start.getTime(), dayStart.getTime());
  const clampedEnd = Math.min(end.getTime(), dayEnd.getTime());
  if (clampedEnd <= clampedStart) return null;
  const topPct = ((clampedStart - dayStart.getTime()) / totalMs) * 100;
  const heightPct = ((clampedEnd - clampedStart) / totalMs) * 100;
  return {
    topPct,
    heightPct: Math.max(heightPct, 2.5),
  };
}

function isSameDayKey(a: Date, b: Date): boolean {
  return toLocalDayKey(a) === toLocalDayKey(b);
}

// ---------------------------------------------------------------------------
// Hour-grid day/week view
// ---------------------------------------------------------------------------

const RAIL_WIDTH_REM = 3.25;
const HEADER_ROW_HEIGHT_REM = 2.25;

function DayColumnHeader({ day, isFirst }: { day: Date; isFirst: boolean }) {
  const isToday = isSameDayKey(day, new Date());
  return (
    <div
      className={`flex items-center justify-center gap-1.5 ${isFirst ? "" : "border-l border-border/12"} px-2 text-[11px] font-medium ${
        isToday ? "bg-accent/8" : ""
      }`}
      style={{ height: `${HEADER_ROW_HEIGHT_REM}rem` }}
    >
      <span
        className={`uppercase tracking-wide ${isToday ? "text-accent" : "text-muted"}`}
      >
        {formatWeekdayShort(day)}
      </span>
      <span
        className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 tabular-nums ${
          isToday ? "bg-accent text-accent-fg" : "text-txt"
        }`}
      >
        {formatDayNumber(day)}
      </span>
    </div>
  );
}

function AllDayBandCell({
  day,
  events,
  isFirst,
  selectedEventId,
  onSelectEvent,
}: {
  day: Date;
  events: LifeOpsCalendarEvent[];
  isFirst: boolean;
  selectedEventId: string | null;
  onSelectEvent: (event: LifeOpsCalendarEvent) => void;
}) {
  return (
    <div
      className={`space-y-0.5 px-1 py-1 ${isFirst ? "" : "border-l border-border/12"}`}
      aria-label={`All-day events for ${day.toISOString()}`}
    >
      {events.map((event) => {
        const color = paletteFor(event);
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelectEvent(event)}
            className={`block w-full truncate rounded-md ${color.softBg} ${color.softText} px-1.5 py-0.5 text-left text-[10px] font-medium hover:${color.bg} hover:${color.text}`}
            aria-pressed={event.id === selectedEventId}
          >
            {event.title}
          </button>
        );
      })}
    </div>
  );
}

function DayColumnGrid({
  day,
  events,
  nowInColumn,
  selectedEventId,
  onSelectEvent,
  isFirst,
  gridHeight,
}: {
  day: Date;
  events: LifeOpsCalendarEvent[];
  nowInColumn: boolean;
  selectedEventId: string | null;
  onSelectEvent: (event: LifeOpsCalendarEvent) => void;
  isFirst: boolean;
  gridHeight: number;
}) {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const isToday = isSameDayKey(day, new Date());

  const nowTopPx = useMemo(() => {
    if (!nowInColumn) return null;
    const now = new Date();
    const startOfWindow = new Date(now);
    startOfWindow.setHours(DAY_START_HOUR, 0, 0, 0);
    const endOfWindow = new Date(now);
    endOfWindow.setHours(DAY_END_HOUR, 0, 0, 0);
    if (
      now.getTime() < startOfWindow.getTime() ||
      now.getTime() > endOfWindow.getTime()
    ) {
      return null;
    }
    const ratio =
      (now.getTime() - startOfWindow.getTime()) /
      (endOfWindow.getTime() - startOfWindow.getTime());
    return ratio * gridHeight;
  }, [gridHeight, nowInColumn]);

  return (
    <div
      className={`relative ${isFirst ? "" : "border-l border-border/12"} ${isToday ? "bg-accent/5" : ""}`}
      style={{ height: `${gridHeight}px` }}
    >
      {/* hour lines */}
      {Array.from({ length: totalHours }, (_, i) => (
        <div
          key={i}
          className="pointer-events-none absolute inset-x-0 border-t border-border/6"
          style={{ top: `${i * HOUR_HEIGHT_PX}px` }}
        />
      ))}

      {/* now indicator */}
      {nowTopPx !== null ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-20"
          style={{ top: `${nowTopPx}px` }}
          aria-hidden
        >
          <div className="flex items-center">
            <span className="h-2 w-2 rounded-full bg-rose-500 ring-2 ring-rose-500/30" />
            <span className="h-px flex-1 bg-rose-500/80" />
          </div>
        </div>
      ) : null}

      {/* events */}
      {events.map((event) => {
        const position = positionEventInDay(event);
        if (!position) return null;
        const color = paletteFor(event);
        const isSelected = event.id === selectedEventId;
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelectEvent(event)}
            aria-pressed={isSelected}
            className={`group absolute inset-x-1 overflow-hidden rounded-md border px-1.5 py-1 text-left shadow-sm transition-transform ${color.bg} ${color.border} ${color.text} ${isSelected ? "ring-2 ring-white/50" : "hover:translate-y-[-1px]"}`}
            style={{
              top: `calc(${position.topPct}% + 0.1rem)`,
              height: `calc(${position.heightPct}% - 0.2rem)`,
              minHeight: "1.5rem",
            }}
          >
            <div className="truncate text-[11px] font-semibold leading-tight">
              {event.title}
            </div>
            <div className="mt-0.5 truncate text-[10px] leading-tight opacity-90">
              {formatTimeOfDay(event.startAt)}
              {event.location ? ` · ${event.location}` : ""}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TimeGrid({
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
  const now = new Date();
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const gridHeight = totalHours * HOUR_HEIGHT_PX;

  const hasAnyAllDay = useMemo(
    () =>
      days.some((day) =>
        (eventsByDay.get(toLocalDayKey(day)) ?? []).some((e) => e.isAllDay),
      ),
    [days, eventsByDay],
  );

  const hourLabels = useMemo(() => {
    const out: string[] = [];
    for (let hour = DAY_START_HOUR; hour < DAY_END_HOUR; hour++) {
      out.push(
        new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(
          new Date(2024, 0, 1, hour, 0),
        ),
      );
    }
    return out;
  }, []);

  // Grid layout: first column is the hour rail. Each day is an equal-width
  // column after it. Rows stay aligned because every day header cell + every
  // all-day cell share a row whose height is driven by the tallest cell.
  const gridTemplateColumns = `${RAIL_WIDTH_REM}rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="overflow-hidden rounded-2xl border border-border/12 bg-bg/20">
      {/* Header row: empty cell above rail, then weekday + date per column */}
      <div
        className="grid border-b border-border/12"
        style={{ gridTemplateColumns }}
      >
        <div
          aria-hidden
          style={{ height: `${HEADER_ROW_HEIGHT_REM}rem` }}
        />
        {days.map((day, index) => (
          <DayColumnHeader
            key={toLocalDayKey(day)}
            day={day}
            isFirst={index === 0}
          />
        ))}
      </div>

      {/* All-day band: stays aligned row-wise with the header */}
      {hasAnyAllDay ? (
        <div
          className="grid border-b border-border/12 bg-bg-muted/15"
          style={{ gridTemplateColumns }}
        >
          <div
            aria-hidden
            className="flex items-center justify-end px-2 text-[10px] font-semibold uppercase tracking-wide text-muted/70"
          >
            all-day
          </div>
          {days.map((day, index) => (
            <AllDayBandCell
              key={toLocalDayKey(day)}
              day={day}
              isFirst={index === 0}
              events={(eventsByDay.get(toLocalDayKey(day)) ?? []).filter(
                (e) => e.isAllDay,
              )}
              selectedEventId={selectedEventId}
              onSelectEvent={onSelectEvent}
            />
          ))}
        </div>
      ) : null}

      {/* Hour rail + day columns — all share one row so lines align */}
      <div className="grid" style={{ gridTemplateColumns }}>
        <div className="relative" style={{ height: `${gridHeight}px` }}>
          {hourLabels.map((label, index) => (
            <div
              key={label + index}
              className="absolute right-2 text-[10px] font-medium uppercase tracking-wide text-muted/70"
              style={{
                top: `${index * HOUR_HEIGHT_PX - 6}px`,
              }}
            >
              {label}
            </div>
          ))}
        </div>
        {days.map((day, index) => {
          const key = toLocalDayKey(day);
          const dayEvents = (eventsByDay.get(key) ?? []).filter(
            (e) => !e.isAllDay,
          );
          return (
            <DayColumnGrid
              key={key}
              day={day}
              events={dayEvents}
              nowInColumn={isSameDayKey(day, now)}
              selectedEventId={selectedEventId}
              onSelectEvent={onSelectEvent}
              isFirst={index === 0}
              gridHeight={gridHeight}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------

function startOfMonthGrid(date: Date): Date {
  const firstOfMonth = new Date(date);
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);
  const weekday = firstOfMonth.getDay();
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - weekday);
  return start;
}

function MonthGrid({
  baseDate,
  eventsByDay,
  selectedEventId,
  onSelectEvent,
}: {
  baseDate: Date;
  eventsByDay: Map<string, LifeOpsCalendarEvent[]>;
  selectedEventId: string | null;
  onSelectEvent: (event: LifeOpsCalendarEvent) => void;
}) {
  const start = startOfMonthGrid(baseDate);
  const days = buildDays(start, 42);
  const month = baseDate.getMonth();
  const today = new Date();
  const weekdayLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        return formatWeekdayShort(d);
      }),
    [start],
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border/12 bg-bg/20">
      <div className="grid grid-cols-7 border-b border-border/12 bg-bg-muted/20 text-[10px] font-semibold uppercase tracking-wide text-muted">
        {weekdayLabels.map((label, index) => (
          <div key={label + index} className="px-2 py-1.5 text-center">
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-border/8">
        {days.map((day) => {
          const key = toLocalDayKey(day);
          const dayEvents = eventsByDay.get(key) ?? [];
          const inMonth = day.getMonth() === month;
          const isToday = isSameDayKey(day, today);
          return (
            <div
              key={key}
              className={`flex min-h-24 flex-col gap-1 bg-bg/40 p-1.5 text-left ${
                inMonth ? "" : "opacity-55"
              }`}
            >
              <div
                className={`text-[11px] font-medium ${
                  isToday
                    ? "inline-flex h-5 w-5 items-center justify-center self-start rounded-full bg-accent text-accent-fg"
                    : inMonth
                      ? "text-txt"
                      : "text-muted"
                }`}
              >
                {formatDayNumber(day)}
              </div>
              <div className="flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map((event) => {
                  const color = paletteFor(event);
                  const isSelected = event.id === selectedEventId;
                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => onSelectEvent(event)}
                      className={`flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-left text-[10px] font-medium ${
                        isSelected
                          ? `${color.bg} ${color.text}`
                          : `${color.softBg} ${color.softText} hover:${color.bg} hover:${color.text}`
                      }`}
                    >
                      {!event.isAllDay ? (
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${color.dot}`}
                          aria-hidden
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">
                        {event.title}
                      </span>
                    </button>
                  );
                })}
                {dayEvents.length > 3 ? (
                  <span className="px-1 text-[10px] font-medium text-muted">
                    +{dayEvents.length - 3} more
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export interface LifeOpsCalendarSectionProps {
  selection?: LifeOpsSelection;
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

  const days = useMemo(() => {
    switch (calendar.viewMode) {
      case "day":
        return buildDays(calendar.windowStart, 1);
      case "month":
        return buildDays(calendar.windowStart, 42);
      default:
        return buildDays(calendar.windowStart, 7);
    }
  }, [calendar.viewMode, calendar.windowStart]);

  const handleSelectEvent = useCallback(
    (event: LifeOpsCalendarEvent) => {
      onSelect({ eventId: event.id });
      setDrawerEvent(event);
    },
    [onSelect],
  );

  const rangeLabel = useMemo(
    () => formatMonthHeader(calendar.windowStart, calendar.windowEnd),
    [calendar.windowStart, calendar.windowEnd],
  );

  const VIEW_ITEMS: Array<{ value: CalendarViewMode; label: string }> = [
    { value: "day", label: t("lifeopsCalendar.day", { defaultValue: "Day" }) },
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
        className="flex h-full min-h-0 flex-col gap-4"
        data-testid="lifeops-calendar-section"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-border/16 bg-card/22">
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center text-muted hover:bg-bg-muted/40 hover:text-txt"
                aria-label={t("lifeopsCalendar.previous", {
                  defaultValue: "Previous",
                })}
                onClick={calendar.goPrevious}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className="h-8 px-2.5 text-xs font-medium text-txt hover:bg-bg-muted/40"
                onClick={calendar.goToToday}
              >
                {t("lifeopsCalendar.today", { defaultValue: "Today" })}
              </button>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center text-muted hover:bg-bg-muted/40 hover:text-txt"
                aria-label={t("lifeopsCalendar.next", {
                  defaultValue: "Next",
                })}
                onClick={calendar.goNext}
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <h2 className="text-base font-semibold tracking-tight text-txt">
              {rangeLabel}
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <SegmentedControl<CalendarViewMode>
              aria-label={t("lifeopsCalendar.viewModeAria", {
                defaultValue: "Calendar view",
              })}
              value={calendar.viewMode}
              onValueChange={calendar.setViewMode}
              items={VIEW_ITEMS}
              className="border-border/24 bg-card/24 p-0.5"
              buttonClassName="min-h-7 px-3 py-1 text-xs"
            />
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-xl px-3 text-xs font-semibold"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("lifeopsCalendar.newEvent", { defaultValue: "New" })}
            </Button>
          </div>
        </div>

        {calendar.error ? (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {calendar.error}
          </div>
        ) : null}

        {calendar.loading && calendar.events.length === 0 ? (
          <div className="flex items-center gap-2 py-12 text-xs text-muted">
            <Spinner size={14} />
            {t("lifeopsCalendar.loading", { defaultValue: "Loading events…" })}
          </div>
        ) : calendar.viewMode === "month" ? (
          <MonthGrid
            baseDate={calendar.windowStart}
            eventsByDay={eventsByDay}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        ) : (
          <TimeGrid
            days={days}
            eventsByDay={eventsByDay}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        )}
      </section>

      <EventEditorDrawer
        open={drawerEvent !== null}
        event={drawerEvent}
        onClose={() => setDrawerEvent(null)}
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
