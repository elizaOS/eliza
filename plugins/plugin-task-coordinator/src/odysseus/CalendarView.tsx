// odysseus calendar (static/js/calendar.js + calendar/utils.js). A local-first
// month/week/year/agenda calendar: a prev/today/next toolbar with a
// week/month/year/agenda view toggle, a settings cog + refresh, a +New event
// button, a per-calendar filter chip row, the four view bodies, a day-detail
// panel, an event create/edit form, a per-event more-menu, and a calendar
// settings panel (per-calendar colour/name/delete, New calendar, .ics
// import/export).
//
// elizaMapping: this view is **local-first AND provider-overlaid**. The local
// layer owns every write: calendars and events the user creates, edits,
// deletes, and imports/exports as .ics live in localStorage (the same
// zero-state odysseus shipped before any CalDAV sync). On top of that, when a
// calendar grant is connected (Google / Apple via @elizaos/plugin-calendar),
// the view overlays the agent's aggregated calendar feed as a **read-only**
// provider layer: provider calendars and events render alongside the local
// ones but cannot be edited, deleted, or exported here. The feed is fetched via
// the @elizaos/ui client methods that @elizaos/plugin-calendar augments onto
// the client prototype (getLifeOpsCalendars / getLifeOpsCalendarFeed). When no
// grant is connected the feed is simply absent and the view is purely
// local-first. Provider write-back (creating/editing events on the connected
// account from this surface) is a follow-up.
//
// The natural-language quick-add row remains inert chrome: there is no
// frontend-callable calendar NLP parser, so the row is rendered disabled rather
// than as a dead control that silently drops input.

import "@elizaos/plugin-calendar/api/client-calendar";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";
import { client } from "@elizaos/ui";
import {
  ArrowLeft,
  ArrowRight,
  Settings as Cog,
  Download,
  Minus,
  Plus,
  RefreshCw,
  Search,
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

// Representative local calendar — the zero-state odysseus ships before any
// CalDAV sync or .ics import. A SINGLE calendar by default so the filter chip
// row + "± tags" toggle stay hidden (odysseus only renders them when
// `_calendars.length > 1`, calendar.js:819), matching the captured frame.
// Coloured from CAL_PALETTE, not real agent data; the user can add more from
// Calendar Settings, at which point the filter row appears.
const DEFAULT_CALENDARS: LocalCalendar[] = [
  { href: "local/personal", name: "Personal", color: CAL_PALETTE[0] },
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

// odysseus calendar/utils.js `_calReadableTextColor` (+ `_hexToRgb`,
// `_relativeLuminance`, `_contrastRatio`). Given an event's background colour,
// pick a foreground (near-black ink or white) with the better WCAG contrast so
// chip text stays legible on any calendar colour. Non-hex backgrounds (e.g. the
// `var(--accent)` palette slot) aren't parseable, so we defer to the theme `fg`.
function hexToRgb(c: string): { r: number; g: number; b: number } | null {
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const hex =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : m[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function relativeLuminance({
  r,
  g,
  b,
}: {
  r: number;
  g: number;
  b: number;
}): number {
  const coeff = [0.2126, 0.7152, 0.0722];
  return [r, g, b]
    .map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, c, i) => sum + c * coeff[i], 0);
}

function contrastRatio(a: number, b: number): number {
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

function readableTextColor(bg: string): string {
  const rgb = hexToRgb(bg);
  if (!rgb) return "var(--fg)";
  const lum = relativeLuminance(rgb);
  const white = contrastRatio(lum, 1);
  const ink = contrastRatio(lum, 0.006);
  return ink >= white ? "#111820" : "#ffffff";
}

function newUid(): string {
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Provider-overlay layer: read-only calendars + events sourced from the
// connected account feed (Google / Apple via @elizaos/plugin-calendar). Their
// `href` / `uid` carry this prefix so the render paths can mix them with local
// items while the write paths (create/edit/delete, settings CRUD, .ics) skip
// them. Format: `provider:<provider>:<grantId>:<calendarId>` (calendars) and
// `provider:<eventId>` (events).
const PROVIDER_PREFIX = "provider:";

function isProviderRef(ref: string): boolean {
  return ref.startsWith(PROVIDER_PREFIX);
}

function providerCalendarHref(
  provider: string,
  grantId: string,
  calendarId: string,
): string {
  return `${PROVIDER_PREFIX}${provider}:${grantId}:${calendarId}`;
}

// `HH:MM` 24h local wall-clock from an ISO timestamp; empty for all-day events.
function isoToLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
  // Day-detail global search (calendar.js `_searchQuery`). When non-empty, the
  // day-detail body lists every matching event (summary/description/location)
  // instead of just the selected day's events.
  const [searchQuery, setSearchQuery] = useState("");
  // "± tags" filter-row collapse (calendar.js `_filtersCollapsed`). Only
  // surfaces once there is >1 calendar; default expanded like odysseus.
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  // Local-first persisted state — calendars + events both live in localStorage
  // (see file header). `version` bumps when the user hits Refresh, forcing a
  // re-read from storage so an external edit/import in another tab is picked up.
  const [calendars, setCalendars] = useState<LocalCalendar[]>(() =>
    readPref<LocalCalendar[]>(CAL_PREF_KEY, DEFAULT_CALENDARS),
  );
  const [events, setEvents] = useState<CalEvent[]>(() =>
    readPref<CalEvent[]>(EVENTS_PREF_KEY, []),
  );
  // Read-only provider overlay (Google / Apple via @elizaos/plugin-calendar).
  // Never persisted to localStorage — refetched from the agent feed on open and
  // on Refresh. `providerStatus` is "unavailable" when no calendar grant is
  // connected (the normal local-only case), "connected" once a feed loads.
  const [providerCalendars, setProviderCalendars] = useState<LocalCalendar[]>(
    [],
  );
  const [providerEvents, setProviderEvents] = useState<CalEvent[]>([]);
  const [providerStatus, setProviderStatus] = useState<
    "idle" | "loading" | "connected" | "unavailable"
  >("idle");
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
  // Bumped by Refresh to re-run the provider-feed fetch (the local store is
  // re-read synchronously in doRefresh; the feed is async).
  const [refreshTick, setRefreshTick] = useState(0);
  // The pending sync-spin timer, cleared on unmount so the cosmetic
  // setSyncing(false) never fires after the view is gone.
  const syncTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(
    null,
  );

  const win = useWindowControls(
    "win-calendar",
    { w: 720, h: 620 },
    { label: "Calendar", icon: "CalendarDays", onClose },
  );

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
      if (searchQuery) {
        setSearchQuery("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, settingsOpen, formState, searchQuery]);

  // Clear the pending sync-spin timer on unmount.
  useEffect(
    () => () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
    },
    [],
  );

  // Fetch the read-only provider feed (Google / Apple) when the view opens and
  // whenever Refresh fires. No calendar grant connected is the expected state:
  // the feed call rejects (401/403/409/"not connected"), and we silently fall
  // back to a purely local-first calendar. Only genuinely unexpected failures
  // are swallowed without a connected feed — there is no structured logger in
  // this browser file, so the expected case stays silent by design.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProviderStatus("loading");

    const margin = 24 * 60 * 60 * 1000;
    const center = current.getTime();
    const timeMin = new Date(center - 60 * margin).toISOString();
    const timeMax = new Date(center + 120 * margin).toISOString();

    (async () => {
      try {
        const [{ calendars: summaries }, feed] = await Promise.all([
          client.getLifeOpsCalendars(),
          client.getLifeOpsCalendarFeed({ timeMin, timeMax }),
        ]);
        if (cancelled) return;

        const mappedCalendars: LocalCalendar[] = summaries.map(
          (s: LifeOpsCalendarSummary, i) => ({
            href: providerCalendarHref(s.provider, s.grantId, s.calendarId),
            name: s.summary,
            color:
              s.backgroundColor || CAL_PALETTE[(i + 1) % CAL_PALETTE.length],
          }),
        );
        const calendarHrefs = new Set(mappedCalendars.map((c) => c.href));

        const mappedEvents: CalEvent[] = [];
        for (const ev of feed.events as LifeOpsCalendarEvent[]) {
          const href = providerCalendarHref(
            ev.provider,
            ev.grantId ?? "",
            ev.calendarId,
          );
          // The feed can carry events whose calendar is not in the summary list
          // (e.g. shared/holiday calendars); synthesize a labelled chip for them
          // so they still render and remain toggleable.
          if (!calendarHrefs.has(href)) {
            calendarHrefs.add(href);
            mappedCalendars.push({
              href,
              name: ev.calendarSummary || ev.calendarId,
              color:
                CAL_PALETTE[(mappedCalendars.length + 1) % CAL_PALETTE.length],
            });
          }
          mappedEvents.push({
            uid: `${PROVIDER_PREFIX}${ev.id}`,
            summary: ev.title,
            calendarHref: href,
            date: ymd(new Date(ev.startAt)),
            endDate: ymd(new Date(ev.endAt)),
            startTime: ev.isAllDay ? "" : isoToLocalTime(ev.startAt),
            endTime: ev.isAllDay ? "" : isoToLocalTime(ev.endAt),
            allDay: ev.isAllDay,
            location: ev.location ?? "",
            description: ev.description ?? "",
            rrule: "",
          });
        }

        setProviderCalendars(mappedCalendars);
        setProviderEvents(mappedEvents);
        setProviderStatus("connected");
      } catch {
        // Expected when no Google/Apple calendar grant is connected, and the
        // safe fallback for any unexpected error: no provider overlay, pure
        // local-first calendar. Intentionally silent (no logger in this view).
        if (cancelled) return;
        setProviderCalendars([]);
        setProviderEvents([]);
        setProviderStatus("unavailable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, current, refreshTick]);

  const today = ymd(new Date());
  const year = current.getFullYear();
  const month = current.getMonth();

  // Render layers: local-first store + read-only provider overlay merged for
  // display only. WRITE paths (create/edit/delete, settings CRUD, .ics
  // import/export, persistEvents/persistCalendars) keep operating on the local
  // `calendars` / `events` arrays — never these merged views.
  const displayCalendars = useMemo(
    () => [...calendars, ...providerCalendars],
    [calendars, providerCalendars],
  );
  const displayEvents = useMemo(
    () => [...events, ...providerEvents],
    [events, providerEvents],
  );

  const eventVisible = useCallback(
    (e: CalEvent): boolean => !hiddenCals.has(e.calendarHref),
    [hiddenCals],
  );
  const visibleEvents = useMemo(
    () => displayEvents.filter(eventVisible),
    [displayEvents, eventVisible],
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
  if (win.minimized) return null;

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
    setRefreshTick((t) => t + 1);
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
  // Provider events are read-only: opening the edit form would expose Save /
  // Delete against a feed this surface cannot write back to, so clicking one is
  // a no-op (the row also renders a "synced" badge instead of the more-menu).
  const openEdit = (ev: CalEvent) => {
    if (isProviderRef(ev.uid)) return;
    setFormState({ existing: ev, date: ev.date });
  };

  const showFilters = displayCalendars.length > 1;

  // ── Toolbar (shared across views) ───────────────────────────────────────
  const titleText =
    view === "agenda"
      ? "Upcoming"
      : view === "year"
        ? String(year)
        : `${MONTHS[month]} ${year}`;
  const weekSuffix = view === "week" ? ` · W${isoWeekNumber(current)}` : "";

  const toolbar = (
    <div className="od-cal-toolbar">
      <div className="od-cal-toolbar-nav">
        <button
          type="button"
          className="od-cal-nav"
          onClick={() => shiftPeriod(-1)}
          aria-label="Previous"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          className="od-cal-nav od-cal-today-btn"
          onClick={goToday}
        >
          Today
        </button>
        <span className="od-cal-period-title">
          {titleText}
          {weekSuffix}
        </span>
        <button
          type="button"
          className="od-cal-nav"
          onClick={() => shiftPeriod(1)}
          aria-label="Next"
        >
          <ArrowRight size={13} />
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
        {showFilters ? (
          <button
            type="button"
            className="od-cal-filter-toggle"
            title={filtersCollapsed ? "Show filters" : "Hide filters"}
            onClick={() => setFiltersCollapsed((c) => !c)}
          >
            {filtersCollapsed ? "+ tags" : "− tags"}
          </button>
        ) : null}
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

  // ── Window titlebar (calendar.js .modal-header, line 573) ────────────────
  // The draggable window chrome: calendar glyph + accent "Calendar" wordmark on
  // the left, minimize ("—") + close on the right. Minimize hides the panel and
  // surfaces a dock chip via the shell WindowManager (see useWindowControls).
  const windowHeader = (
    <div className="od-cal-window-header" onPointerDown={win.onDragStart}>
      <h4 className="od-cal-title">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span>Calendar</span>
      </h4>
      <button
        type="button"
        className="od-window-min-btn"
        onClick={win.minimize}
        title="Minimize"
        aria-label="Minimize"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="od-cal-window-close"
        aria-label="Close calendar"
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </div>
  );

  // ── Quick-add row (calendar.js line 803) ─────────────────────────────────
  // odysseus parses natural language here via /api/calendar/quick-parse, which
  // eliza has no client method for (see file header). We render the row for 1:1
  // chrome with its accent "Quick add" hint overlay, but as an honest inert
  // input — disabled with a title explaining the parser is unavailable locally,
  // so it never pretends to accept input it cannot understand.
  const quickAddRow = (
    <div className="od-cal-quickadd-row">
      <input
        type="text"
        className="od-cal-quickadd-input"
        placeholder=" "
        autoComplete="off"
        disabled
        title="Natural-language quick add needs a calendar parser backend (unavailable locally)"
        aria-label="Quick add event (unavailable)"
      />
      <span className="od-cal-quickadd-hint" aria-hidden="true">
        <span className="od-cal-qa-accent">Quick add</span> — return home to
        Ithaca 1pm tmrw{" "}
        <svg
          className="od-cal-qa-enter"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 10 4 15 9 20" />
          <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </svg>
      </span>
    </div>
  );

  const filterRow =
    showFilters && !filtersCollapsed ? (
      <div className="od-cal-filters">
        {displayCalendars.map((c) => {
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
                      style={{ background: calColor(ev, displayCalendars) }}
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
                {allDayEvents.map((ev) => {
                  const bg = calColor(ev, displayCalendars);
                  return (
                    <button
                      type="button"
                      className="od-cal-wk-allday-event"
                      key={ev.uid}
                      style={{ background: bg, color: readableTextColor(bg) }}
                      title={ev.summary}
                      onClick={() => openEdit(ev)}
                    >
                      {ev.summary}
                    </button>
                  );
                })}
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
                        background: `color-mix(in srgb, ${calColor(ev, displayCalendars)} 22%, var(--bg))`,
                        borderLeftColor: calColor(ev, displayCalendars),
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
                      style={{ background: calColor(ev, displayCalendars) }}
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
  // Global search across all visible events (calendar.js:1722-1751). When the
  // in-panel search has text, the day body lists every matching event instead
  // of the selected day's events.
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchResults = trimmedQuery
    ? visibleEvents
        .filter(
          (e) =>
            e.summary.toLowerCase().includes(trimmedQuery) ||
            e.description.toLowerCase().includes(trimmedQuery) ||
            e.location.toLowerCase().includes(trimmedQuery),
        )
        .sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return (a.startTime || "").localeCompare(b.startTime || "");
        })
    : [];

  const renderEventRow = (ev: CalEvent, withDate: boolean): ReactNode => {
    const readOnly = isProviderRef(ev.uid);
    return (
      <div className="od-cal-event-item" key={ev.uid}>
        <span
          className="od-cal-event-dot"
          style={{ background: calColor(ev, displayCalendars) }}
        />
        <button
          type="button"
          className="od-cal-event-info od-cal-event-info-btn"
          onClick={() => openEdit(ev)}
          disabled={readOnly}
        >
          <div className="od-cal-event-name">{ev.summary}</div>
          <div className="od-cal-event-time">
            {withDate ? `${fmtLongDate(ev.date)} · ` : ""}
            {ev.allDay
              ? "All day"
              : `${fmtClock(ev.startTime)} – ${fmtClock(ev.endTime)}`}
            {ev.location ? ` · ${ev.location}` : ""}
          </div>
        </button>
        {readOnly ? (
          <span
            className="od-cal-event-readonly"
            title="Synced from a connected calendar — read-only here"
          >
            synced
          </span>
        ) : (
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
        )}
      </div>
    );
  };

  const dayDetail =
    view === "month" || view === "week" ? (
      <>
        {/* Decorative grip divider (calendar.js .cal-splitter). Drag-to-resize
            needs the host window manager; here it is a faithful static divider
            between the grid and the day-detail, so it carries no interactive
            role. */}
        <div className="od-cal-splitter" aria-hidden="true">
          <div className="od-cal-splitter-grip" />
        </div>
        <div className="od-cal-day-detail">
          <div className="od-cal-search-wrap">
            <Search
              size={13}
              className="od-cal-search-icon"
              aria-hidden="true"
            />
            <input
              type="search"
              className="od-cal-search-input"
              placeholder="Search all events…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search all events"
            />
          </div>
          <div className="od-cal-detail-header">
            <span>
              {fmtLongDate(selectedDay)}
              {selectedDay === today ? (
                <span className="od-cal-detail-today"> (Today)</span>
              ) : null}
            </span>
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
          {trimmedQuery ? (
            <>
              <div className="od-cal-day-search-meta">
                {searchResults.length} result
                {searchResults.length === 1 ? "" : "s"}
              </div>
              {searchResults.length === 0 ? (
                <div className="od-cal-empty">No events match</div>
              ) : (
                searchResults.map((ev) => renderEventRow(ev, true))
              )}
            </>
          ) : detailEvents.length === 0 ? (
            <div className="od-cal-empty">No events</div>
          ) : (
            detailEvents.map((ev) => renderEventRow(ev, false))
          )}
        </div>
      </>
    ) : null;

  const hasCalendars = displayCalendars.length > 0;

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
      <div
        className="od-search-panel od-cal-panel"
        style={win.panelStyle}
        data-provider-status={providerStatus}
      >
        <ResizeHandles controls={win} />
        {windowHeader}
        <div className="od-cal-body">
          {!hasCalendars ? (
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
              {quickAddRow}
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
