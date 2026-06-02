// odysseus calendar (static/js/calendar.js + calendar/utils.js). A local-first
// month/week/year/agenda calendar: a prev/today/next toolbar with a
// week/month/year/agenda view toggle, a settings cog + refresh, a +New event
// button, a per-calendar filter chip row, the four view bodies, a day-detail
// panel, an event create/edit form, a per-event more-menu, and a calendar
// settings panel (per-calendar colour/name/delete, New calendar, .ics
// import/export).
//
// elizaMapping: odysseus's calendar is CalDAV-backed (an HTTP API for events +
// a /api/calendar/quick-parse NLP endpoint + /api/notes for reminders). eliza
// exposes the LifeOps calendar *types* (LifeOpsCalendarEvent /
// LifeOpsCalendarFeed in @elizaos/ui's client-types-config) but NO
// frontend-callable client method to fetch/create events, parse natural
// language, or create reminder notes. So this is the faithful no-eliza-backend
// path: the calendar is fully **local-first** — calendars and events are owned
// by, created in, and persisted to localStorage (matching odysseus's local
// zero-state before any CalDAV sync). Nothing is fabricated as if it came from
// the agent. Two odysseus surfaces require a backend eliza lacks and are
// therefore intentionally NOT shipped (rather than shipped as dead controls):
//   - the natural-language quick-add row (needs /api/calendar/quick-parse),
//   - "Remind me" / CalDAV "Sync now" (need /api/notes + a CalDAV server).
// An eliza-backed calendar client method is the follow-up that unlocks both.

import {
  ChevronLeft,
  ChevronRight,
  Settings as Cog,
  Download,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// Local-prefs keys for the persisted calendar list + event store. Not in the
// shared PREF_KEYS enum (that file is owned by the shell) — namespaced the same
// way via readPref/writePref.
const CAL_PREF_KEY = "calendars";
const EVENTS_PREF_KEY = "calendar-events";

// How long the Refresh button keeps its spin animation after a (synchronous,
// local) re-read from storage — a brief visual ack mirroring odysseus's CalDAV
// "Sync now" feedback. Purely cosmetic.
const SYNC_SPIN_MS = 450;

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
const MON_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
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

// odysseus _showCalSettings COLORS — the swatch row for new/edited calendars.
const CAL_SETTINGS_COLORS = [
  "#5b8abf",
  "#4caf50",
  "#ff9800",
  "#e91e63",
  "#9c27b0",
  "#00bcd4",
  "#795548",
  "#607d8b",
  "#f44336",
  "#7c4dff",
] as const;

// Recurrence options mirror odysseus's _showEventForm <select id="cal-f-rrule">.
const RRULE_OPTIONS = [
  { value: "", label: "Does not repeat" },
  { value: "FREQ=DAILY", label: "Daily" },
  { value: "FREQ=WEEKLY", label: "Weekly" },
  { value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", label: "Weekdays" },
  { value: "FREQ=MONTHLY", label: "Monthly" },
  { value: "FREQ=YEARLY", label: "Yearly" },
] as const;

type CalendarViewMode = "week" | "month" | "year" | "agenda";

interface LocalCalendar {
  href: string;
  name: string;
  color: string;
}

interface CalEvent {
  uid: string;
  summary: string;
  calendarHref: string;
  // `YYYY-MM-DD` local date the event starts on.
  date: string;
  // `YYYY-MM-DD` local date the event ends on (== date for single-day events).
  endDate: string;
  // `HH:MM` 24h start time, empty for all-day events.
  startTime: string;
  // `HH:MM` 24h end time, empty for all-day events.
  endTime: string;
  allDay: boolean;
  location: string;
  description: string;
  rrule: string;
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

function isoWeekNumber(d: Date): number {
  const tgt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  tgt.setDate(tgt.getDate() + 3 - ((tgt.getDay() + 6) % 7));
  const yearStart = new Date(tgt.getFullYear(), 0, 1);
  return Math.ceil(((tgt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// "9:30 AM"-style clock label from an "HH:MM" 24h string.
function fmtClock(hhmm: string): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtLongDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function calColor(ev: CalEvent, calendars: LocalCalendar[]): string {
  const c = calendars.find((cal) => cal.href === ev.calendarHref);
  return c ? c.color : "var(--accent)";
}

function newUid(): string {
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── .ics (RFC 5545) serialise / parse — pure client-side, mirrors odysseus's
//    per-calendar Export and the .ics Import file picker. ──────────────────

function toIcsDate(dateStr: string, time: string, allDay: boolean): string {
  const compact = dateStr.replace(/-/g, "");
  if (allDay || !time) return `;VALUE=DATE:${compact}`;
  const t = time.replace(":", "");
  return `:${compact}T${t}00`;
}

function buildIcs(cal: LocalCalendar, events: CalEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//elizaOS//odysseus-calendar//EN",
    `X-WR-CALNAME:${cal.name}`,
  ];
  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`SUMMARY:${ev.summary.replace(/\n/g, "\\n")}`);
    lines.push(`DTSTART${toIcsDate(ev.date, ev.startTime, ev.allDay)}`);
    lines.push(`DTEND${toIcsDate(ev.endDate, ev.endTime, ev.allDay)}`);
    if (ev.location) lines.push(`LOCATION:${ev.location}`);
    if (ev.description)
      lines.push(`DESCRIPTION:${ev.description.replace(/\n/g, "\\n")}`);
    if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function parseIcsDate(raw: string): {
  date: string;
  time: string;
  allDay: boolean;
} {
  // Strip any TZID/VALUE params, keep the value after the last ':'.
  const value = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  const isDateOnly = !value.includes("T");
  const y = value.slice(0, 4);
  const mo = value.slice(4, 6);
  const d = value.slice(6, 8);
  const date = `${y}-${mo}-${d}`;
  if (isDateOnly) return { date, time: "", allDay: true };
  const hh = value.slice(9, 11);
  const mm = value.slice(11, 13);
  return { date, time: `${hh}:${mm}`, allDay: false };
}

function parseIcs(text: string, calendarHref: string): CalEvent[] {
  const out: CalEvent[] = [];
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0];
    const lines = body.split(/\r?\n/);
    let summary = "";
    let location = "";
    let description = "";
    let rrule = "";
    let start: { date: string; time: string; allDay: boolean } | null = null;
    let end: { date: string; time: string; allDay: boolean } | null = null;
    for (const line of lines) {
      const head = line.split(":")[0]?.split(";")[0]?.toUpperCase() ?? "";
      if (head === "SUMMARY")
        summary = line.slice(line.indexOf(":") + 1).replace(/\\n/g, "\n");
      else if (head === "LOCATION")
        location = line.slice(line.indexOf(":") + 1);
      else if (head === "DESCRIPTION")
        description = line.slice(line.indexOf(":") + 1).replace(/\\n/g, "\n");
      else if (head === "RRULE") rrule = line.slice(line.indexOf(":") + 1);
      else if (head === "DTSTART") start = parseIcsDate(line);
      else if (head === "DTEND") end = parseIcsDate(line);
    }
    if (!start) continue;
    out.push({
      uid: newUid(),
      summary: summary || "(no title)",
      calendarHref,
      date: start.date,
      endDate: end ? end.date : start.date,
      startTime: start.time,
      endTime: end ? end.time : start.time,
      allDay: start.allDay,
      location,
      description,
      rrule,
    });
  }
  return out;
}

// ── Event form (modeled on odysseus _showEventForm) ──────────────────────

interface EventFormProps {
  existing: CalEvent | null;
  defaultDate: string;
  calendars: LocalCalendar[];
  onSave: (ev: CalEvent) => void;
  onDelete: (uid: string) => void;
  onCancel: () => void;
}

function EventForm({
  existing,
  defaultDate,
  calendars,
  onSave,
  onDelete,
  onCancel,
}: EventFormProps): ReactNode {
  const [summary, setSummary] = useState(existing?.summary ?? "");
  const [date, setDate] = useState(existing?.date ?? defaultDate);
  const [endDate, setEndDate] = useState(
    existing?.endDate ?? existing?.date ?? defaultDate,
  );
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [startTime, setStartTime] = useState(existing?.startTime || "09:00");
  const [endTime, setEndTime] = useState(existing?.endTime || "10:00");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [rrule, setRrule] = useState(existing?.rrule ?? "");
  const [calendarHref, setCalendarHref] = useState(
    existing?.calendarHref ?? calendars[0]?.href ?? "",
  );
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Focus the title input on open — matches odysseus's bespoke-form behaviour
  // without tripping the a11y/noAutofocus lint on the attribute form.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const isEdit = !!existing;
  const mapsHref = location
    ? `https://maps.apple.com/?q=${encodeURIComponent(location)}`
    : "";

  const submit = () => {
    const cleanEnd = endDate < date ? date : endDate;
    onSave({
      uid: existing?.uid ?? newUid(),
      summary: summary.trim() || "(no title)",
      calendarHref,
      date,
      endDate: cleanEnd,
      startTime: allDay ? "" : startTime,
      endTime: allDay ? "" : endTime,
      allDay,
      location: location.trim(),
      description: description.trim(),
      rrule,
    });
  };

  return (
    <div className="od-cal-form">
      <div className="od-cal-hero">
        <span className="od-cal-hero-time">
          {allDay ? "All day" : fmtClock(startTime)}
        </span>
        <span className="od-cal-hero-date">{fmtLongDate(date)}</span>
      </div>

      <div className="od-cal-title-wrap">
        <input
          ref={titleRef}
          type="text"
          className="od-cal-input od-cal-hero-title"
          placeholder={isEdit ? "Event title" : "What's happening?"}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="od-cal-form-details">
        <div className="od-cal-form-row">
          <input
            type="date"
            className="od-cal-input"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (endDate < e.target.value) setEndDate(e.target.value);
            }}
            aria-label="Start date"
          />
          <span className="od-cal-form-to">to</span>
          <input
            type="date"
            className="od-cal-input"
            value={endDate}
            min={date}
            onChange={(e) => setEndDate(e.target.value)}
            aria-label="End date"
          />
          <label className="od-cal-allday-ctrl">
            <span>All day</span>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
            />
          </label>
        </div>

        {allDay ? null : (
          <div className="od-cal-form-row">
            <input
              type="time"
              className="od-cal-input"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              aria-label="Start time"
            />
            <span className="od-cal-form-to">–</span>
            <input
              type="time"
              className="od-cal-input"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              aria-label="End time"
            />
          </div>
        )}

        <div className="od-cal-form-row">
          <input
            type="text"
            className="od-cal-input"
            placeholder="Location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          {mapsHref ? (
            <a
              className="od-cal-loc-map"
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Maps"
            >
              Map
            </a>
          ) : null}
        </div>

        <select
          className="od-cal-input"
          value={rrule}
          onChange={(e) => setRrule(e.target.value)}
          aria-label="Recurrence"
        >
          {RRULE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <textarea
          className="od-cal-input"
          placeholder="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {calendars.length > 1 ? (
          <select
            className="od-cal-input"
            value={calendarHref}
            onChange={(e) => setCalendarHref(e.target.value)}
            aria-label="Calendar"
          >
            {calendars.map((c) => (
              <option key={c.href} value={c.href}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="od-cal-form-actions">
        {isEdit ? (
          <button
            type="button"
            className="od-cal-btn od-cal-btn-danger"
            onClick={() => existing && onDelete(existing.uid)}
          >
            Delete
          </button>
        ) : null}
        <button type="button" className="od-cal-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="od-cal-btn od-cal-btn-primary"
          onClick={submit}
        >
          {isEdit ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}

// ── Calendar settings panel (modeled on odysseus _showCalSettings) ────────

interface CalSettingsProps {
  calendars: LocalCalendar[];
  onChange: (cals: LocalCalendar[]) => void;
  onImport: (events: CalEvent[]) => void;
  eventsFor: (href: string) => CalEvent[];
  onClose: () => void;
}

function CalSettings({
  calendars,
  onChange,
  onImport,
  eventsFor,
  onClose,
}: CalSettingsProps): ReactNode {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importTarget, setImportTarget] = useState<string>(
    calendars[0]?.href ?? "",
  );
  const [importStatus, setImportStatus] = useState<string>("");

  const updateCal = (href: string, patch: Partial<LocalCalendar>) => {
    onChange(calendars.map((c) => (c.href === href ? { ...c, ...patch } : c)));
  };

  const deleteCal = (href: string) => {
    onChange(calendars.filter((c) => c.href !== href));
  };

  const addCal = () => {
    const color =
      CAL_SETTINGS_COLORS[calendars.length % CAL_SETTINGS_COLORS.length];
    onChange([
      ...calendars,
      { href: `local/${newUid()}`, name: "New calendar", color },
    ]);
  };

  const exportCal = (cal: LocalCalendar) => {
    const ics = buildIcs(cal, eventsFor(cal.href));
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cal.name.replace(/[^\w-]+/g, "_") || "calendar"}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const target = importTarget || calendars[0]?.href || "";
      if (!target) {
        setImportStatus("Add a calendar first");
        return;
      }
      const parsed = parseIcs(text, target);
      if (!parsed.length) {
        setImportStatus("No events found in file");
        return;
      }
      onImport(parsed);
      setImportStatus(
        `Imported ${parsed.length} event${parsed.length === 1 ? "" : "s"}`,
      );
    };
    reader.onerror = () => setImportStatus("Could not read file");
    reader.readAsText(file);
  };

  return (
    <div className="od-cal-settings-overlay">
      <button
        type="button"
        className="od-cal-settings-backdrop"
        aria-label="Close settings"
        onClick={onClose}
      />
      <div
        className="od-cal-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Calendar settings"
      >
        <div className="od-cal-settings-head">
          <span>Calendar Settings</span>
          <button
            type="button"
            className="od-cal-settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={14} />
          </button>
        </div>
        <div className="od-cal-settings-body">
          <div className="od-cal-settings-section">
            <div className="od-cal-settings-label">Your calendars</div>
            <div className="od-cal-settings-list">
              {calendars.map((c) => (
                <div className="od-cal-settings-row" key={c.href}>
                  <input
                    type="color"
                    className="od-cal-s-color"
                    value={
                      c.color.startsWith("#") ? c.color : CAL_SETTINGS_COLORS[0]
                    }
                    onChange={(e) =>
                      updateCal(c.href, { color: e.target.value })
                    }
                    aria-label={`${c.name} colour`}
                  />
                  <input
                    type="text"
                    className="od-cal-s-name-input"
                    value={c.name}
                    onChange={(e) =>
                      updateCal(c.href, { name: e.target.value })
                    }
                    aria-label="Calendar name"
                  />
                  <button
                    type="button"
                    className="od-cal-s-del"
                    title="Delete calendar"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => deleteCal(c.href)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="od-cal-settings-btn"
              onClick={addCal}
            >
              <Plus size={11} /> New calendar
            </button>
          </div>

          <div className="od-cal-settings-section od-cal-settings-divided">
            <div className="od-cal-settings-label">Import calendar</div>
            <div className="od-cal-settings-import-row">
              {calendars.length > 1 ? (
                <select
                  className="od-cal-input od-cal-import-target"
                  value={importTarget}
                  onChange={(e) => setImportTarget(e.target.value)}
                  aria-label="Import into calendar"
                >
                  {calendars.map((c) => (
                    <option key={c.href} value={c.href}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className="od-cal-settings-btn"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={11} /> Import .ics
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".ics,.ical"
                className="od-cal-hidden-file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportFile(file);
                  e.target.value = "";
                }}
              />
              {importStatus ? (
                <span className="od-cal-settings-status">{importStatus}</span>
              ) : null}
            </div>
            <div className="od-cal-settings-hint">
              Upload a .ics file to import events. Google Calendar, Apple
              Calendar, and Outlook all export .ics files.
            </div>
          </div>

          <div className="od-cal-settings-section od-cal-settings-divided">
            <div className="od-cal-settings-label">Export calendar</div>
            <div className="od-cal-settings-export-row">
              {calendars.map((c) => (
                <button
                  type="button"
                  className="od-cal-settings-btn"
                  key={c.href}
                  title={`Download ${c.name}.ics`}
                  onClick={() => exportCal(c)}
                >
                  <Download size={11} /> {c.name}
                </button>
              ))}
            </div>
            <div className="od-cal-settings-hint">
              Download a calendar as .ics for backup or to import into another
              app.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Empty state (modeled on odysseus _renderEmpty) ────────────────────────

function CalEmptyState({
  onNewCalendar,
  onImport,
}: {
  onNewCalendar: () => void;
  onImport: () => void;
}): ReactNode {
  return (
    <div className="od-cal-empty-state">
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="od-cal-empty-ico"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
      <div className="od-cal-empty-title">No calendars yet</div>
      <div className="od-cal-empty-msg">
        Create a local calendar or import an .ics file to get started.
      </div>
      <div className="od-cal-empty-actions">
        <button
          type="button"
          className="od-cal-btn od-cal-btn-primary"
          onClick={onNewCalendar}
        >
          New calendar
        </button>
        <button type="button" className="od-cal-btn" onClick={onImport}>
          Import .ics
        </button>
      </div>
    </div>
  );
}

// ── Event more-menu (modeled on odysseus _showEventMoreMenu) ──────────────

function EventMoreMenu({
  x,
  y,
  onEdit,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactNode {
  useEffect(() => {
    const onDoc = () => onClose();
    // Defer so the opening click doesn't immediately dismiss.
    const id = window.setTimeout(
      () => window.addEventListener("click", onDoc, { once: true }),
      0,
    );
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("click", onDoc);
    };
  }, [onClose]);

  return (
    <div
      className="od-cal-event-dropdown"
      style={{ top: y, left: x }}
      role="menu"
    >
      <button
        type="button"
        className="od-cal-dropdown-item"
        role="menuitem"
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="od-cal-dropdown-item od-cal-dropdown-danger"
        role="menuitem"
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}

export function CalendarView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const [view, setView] = useState<CalendarViewMode>("month");
  const [current, setCurrent] = useState<Date>(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string>(() => ymd(new Date()));
  const [hiddenCals, setHiddenCals] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Local-first persisted state — calendars + events both live in localStorage
  // (see file header). `version` bumps when the user hits Refresh, forcing a
  // re-read from storage so an external edit/import in another tab is picked up.
  const [calendars, setCalendars] = useState<LocalCalendar[]>(() =>
    readPref<LocalCalendar[]>(CAL_PREF_KEY, DEFAULT_CALENDARS),
  );
  const [events, setEvents] = useState<CalEvent[]>(() =>
    readPref<CalEvent[]>(EVENTS_PREF_KEY, []),
  );
  const [formState, setFormState] = useState<{
    existing: CalEvent | null;
    date: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{
    ev: CalEvent;
    x: number;
    y: number;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // The pending sync-spin timer, cleared on unmount so the cosmetic
  // setSyncing(false) never fires after the view is gone.
  const syncTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(
    null,
  );

  const win = useWindowControls("win-calendar", { w: 720, h: 620 });

  const persistCalendars = useCallback((next: LocalCalendar[]) => {
    setCalendars(next);
    writePref(CAL_PREF_KEY, next);
  }, []);

  const persistEvents = useCallback((next: CalEvent[]) => {
    setEvents(next);
    writePref(EVENTS_PREF_KEY, next);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if (formState) {
        setFormState(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, settingsOpen, formState]);

  // Clear the pending sync-spin timer on unmount.
  useEffect(
    () => () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
    },
    [],
  );

  const today = ymd(new Date());
  const year = current.getFullYear();
  const month = current.getMonth();

  const eventVisible = useCallback(
    (e: CalEvent): boolean => !hiddenCals.has(e.calendarHref),
    [hiddenCals],
  );
  const visibleEvents = useMemo(
    () => events.filter(eventVisible),
    [events, eventVisible],
  );

  const eventsForDay = useCallback(
    (date: string): CalEvent[] =>
      visibleEvents
        .filter((e) => date >= e.date && date <= e.endDate)
        .sort((a, b) => {
          if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
          return (a.startTime || "").localeCompare(b.startTime || "");
        }),
    [visibleEvents],
  );

  if (!open) return null;

  const toggleCal = (href: string) => {
    setHiddenCals((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });
  };

  const shiftPeriod = (delta: number) => {
    if (view === "year") setCurrent(new Date(year + delta, month, 1));
    else if (view === "week")
      setCurrent(new Date(year, month, current.getDate() + delta * 7));
    else setCurrent(new Date(year, month + delta, 1));
  };

  const goToday = () => {
    const now = new Date();
    setCurrent(now);
    setSelectedDay(ymd(now));
  };

  const doRefresh = () => {
    setSyncing(true);
    setCalendars(readPref<LocalCalendar[]>(CAL_PREF_KEY, DEFAULT_CALENDARS));
    setEvents(readPref<CalEvent[]>(EVENTS_PREF_KEY, []));
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = window.setTimeout(() => {
      setSyncing(false);
      syncTimerRef.current = null;
    }, SYNC_SPIN_MS);
  };

  const saveEvent = (ev: CalEvent) => {
    const idx = events.findIndex((e) => e.uid === ev.uid);
    const next =
      idx >= 0
        ? events.map((e) => (e.uid === ev.uid ? ev : e))
        : [...events, ev];
    persistEvents(next);
    setFormState(null);
    setSelectedDay(ev.date);
  };

  const deleteEvent = (uid: string) => {
    persistEvents(events.filter((e) => e.uid !== uid));
    setFormState(null);
    setMoreMenu(null);
  };

  const openNew = (date?: string) =>
    setFormState({ existing: null, date: date ?? selectedDay ?? today });
  const openEdit = (ev: CalEvent) =>
    setFormState({ existing: ev, date: ev.date });

  const showFilters = calendars.length > 1;

  // ── Toolbar (shared across views) ───────────────────────────────────────
  const titleText =
    view === "agenda"
      ? "Upcoming"
      : view === "year"
        ? String(year)
        : `${MONTHS[month]} ${year}`;
  const weekSuffix = view === "week" ? ` · W${isoWeekNumber(current)}` : "";

  const toolbar = (
    <div
      className="od-cal-toolbar od-window-header"
      onPointerDown={win.onDragStart}
    >
      <div className="od-cal-toolbar-nav">
        <button
          type="button"
          className="od-cal-nav"
          onClick={() => shiftPeriod(-1)}
          aria-label="Previous"
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
          {titleText}
          {weekSuffix}
        </span>
        <button
          type="button"
          className="od-cal-nav"
          onClick={() => shiftPeriod(1)}
          aria-label="Next"
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
          onClick={() => setSettingsOpen(true)}
        >
          <Cog size={13} />
        </button>
        <button
          type="button"
          className={`od-cal-nav${syncing ? " od-cal-syncing" : ""}`}
          title="Refresh from storage"
          aria-label="Refresh"
          onClick={doRefresh}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="od-cal-add-btn od-cal-add-btn-text"
          title="New event"
          aria-label="New event"
          onClick={() => openNew()}
        >
          <span className="od-cal-add-plus">
            <Plus size={13} />
          </span>
          <span className="od-cal-add-label">New</span>
        </button>
      </div>
    </div>
  );

  const filterRow = showFilters ? (
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
  ) : null;

  // ── Month grid ──────────────────────────────────────────────────────────
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

  const monthBody = (
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
                onDoubleClick={() => openNew(cell.date)}
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
                    {ev.startTime ? (
                      <span className="od-cal-event-row-time">
                        {fmtClock(ev.startTime)}
                      </span>
                    ) : null}
                    <span className="od-cal-event-row-name">{ev.summary}</span>
                  </span>
                ))}
                {singles.length > maxInline ? (
                  <span className="od-cal-event-more-count">
                    +{singles.length - maxInline} more
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  // ── Week view (hour rail + day columns) ─────────────────────────────────
  const weekStartDow = (current.getDay() + 6) % 7;
  const weekStart = new Date(year, month, current.getDate() - weekStartDow);
  const weekDays: { ds: string; d: Date; idx: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    weekDays.push({ ds: ymd(d), d, idx: i });
  }
  const HOUR_START = 7;
  const HOUR_END = 22;
  const HOUR_PX = 40;
  const hours: number[] = [];
  for (let h = HOUR_START; h < HOUR_END; h++) hours.push(h);
  const hourLabel = (h: number): string => {
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${ampm}`;
  };
  const minsFromStart = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h - HOUR_START) * 60 + m;
  };

  const weekBody = (
    <div className="od-cal-wk-wrap">
      <div className="od-cal-wk-rail">
        <div className="od-cal-wk-rail-spacer" />
        {hours.map((h) => (
          <div
            className="od-cal-wk-rail-cell"
            style={{ height: HOUR_PX }}
            key={h}
          >
            <span>{hourLabel(h)}</span>
          </div>
        ))}
      </div>
      <div className="od-cal-wk-cols">
        {weekDays.map(({ ds, d, idx }) => {
          const dayEvents = eventsForDay(ds);
          const allDayEvents = dayEvents.filter((e) => e.allDay);
          const timedEvents = dayEvents.filter((e) => !e.allDay);
          const isToday = ds === today;
          return (
            <div
              className={`od-cal-wk-col${isToday ? " od-cal-wk-today" : ""}`}
              key={ds}
            >
              <div className="od-cal-wk-col-head">
                <span className="od-cal-wk-dn">{WEEKDAYS[idx]}</span>
                <span className="od-cal-wk-dt">{d.getDate()}</span>
              </div>
              <div className="od-cal-wk-allday">
                {allDayEvents.map((ev) => (
                  <button
                    type="button"
                    className="od-cal-wk-allday-event"
                    key={ev.uid}
                    style={{ background: calColor(ev, calendars) }}
                    title={ev.summary}
                    onClick={() => openEdit(ev)}
                  >
                    {ev.summary}
                  </button>
                ))}
              </div>
              <div
                className="od-cal-wk-grid"
                style={{ height: hours.length * HOUR_PX }}
              >
                {hours.map((h) => (
                  <div
                    className="od-cal-wk-cell"
                    style={{ height: HOUR_PX }}
                    key={h}
                  />
                ))}
                {timedEvents.map((ev) => {
                  const top = (minsFromStart(ev.startTime) / 60) * HOUR_PX;
                  const endM = ev.endTime
                    ? minsFromStart(ev.endTime)
                    : minsFromStart(ev.startTime) + 60;
                  const height = Math.max(
                    16,
                    ((endM - minsFromStart(ev.startTime)) / 60) * HOUR_PX,
                  );
                  return (
                    <button
                      type="button"
                      className="od-cal-wk-event"
                      key={ev.uid}
                      style={{
                        top,
                        height,
                        background: `color-mix(in srgb, ${calColor(ev, calendars)} 22%, var(--bg))`,
                        borderLeftColor: calColor(ev, calendars),
                      }}
                      onClick={() => openEdit(ev)}
                    >
                      <span className="od-cal-wk-event-time">
                        {fmtClock(ev.startTime)}
                      </span>
                      <span className="od-cal-wk-event-name">{ev.summary}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Year view (12 mini month grids) ─────────────────────────────────────
  const yearBody = (
    <div className="od-cal-year">
      {Array.from({ length: 12 }, (_, m) => {
        const mFirst = new Date(year, m, 1);
        const mDow = (mFirst.getDay() + 6) % 7;
        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const cells: (number | null)[] = [];
        for (let p = 0; p < mDow; p++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) cells.push(d);
        return (
          <button
            type="button"
            className="od-cal-year-month"
            key={MON_SHORT[m]}
            onClick={() => {
              setCurrent(new Date(year, m, 1));
              setView("month");
            }}
          >
            <div className="od-cal-year-month-title">{MON_SHORT[m]}</div>
            <div className="od-cal-year-grid">
              {["M", "T", "W", "T", "F", "S", "S"].map((wd, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 7-element weekday header
                <div className="od-cal-year-wd" key={`wd-${i}`}>
                  {wd}
                </div>
              ))}
              {cells.map((d, i) => {
                if (d == null)
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position leading blank cell
                  return <div className="od-cal-year-cell" key={`pad-${i}`} />;
                const ds = `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                const has = eventsForDay(ds).length > 0;
                const cls = [
                  "od-cal-year-cell",
                  "od-cal-year-day",
                  ds === today ? "od-cal-year-today" : "",
                  has ? "od-cal-year-has" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div className={cls} key={ds}>
                    {d}
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );

  // ── Agenda view (chronological, grouped by day) ─────────────────────────
  const agendaStart = ymd(current);
  const agendaEndDate = new Date(current);
  agendaEndDate.setMonth(agendaEndDate.getMonth() + 3);
  const agendaEnd = ymd(agendaEndDate);
  const agendaEvents = visibleEvents
    .filter((e) => e.date >= agendaStart && e.date <= agendaEnd)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.startTime || "").localeCompare(b.startTime || "");
    });
  const agendaByDate = new Map<string, CalEvent[]>();
  for (const ev of agendaEvents) {
    const list = agendaByDate.get(ev.date) ?? [];
    list.push(ev);
    agendaByDate.set(ev.date, list);
  }
  if (today >= agendaStart && today <= agendaEnd && !agendaByDate.has(today))
    agendaByDate.set(today, []);
  const agendaDates = [...agendaByDate.keys()].sort();

  const agendaBody = (
    <div className="od-cal-agenda">
      {agendaDates.length === 0 ? (
        <div className="od-cal-empty">No upcoming events</div>
      ) : (
        agendaDates.map((date) => {
          const evs = agendaByDate.get(date) ?? [];
          return (
            <div
              className={`od-cal-agenda-day${date === today ? " is-today" : ""}`}
              key={date}
            >
              <div className="od-cal-agenda-date">
                {fmtLongDate(date)}
                {date === today ? (
                  <span className="od-cal-agenda-today-badge">Today</span>
                ) : null}
              </div>
              {evs.length === 0 ? (
                <div className="od-cal-agenda-empty">No events</div>
              ) : (
                evs.map((ev) => (
                  <button
                    type="button"
                    className="od-cal-agenda-event"
                    key={ev.uid}
                    onClick={() => openEdit(ev)}
                  >
                    <span
                      className="od-cal-event-dot"
                      style={{ background: calColor(ev, calendars) }}
                    />
                    <div className="od-cal-event-info">
                      <div className="od-cal-event-name">{ev.summary}</div>
                      <div className="od-cal-event-time">
                        {ev.allDay
                          ? "All day"
                          : `${fmtClock(ev.startTime)} – ${fmtClock(ev.endTime)}`}
                        {ev.location ? ` · ${ev.location}` : ""}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          );
        })
      )}
    </div>
  );

  // ── Day detail (month/week footer panel) ────────────────────────────────
  const detailEvents = eventsForDay(selectedDay);
  const dayDetail =
    view === "month" || view === "week" ? (
      <div className="od-cal-day-detail">
        <div className="od-cal-detail-header">
          <span>{fmtLongDate(selectedDay)}</span>
          <button
            type="button"
            className="od-cal-add-btn od-cal-add-btn-text od-cal-add-btn-sm"
            title="New event"
            aria-label="New event on this day"
            onClick={() => openNew(selectedDay)}
          >
            <span className="od-cal-add-plus">
              <Plus size={11} />
            </span>
            <span className="od-cal-add-label">New</span>
          </button>
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
              <button
                type="button"
                className="od-cal-event-info od-cal-event-info-btn"
                onClick={() => openEdit(ev)}
              >
                <div className="od-cal-event-name">{ev.summary}</div>
                <div className="od-cal-event-time">
                  {ev.allDay
                    ? "All day"
                    : `${fmtClock(ev.startTime)} – ${fmtClock(ev.endTime)}`}
                  {ev.location ? ` · ${ev.location}` : ""}
                </div>
              </button>
              <button
                type="button"
                className="od-cal-event-more-btn"
                title="More"
                aria-label="Event actions"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMoreMenu({ ev, x: r.left, y: r.bottom + 4 });
                }}
              >
                ⋯
              </button>
            </div>
          ))
        )}
      </div>
    ) : null;

  const hasCalendars = calendars.length > 0;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
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
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-cal-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div className="od-cal-body">
          {!hasCalendars ? (
            <>
              <div
                className="od-cal-toolbar od-window-header"
                onPointerDown={win.onDragStart}
              >
                <span className="od-cal-title">Calendar</span>
                <div className="od-cal-toolbar-right">
                  <button
                    type="button"
                    className="od-cal-nav"
                    title="Calendar settings"
                    aria-label="Calendar settings"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Cog size={13} />
                  </button>
                </div>
              </div>
              <CalEmptyState
                onNewCalendar={() => {
                  persistCalendars([
                    {
                      href: `local/${newUid()}`,
                      name: "New calendar",
                      color: CAL_SETTINGS_COLORS[0],
                    },
                  ]);
                  setSettingsOpen(true);
                }}
                onImport={() => setSettingsOpen(true)}
              />
            </>
          ) : formState ? (
            <>
              {toolbar}
              <EventForm
                existing={formState.existing}
                defaultDate={formState.date}
                calendars={calendars}
                onSave={saveEvent}
                onDelete={deleteEvent}
                onCancel={() => setFormState(null)}
              />
            </>
          ) : (
            <>
              {toolbar}
              {filterRow}
              {view === "month" ? monthBody : null}
              {view === "week" ? weekBody : null}
              {view === "year" ? yearBody : null}
              {view === "agenda" ? agendaBody : null}
              {dayDetail}
            </>
          )}
        </div>
      </div>

      {settingsOpen ? (
        <CalSettings
          calendars={calendars}
          onChange={persistCalendars}
          onImport={(imported) => persistEvents([...events, ...imported])}
          eventsFor={(href) => events.filter((e) => e.calendarHref === href)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {moreMenu ? (
        <EventMoreMenu
          x={moreMenu.x}
          y={moreMenu.y}
          onEdit={() => {
            openEdit(moreMenu.ev);
            setMoreMenu(null);
          }}
          onDelete={() => deleteEvent(moreMenu.ev.uid)}
          onClose={() => setMoreMenu(null)}
        />
      ) : null}
    </div>
  );
}
