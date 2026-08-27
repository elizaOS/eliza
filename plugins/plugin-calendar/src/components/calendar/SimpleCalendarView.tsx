/**
 * Interactive Calendar projection over the canonical multi-provider feed.
 * Month/day navigation stays client-side, while event mutations remain on the
 * CALENDAR action and owner-approval path so the view never introduces a
 * second calendar store or write boundary.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  Button,
  Grid,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@elizaos/ui/components";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import { ViewHeader } from "@elizaos/ui/components/shared/ViewHeader";
import { useViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type CalendarIssue,
  useCalendarWeek,
} from "../../hooks/useCalendarWeek.js";
import { CalendarSourceManager } from "../CalendarSourceManager.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat(undefined, { month: "short" }).format(
    new Date(2024, month, 1, 12),
  ),
);
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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

function formatAgendaDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
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
  coverage,
  onSelect,
}: {
  day: Date;
  cursor: Date;
  selectedDate: string;
  events: LifeOpsCalendarEvent[];
  coverage: "available" | "loading" | "partial" | "unavailable";
  onSelect: (day: Date) => void;
}) {
  const key = localDateKey(day);
  const dayEvents = eventsOnDate(events, key);
  const selected = key === selectedDate;
  const currentMonth = day.getMonth() === cursor.getMonth();
  const today = key === localDateKey(new Date());
  const selectDay = useCallback(() => onSelect(day), [day, onSelect]);
  const eventSummary =
    dayEvents.length > 0
      ? `${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`
      : coverage === "loading"
        ? "Events loading"
        : coverage === "unavailable"
          ? "Events unavailable"
          : coverage === "partial"
            ? "No events from available sources"
            : "No events";
  const cell = useAgentElement<HTMLButtonElement>({
    id: `calendar-day-${key}`,
    label: formatSelectedDate(key),
    role: "button",
    group: "calendar-grid",
    description: eventSummary,
    status: selected
      ? "selected"
      : currentMonth
        ? "current-month"
        : "outside-month",
    onActivate: selectDay,
  });

  return (
    <Button
      ref={cell.ref}
      {...cell.agentProps}
      className="eliza-calendar-day"
      data-state={selected ? "on" : "off"}
      data-outside-month={currentMonth ? undefined : "true"}
      variant="selection"
      size="tile"
      onClick={selectDay}
      aria-label={`${formatSelectedDate(key)}. ${eventSummary}`}
      aria-pressed={selected}
      aria-current={today ? "date" : undefined}
      style={{ minWidth: 0, width: "100%", position: "relative" }}
    >
      <span className="eliza-calendar-day-marker" aria-hidden>
        {day.getDate()}
        {today ? (
          <span className="eliza-calendar-today-dot" title="Today" />
        ) : null}
      </span>
      {dayEvents.length > 0 ? (
        <span className="eliza-calendar-event-dot" aria-hidden />
      ) : null}
    </Button>
  );
}

function MonthControls({
  cursor,
  onPrevious,
  onNext,
  onToday,
  onMonthChange,
}: {
  cursor: Date;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onMonthChange: (month: Date) => void;
}) {
  const month = formatMonth(cursor);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(cursor.getFullYear());
  // Month navigation must stay chat/voice-drivable: these ids ("prev",
  // "today", "next", plus the month-year picker) are the stable agent-bridge
  // contract the view-inventory smoke asserts, mirroring the retired unified
  // CalendarView's spatial ids. The labels double as the accessible names.
  const prevControl = useAgentElement<HTMLButtonElement>({
    id: "prev",
    label: `Previous month, ${month}`,
    role: "button",
    group: "calendar-nav",
    onActivate: onPrevious,
  });
  const nextControl = useAgentElement<HTMLButtonElement>({
    id: "next",
    label: `Next month, ${month}`,
    role: "button",
    group: "calendar-nav",
    onActivate: onNext,
  });
  const todayControl = useAgentElement<HTMLButtonElement>({
    id: "today",
    label: "Today",
    role: "button",
    group: "calendar-nav",
    onActivate: onToday,
  });
  const monthPickerControl = useAgentElement<HTMLButtonElement>({
    id: "month-picker",
    label: `Choose month and year. Current month is ${month}`,
    role: "button",
    group: "calendar-nav",
    status: pickerOpen ? "open" : "closed",
    onActivate: () => setPickerOpen(true),
  });
  useEffect(() => setPickerYear(cursor.getFullYear()), [cursor]);
  const yearOptions = useMemo(
    () =>
      Array.from(
        { length: 25 },
        (_, index) => cursor.getFullYear() - 12 + index,
      ),
    [cursor],
  );
  const chooseMonth = useCallback(
    (monthIndex: number) => {
      onMonthChange(new Date(pickerYear, monthIndex, 1, 12));
      setPickerOpen(false);
    },
    [onMonthChange, pickerYear],
  );
  return (
    <div
      data-testid="calendar-month-toolbar"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(64px, 88px) minmax(0, 1fr) 88px",
        alignItems: "center",
        minHeight: 44,
        marginBottom: 10,
      }}
    >
      <Button
        ref={todayControl.ref}
        {...todayControl.agentProps}
        variant="ghostMuted"
        size="touch"
        onClick={onToday}
        style={{ justifySelf: "start", paddingInline: 8 }}
      >
        Today
      </Button>
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={monthPickerControl.ref}
            {...monthPickerControl.agentProps}
            variant="transparent"
            size="touch"
            className="min-w-0"
            aria-label={`Choose month and year. Current month is ${month}`}
            style={{ maxWidth: "100%", justifySelf: "center" }}
          >
            <span>{month}</span>
            <ChevronDown size={15} aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          style={{ width: "min(19rem, calc(100vw - 2rem))" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 10,
            }}
          >
            <Button
              variant="surface"
              size="icon-lg"
              aria-label="Previous year"
              onClick={() => setPickerYear((year) => year - 1)}
            >
              <ChevronLeft size={17} aria-hidden />
            </Button>
            <Select
              value={String(pickerYear)}
              onValueChange={(value) => setPickerYear(Number(value))}
            >
              <SelectTrigger aria-label="Calendar year" variant="settingsTouch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((year) => (
                  <SelectItem key={year} value={String(year)}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="surface"
              size="icon-lg"
              aria-label="Next year"
              onClick={() => setPickerYear((year) => year + 1)}
            >
              <ChevronRight size={17} aria-hidden />
            </Button>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 6,
            }}
          >
            {MONTHS.map((label, monthIndex) => {
              const active =
                pickerYear === cursor.getFullYear() &&
                monthIndex === cursor.getMonth();
              return (
                <Button
                  key={label}
                  variant={active ? "default" : "surface"}
                  size="touch"
                  aria-pressed={active}
                  onClick={() => chooseMonth(monthIndex)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      <div
        style={{
          display: "flex",
          justifySelf: "end",
          width: 88,
        }}
      >
        <Button
          ref={prevControl.ref}
          {...prevControl.agentProps}
          variant="ghostMuted"
          size="icon-lg"
          aria-label={`Previous month, ${month}`}
          title="Previous month"
          onClick={onPrevious}
        >
          <ChevronLeft size={19} aria-hidden />
        </Button>
        <Button
          ref={nextControl.ref}
          {...nextControl.agentProps}
          variant="ghostMuted"
          size="icon-lg"
          aria-label={`Next month, ${month}`}
          title="Next month"
          onClick={onNext}
        >
          <ChevronRight size={19} aria-hidden />
        </Button>
      </div>
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
      <span
        aria-hidden
        style={{ borderRadius: 9999, background: "var(--accent)" }}
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

function issueTitle(issue: CalendarIssue): string {
  switch (issue.kind) {
    case "runtime_unavailable":
      return "Calendar needs a dedicated agent";
    case "authentication":
      return "Sign-in needed";
    case "permission":
      return "Calendar access is restricted";
    case "offline":
      return "You’re offline";
    case "network":
      return "Calendar couldn’t connect";
    case "timeout":
      return "Calendar took too long";
    case "server":
      return "Calendar unavailable";
    default:
      return "Calendar couldn’t load";
  }
}

function issueDetail(issue: CalendarIssue): string | undefined {
  switch (issue.kind) {
    case "runtime_unavailable":
      return "Connect a dedicated agent to use calendar sources.";
    case "offline":
      return "Reconnect to load your calendar.";
    case "network":
      return "Check your connection and try again.";
    case "timeout":
      return "Try again.";
    case "server":
      return undefined;
    default:
      return issue.message;
  }
}

function isGenericIssue(issue: CalendarIssue): boolean {
  if (issue.kind === "unknown") return true;
  const message = issue.message.trim().toLocaleLowerCase();
  return (
    message.includes("calendar is temporarily unavailable") ||
    message.includes("calendar failed to load") ||
    message.includes("calendar couldn’t load") ||
    message.includes("calendar couldn't load")
  );
}

function CalendarStatusRow({
  title,
  detail,
  tone,
  role,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string;
  tone: "warning" | "danger";
  role: "alert" | "status";
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section
      className="eliza-calendar-status"
      data-tone={tone}
      aria-label={title}
      role={role}
    >
      <span className="eliza-calendar-status-icon" aria-hidden>
        <AlertTriangle size={15} strokeWidth={2} />
      </span>
      <p className="eliza-calendar-status-copy">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </p>
      {actionLabel && onAction ? (
        <Button variant="surface" size="touch" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </section>
  );
}

export interface SimpleCalendarViewProps {
  /** Render the shared route header. Embedded projections turn this off. */
  standalone?: boolean;
}

export function SimpleCalendarView({
  standalone = false,
}: SimpleCalendarViewProps = {}) {
  const calendar = useCalendarWeek({ viewMode: "month" });
  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, () => {
    void calendar.refresh();
  }, [calendar.refresh]);

  const [selectedDate, setSelectedDate] = useState(() =>
    localDateKey(calendar.baseDate),
  );
  const baseDateKey = localDateKey(calendar.baseDate);
  const cursor = useMemo(
    () => monthStart(calendar.baseDate),
    [calendar.baseDate],
  );
  const days = useMemo(() => calendarDays(cursor), [cursor]);
  const selectedEvents = useMemo(
    () => eventsOnDate(calendar.events, selectedDate),
    [calendar.events, selectedDate],
  );
  useEffect(() => {
    setSelectedDate(baseDateKey);
  }, [baseDateKey]);
  const selectDay = useCallback(
    (day: Date) => {
      setSelectedDate(localDateKey(day));
      if (
        day.getFullYear() !== cursor.getFullYear() ||
        day.getMonth() !== cursor.getMonth()
      ) {
        calendar.goToDate(day);
      }
    },
    [calendar.goToDate, cursor],
  );
  const chooseMonth = useCallback(
    (month: Date) => calendar.goToDate(month),
    [calendar.goToDate],
  );
  // Keep the deprecated string field as a compatibility bridge for signed
  // native bundles or screenshot harnesses that have not adopted typed issues.
  const issue =
    calendar.issue ??
    (calendar.error
      ? {
          kind: "unknown" as const,
          message: calendar.error,
          retryable: true,
          upgradeRequired: false,
        }
      : null);
  const initialLoading = calendar.status === "loading";
  const sourcesUnavailable = calendar.status === "unavailable" && !issue;
  const genericIssue = issue ? isGenericIssue(issue) : false;
  const eventCount = `${calendar.events.length} ${calendar.events.length === 1 ? "event" : "events"}`;
  const detail = initialLoading
    ? "Loading calendar…"
    : issue
      ? calendar.events.length > 0
        ? `${eventCount} · refresh unavailable`
        : "Calendar unavailable"
      : calendar.status === "partial"
        ? `${eventCount} · some sources need attention`
        : sourcesUnavailable
          ? "Calendar sources unavailable"
          : eventCount;
  const selectedEventCount = `${selectedEvents.length} ${selectedEvents.length === 1 ? "event" : "events"}`;
  const agendaSummary = initialLoading
    ? "Loading events…"
    : issue && selectedEvents.length === 0
      ? ""
      : sourcesUnavailable
        ? ""
        : calendar.refreshing
          ? `${selectedEventCount} · Refreshing…`
          : selectedEvents.length === 0
            ? calendar.status === "partial"
              ? "Available calendars only"
              : "No plans yet"
            : selectedEventCount;
  const dayCoverage = initialLoading
    ? "loading"
    : issue || sourcesUnavailable
      ? "unavailable"
      : calendar.status === "partial"
        ? "partial"
        : "available";
  const showAgenda =
    initialLoading ||
    selectedEvents.length > 0 ||
    (!issue && !sourcesUnavailable);
  const sourceNotice = sourcesUnavailable
    ? ({
        label: "Calendar sources unavailable",
        tone: "warning",
      } as const)
    : calendar.status === "partial"
      ? ({
          label: "Some calendars are delayed",
          tone: "warning",
        } as const)
      : undefined;
  const sourceManager = (
    <div
      className="eliza-calendar-source-slot"
      data-testid="simple-calendar-source-manager"
      data-placement="promoted"
    >
      <CalendarSourceManager
        sourceHealth={calendar.sources}
        sourceNotice={sourceNotice}
        onSelectionChanged={() => void calendar.refresh()}
      />
    </div>
  );

  return (
    <PagePanel.Frame
      as="main"
      aria-busy={calendar.loading}
      aria-label={`Calendar. ${detail}`}
      data-testid="simple-calendar-view"
      className="relative flex-col overflow-hidden text-txt"
    >
      <style>{`
        .eliza-calendar-day:focus { outline: none; }
        .eliza-calendar-day:focus-visible {
          outline: 2px solid var(--accent, #ff6a1f);
          outline-offset: 2px;
        }
        .eliza-calendar-day[data-outside-month="true"]:not([data-state="on"]) {
          opacity: .48;
        }
        .eliza-calendar-day[data-state="on"] {
          background: transparent !important;
          color: var(--txt, #f5f5f5) !important;
        }
        .eliza-calendar-day-marker {
          position: relative;
          display: inline-grid;
          width: 34px;
          height: 34px;
          margin: auto;
          place-items: center;
          border-radius: 9999px;
          font-variant-numeric: tabular-nums;
          font-size: 13px;
          font-weight: 650;
        }
        .eliza-calendar-day[data-state="on"] .eliza-calendar-day-marker {
          background: var(--accent, #ff6a1f);
          color: var(--accent-foreground, #080808);
          font-weight: 760;
        }
        .eliza-calendar-day[data-state="on"] .eliza-calendar-today-dot {
          background: currentColor;
          opacity: .72;
        }
        .eliza-calendar-today-dot {
          position: absolute;
          top: 4px;
          right: 4px;
          width: 4px;
          height: 4px;
          border-radius: 9999px;
          background: var(--accent, #ff6a1f);
        }
        .eliza-calendar-event-dot {
          position: absolute;
          bottom: 2px;
          left: 50%;
          width: 5px;
          height: 5px;
          border-radius: 9999px;
          background: var(--accent, #ff6a1f);
          transform: translateX(-50%);
        }
        .eliza-calendar-layout {
          container-name: eliza-calendar;
          container-type: inline-size;
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 10px;
        }
        .eliza-calendar-status-slot {
          grid-column: 1 / -1;
          min-width: 0;
          padding: 0;
        }
        .eliza-calendar-status {
          display: flex;
          min-height: 44px;
          align-items: center;
          gap: 9px;
          border-radius: 12px;
          background: color-mix(in srgb, var(--card, #161616) 70%, transparent);
          padding: 4px 8px;
        }
        .eliza-calendar-status-icon {
          display: inline-flex;
          width: 20px;
          height: 20px;
          flex: 0 0 20px;
          align-items: center;
          justify-content: center;
        }
        .eliza-calendar-status[data-tone="warning"] .eliza-calendar-status-icon {
          color: var(--warning, #d99a2b);
        }
        .eliza-calendar-status[data-tone="danger"] .eliza-calendar-status-icon {
          color: var(--danger, #e05a5a);
        }
        .eliza-calendar-status-copy {
          min-width: 0;
          flex: 1;
          margin: 0;
          color: var(--muted, rgba(255,255,255,.58));
          font-size: 12px;
          line-height: 1.4;
        }
        .eliza-calendar-status-copy strong {
          color: var(--txt, #f5f5f5);
          font-weight: 650;
        }
        .eliza-calendar-status-copy span {
          display: block;
          margin-top: 1px;
        }
        .eliza-calendar-panel {
          box-sizing: border-box;
          min-width: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
        }
        .eliza-calendar-content {
          display: grid;
          min-width: 0;
          grid-template-columns: minmax(0, 1fr);
          gap: 10px;
        }
        .eliza-calendar-month {
          padding: 4px 0 14px;
        }
        .eliza-calendar-agenda {
          border-radius: 16px;
          background: color-mix(in srgb, var(--card, #161616) 70%, transparent);
          padding: 14px;
        }
        .eliza-calendar-source-slot {
          min-width: 0;
          margin: 0;
        }
        .eliza-calendar-source-slot[data-placement="promoted"] {
          margin: 0;
        }
        @container eliza-calendar (min-width: 720px) {
          .eliza-calendar-layout {
            grid-template-columns: minmax(0, 1fr);
            gap: 10px;
          }
          .eliza-calendar-status-slot {
            padding: 0 0 10px;
          }
          .eliza-calendar-status {
            border-radius: 12px;
            padding: 5px 10px;
          }
          .eliza-calendar-status[data-tone="warning"] {
            background: color-mix(in srgb, var(--warning, #d99a2b) 5%, transparent);
          }
          .eliza-calendar-status[data-tone="danger"] {
            background: color-mix(in srgb, var(--danger, #e05a5a) 5%, transparent);
          }
          .eliza-calendar-panel {
            border: 0;
            border-radius: 0;
            background: transparent;
          }
          .eliza-calendar-content {
            grid-template-columns: minmax(0, 58fr) minmax(0, 42fr);
            gap: 0;
            overflow: hidden;
            border: 1px solid color-mix(in srgb, var(--border, #737373) 34%, transparent);
            border-radius: 16px;
            background: color-mix(in srgb, var(--card, #161616) 72%, transparent);
          }
          .eliza-calendar-month {
            padding: 14px 16px 16px;
          }
          .eliza-calendar-agenda {
            border-radius: 0;
            background: transparent;
            border-top: 0;
            border-left: 1px solid color-mix(in srgb, var(--border, #737373) 34%, transparent);
            padding: 16px;
          }
          .eliza-calendar-source-slot { margin: 0; }
          .eliza-calendar-source-slot[data-placement="promoted"] { margin: 0; }
          .eliza-calendar-source-slot[data-placement="promoted"] > [data-notice-tone][data-state="closed"] {
            width: max-content;
            max-width: 100%;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .eliza-calendar-day { transition: none !important; }
        }
      `}</style>
      {standalone ? <ViewHeader title="Calendar" /> : null}
      <PagePanel.ContentArea data-testid="simple-calendar-scroll-region">
        <PagePanel.ContentRail
          width="wide"
          className="eliza-calendar-layout"
          style={{
            alignItems: "start",
            alignContent: "start",
            paddingBlockStart: "var(--view-pad-top, .5rem)",
            paddingBlockEnd: "var(--view-pad-bottom, 1rem)",
          }}
        >
          {issue ? (
            <div className="eliza-calendar-status-slot">
              <CalendarStatusRow
                role="alert"
                tone={
                  issue.kind === "offline" ||
                  issue.kind === "runtime_unavailable"
                    ? "warning"
                    : "danger"
                }
                title={
                  genericIssue ? "Calendar unavailable" : issueTitle(issue)
                }
                detail={genericIssue ? undefined : issueDetail(issue)}
                actionLabel={issue.retryable ? "Retry" : undefined}
                onAction={
                  issue.retryable ? () => void calendar.refresh() : undefined
                }
              />
            </div>
          ) : null}

          {sourceNotice ? sourceManager : null}

          <div
            className="eliza-calendar-content"
            data-testid="simple-calendar-content"
          >
            <PagePanel
              as="section"
              className="eliza-calendar-panel eliza-calendar-month"
              aria-label="Calendar month"
            >
              <MonthControls
                cursor={cursor}
                onPrevious={calendar.goPrevious}
                onNext={calendar.goNext}
                onToday={calendar.goToToday}
                onMonthChange={chooseMonth}
              />
              <Grid
                aria-hidden
                spacing="none"
                style={{
                  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                  gap: 3,
                }}
              >
                {WEEKDAYS.map((weekday) => (
                  <span
                    key={weekday}
                    style={{
                      paddingBottom: 5,
                      color: "var(--muted, rgba(255,255,255,.58))",
                      fontSize: 10,
                      fontWeight: 680,
                      textAlign: "center",
                    }}
                  >
                    {weekday.slice(0, 1)}
                  </span>
                ))}
              </Grid>
              <Grid
                role="group"
                aria-label={`${formatMonth(cursor)} calendar days`}
                spacing="none"
                style={{
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
                    coverage={dayCoverage}
                    onSelect={selectDay}
                  />
                ))}
              </Grid>
            </PagePanel>

            {showAgenda ? (
              <PagePanel
                as="section"
                className="eliza-calendar-panel eliza-calendar-agenda"
                aria-label={`Events for ${selectedDate}`}
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
                      {formatAgendaDate(selectedDate)}
                    </h2>
                    {agendaSummary ? (
                      <p
                        style={{
                          ...SECONDARY_STYLE,
                          marginTop: 3,
                          fontSize: 12,
                        }}
                      >
                        {agendaSummary}
                      </p>
                    ) : null}
                  </div>
                </div>
                {calendar.refreshing ? (
                  <span className="sr-only" role="status">
                    Refreshing calendar events
                  </span>
                ) : null}
                {initialLoading ? (
                  <PagePanel.Loading
                    role="status"
                    aria-label="Calendar events are loading"
                    heading="Loading events"
                    description="Fetching your calendar events"
                    style={{ minHeight: 128 }}
                  />
                ) : selectedEvents.length === 0 &&
                  !issue &&
                  !sourcesUnavailable ? (
                  <p style={SECONDARY_STYLE}>
                    {calendar.status === "partial"
                      ? "No events in available calendars."
                      : "Ask Eliza in chat to schedule something for this day."}
                  </p>
                ) : (
                  selectedEvents.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))
                )}
              </PagePanel>
            ) : null}
          </div>
        </PagePanel.ContentRail>
      </PagePanel.ContentArea>
    </PagePanel.Frame>
  );
}

export default SimpleCalendarView;
