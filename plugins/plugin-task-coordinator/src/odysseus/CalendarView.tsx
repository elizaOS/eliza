// odysseus calendar (static/js/calendar.js + calendar/utils.js). A local-first
// month-grid calendar: prev/today/next toolbar with a week/month/year/agenda
// view toggle, a per-calendar filter chip row, a 6-week month grid with
// today / other-month / selected day states and inline event chips, a
// day-detail panel, and a sidebar listing the local calendars with their
// colours.
//
// elizaMapping: odysseus's calendar is CalDAV-backed (client.getEvents over an
// HTTP API). eliza exposes the LifeOps calendar *types*
// (LifeOpsCalendarEvent / LifeOpsCalendarFeed in @elizaos/ui's
// client-types-config) but NO frontend-callable client method to fetch a feed —
// the LifeOps calendar is a provider/context surface, not a UI client method.
// So this is the faithful no-eliza-equivalent path: the month grid renders
// against a typed, empty event set with a representative set of local
// calendars (odysseus's CAL_PALETTE), persisted locally. No data is fabricated
// as if it came from the agent. An eliza-backed calendar client method is the
// follow-up.

import { ChevronLeft, ChevronRight, Settings as Cog, Plus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { readPref } from "./util/storage";

// Local-prefs key for the persisted calendar list. Not in the shared PREF_KEYS
// enum (that file is owned by the shell) — namespaced the same way via readPref.
const CAL_PREF_KEY = "calendars";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// odysseus calendar/utils.js CAL_PALETTE — first slot is the theme accent so a
// single local calendar inherits the active odysseus theme.
const CAL_PALETTE = [
  "var(--accent)",
  "#5b8abf",
  "#bf6b5b",
  "#5bbf7a",
  "#bf9a5b",
  "#9a5bbf",
  "#5bbfb8",
  "#bf8a5b",
  "#7070c0",
  "#bf5b8a",
] as const;

type CalendarView = "week" | "month" | "year" | "agenda";

interface LocalCalendar {
  href: string;
  name: string;
  color: string;
}

interface CalEvent {
  uid: string;
  summary: string;
  calendarHref: string;
  // `YYYY-MM-DD` local date the event falls on.
  date: string;
  // Empty for all-day events; otherwise a pre-formatted clock label.
  time: string;
  allDay: boolean;
}

// Representative local calendars — the zero-state odysseus ships before any
// CalDAV sync or .ics import. Coloured from CAL_PALETTE, not real agent data.
const DEFAULT_CALENDARS: LocalCalendar[] = [
  { href: "local/personal", name: "Personal", color: CAL_PALETTE[0] },
  { href: "local/work", name: "Work", color: CAL_PALETTE[1] },
];

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function calColor(ev: CalEvent, calendars: LocalCalendar[]): string {
  const c = calendars.find((cal) => cal.href === ev.calendarHref);
  return c ? c.color : "var(--accent)";
}

export function CalendarView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const [view, setView] = useState<CalendarView>("month");
  const [current, setCurrent] = useState<Date>(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string>(() => ymd(new Date()));
  const [hiddenCals, setHiddenCals] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const calendars = useMemo(
    () => readPref<LocalCalendar[]>(CAL_PREF_KEY, DEFAULT_CALENDARS),
    [],
  );

  // No eliza client method backs a calendar feed (see file header) — the event
  // set is intentionally empty until a calendar backend exists.
  const events = useMemo<CalEvent[]>(() => [], []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const today = ymd(new Date());
  const year = current.getFullYear();
  const month = current.getMonth();

  const eventVisible = (e: CalEvent): boolean =>
    !hiddenCals.has(e.calendarHref);
  const visibleEvents = events.filter(eventVisible);

  const eventsForDay = (date: string): CalEvent[] =>
    visibleEvents.filter((e) => e.date === date);

  const toggleCal = (href: string) => {
    setHiddenCals((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });
  };

  const shiftMonth = (delta: number) =>
    setCurrent(new Date(year, month + delta, 1));
  const goToday = () => {
    const now = new Date();
    setCurrent(now);
    setSelectedDay(ymd(now));
  };

  // Grid start: Monday on/before the 1st of the month.
  const first = new Date(year, month, 1);
  const dow = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - dow);

  const weekRows: { date: string; cellDate: Date; isOther: boolean }[][] = [];
  for (let row = 0; row < 6; row++) {
    const cols: { date: string; cellDate: Date; isOther: boolean }[] = [];
    for (let col = 0; col < 7; col++) {
      const i = row * 7 + col;
      const cd = new Date(gridStart);
      cd.setDate(gridStart.getDate() + i);
      cols.push({
        date: ymd(cd),
        cellDate: cd,
        isOther: cd.getMonth() !== month,
      });
    }
    weekRows.push(cols);
  }

  const showFilters = calendars.length > 1;
  const detailEvents = eventsForDay(selectedDay);

  return (
    <div
      className="od-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Calendar"
    >
      <button
        type="button"
        aria-label="Close calendar"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-cal-panel">
        <div className="od-cal-body">
          <div className="od-cal-toolbar">
            <div className="od-cal-toolbar-nav">
              <button
                type="button"
                className="od-cal-nav"
                onClick={() => shiftMonth(-1)}
                aria-label="Previous month"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                className="od-cal-nav od-cal-today-btn"
                onClick={goToday}
              >
                Today
              </button>
              <span className="od-cal-title">
                {MONTHS[month]} {year}
              </span>
              <button
                type="button"
                className="od-cal-nav"
                onClick={() => shiftMonth(1)}
                aria-label="Next month"
              >
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="od-cal-toolbar-right">
              <div className="od-cal-view-toggle">
                {(["week", "month", "year", "agenda"] as const).map((v) => (
                  <button
                    type="button"
                    key={v}
                    className={`od-cal-view-btn${view === v ? " active" : ""}`}
                    onClick={() => setView(v)}
                  >
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="od-cal-nav"
                title="Calendar settings"
                aria-label="Calendar settings"
              >
                <Cog size={13} />
              </button>
              <button
                type="button"
                className="od-cal-add-btn od-cal-add-btn-text"
                title="New event"
                aria-label="New event"
              >
                <span className="od-cal-add-plus">
                  <Plus size={13} />
                </span>
                <span className="od-cal-add-label">New</span>
              </button>
            </div>
          </div>

          {showFilters ? (
            <div className="od-cal-filters">
              {calendars.map((c) => {
                const off = hiddenCals.has(c.href);
                return (
                  <button
                    type="button"
                    key={c.href}
                    className={`od-cal-filter-item${off ? " od-cal-filter-off" : ""}`}
                    onClick={() => toggleCal(c.href)}
                  >
                    <span
                      className="od-cal-filter-dot"
                      style={{ background: c.color }}
                    />
                    {c.name}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="od-cal-grid">
            <div className="od-cal-week-headers">
              {WEEKDAYS.map((wd) => (
                <div className="od-cal-weekday" key={wd}>
                  {wd}
                </div>
              ))}
            </div>
            {weekRows.map((cols) => (
              <div className="od-cal-week-row" key={cols[0].date}>
                {cols.map((cell) => {
                  const singles = eventsForDay(cell.date);
                  const maxInline = 3;
                  const showInline = singles.slice(0, maxInline);
                  const cls = [
                    "od-cal-day",
                    cell.isOther ? "od-cal-other" : "",
                    cell.date === today ? "od-cal-today" : "",
                    cell.date === selectedDay ? "od-cal-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      type="button"
                      className={cls}
                      key={cell.date}
                      onClick={() => setSelectedDay(cell.date)}
                    >
                      <span className="od-cal-day-num">
                        {cell.cellDate.getDate()}
                      </span>
                      {showInline.map((ev) => (
                        <span className="od-cal-event-row" key={ev.uid}>
                          <span
                            className="od-cal-event-row-dot"
                            style={{ background: calColor(ev, calendars) }}
                          />
                          {ev.time ? (
                            <span className="od-cal-event-row-time">
                              {ev.time}
                            </span>
                          ) : null}
                          <span className="od-cal-event-row-name">
                            {ev.summary}
                          </span>
                        </span>
                      ))}
                      {singles.length > maxInline ? (
                        <span className="od-cal-event-more">
                          +{singles.length - maxInline} more
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="od-cal-day-detail">
            <div className="od-cal-detail-header">
              <span>{selectedDay}</span>
            </div>
            {detailEvents.length === 0 ? (
              <div className="od-cal-empty">No events</div>
            ) : (
              detailEvents.map((ev) => (
                <div className="od-cal-event-item" key={ev.uid}>
                  <span
                    className="od-cal-event-dot"
                    style={{ background: calColor(ev, calendars) }}
                  />
                  <div className="od-cal-event-info">
                    <div className="od-cal-event-name">{ev.summary}</div>
                    <div className="od-cal-event-time">
                      {ev.allDay ? "All day" : ev.time}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="od-cal-sidebar">
          <div className="od-cal-sidebar-head">Calendars</div>
          {calendars.map((c) => {
            const off = hiddenCals.has(c.href);
            return (
              <button
                type="button"
                key={c.href}
                className={`od-cal-s-row${off ? " od-cal-s-off" : ""}`}
                onClick={() => toggleCal(c.href)}
              >
                <span
                  className="od-cal-s-dot"
                  style={{ background: c.color }}
                />
                <span className="od-cal-s-name">{c.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
