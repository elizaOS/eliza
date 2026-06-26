import { AgentButton, useAgentElement } from "@elizaos/ui/agent-surface";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Settings,
  StickyNote,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { interact } from "./simple-views.interact.js";
import {
  applySimpleViewsSnapshot,
  isSimpleViewsSnapshot,
  normalizeDateKey,
  readSelectedDate,
  SIMPLE_VIEWS_EVENT,
  type SimpleCalendarEvent,
  type SimpleViewsSnapshot,
  type StickyColor,
  type StickyNote as StickyNoteModel,
  simpleViewsSnapshot,
  todayDateKey,
} from "./storage.js";

const COLORS: StickyColor[] = ["yellow", "green", "rose", "slate"];

const NOTE_COLORS: Record<StickyColor, CSSProperties> = {
  yellow: { background: "#fff5bf", borderColor: "#d9b84b" },
  green: { background: "#dff6df", borderColor: "#7dbb77" },
  rose: { background: "#ffe4ec", borderColor: "#d991aa" },
  slate: { background: "#e8edf2", borderColor: "#9aa8b5" },
};

const EVENT_DOTS: Record<StickyColor, string> = {
  yellow: "#b88719",
  green: "#2f7d46",
  rose: "#b84065",
  slate: "#586879",
};

const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "100%",
  color: "#15171c",
  background: "#f6f7f4",
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: "18px 20px 14px",
  borderBottom: "1px solid #dde1d8",
  background: "#ffffff",
};

const titleWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const iconBoxStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 34,
  height: 34,
  border: "1px solid #d6dbd2",
  borderRadius: 8,
  background: "#f2f4ef",
  color: "#263326",
};

const h1Style: CSSProperties = {
  margin: 0,
  fontSize: 20,
  lineHeight: "26px",
  fontWeight: 700,
  letterSpacing: 0,
};

const subTextStyle: CSSProperties = {
  margin: 0,
  color: "#60695d",
  fontSize: 13,
  lineHeight: "18px",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  justifyContent: "flex-end",
};

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 34,
  border: "1px solid #c9d0c4",
  borderRadius: 8,
  padding: "0 12px",
  background: "#ffffff",
  color: "#1f271e",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const iconButtonStyle: CSSProperties = {
  ...buttonStyle,
  width: 34,
  padding: 0,
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#476b3b",
  background: "#476b3b",
  color: "#ffffff",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  minHeight: 36,
  border: "1px solid #c9d0c4",
  borderRadius: 8,
  padding: "8px 10px",
  background: "#ffffff",
  color: "#15171c",
  font: "inherit",
  fontSize: 14,
  lineHeight: "20px",
  boxSizing: "border-box",
};

const panelStyle: CSSProperties = {
  border: "1px solid #dde1d8",
  borderRadius: 8,
  background: "#ffffff",
};

async function fetchSimpleViewsSnapshot(): Promise<SimpleViewsSnapshot | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch("/api/simple-views/state", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return isSimpleViewsSnapshot(body) ? body : null;
  } catch {
    return null;
  }
}

async function callSimpleViewsCapability(
  capability: string,
  params?: Record<string, unknown>,
): Promise<void> {
  if (typeof fetch === "function") {
    try {
      const response = await fetch("/api/simple-views/interact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ capability, params }),
      });
      if (response.ok) {
        const body = (await response.json()) as unknown;
        if (
          body &&
          typeof body === "object" &&
          "state" in body &&
          isSimpleViewsSnapshot((body as { state: unknown }).state)
        ) {
          applySimpleViewsSnapshot(
            (body as { state: SimpleViewsSnapshot }).state,
          );
          return;
        }
      }
    } catch {
      // Fall back to local storage below when the optional backend is absent.
    }
  }

  await interact(capability, params);
}

function useSimpleViewsSnapshot(): SimpleViewsSnapshot {
  const [snapshot, setSnapshot] = useState(() => simpleViewsSnapshot());

  useEffect(() => {
    const refresh = () => setSnapshot(simpleViewsSnapshot());
    const onStorage = () => refresh();
    const onUpdate = () => refresh();
    const onSharedViewEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: unknown }>).detail;
      if (
        detail?.type === "simple-views:update" ||
        detail?.type === "view:notes:updated" ||
        detail?.type === "view:simple-calendar:updated"
      ) {
        refresh();
      }
    };

    window.addEventListener(SIMPLE_VIEWS_EVENT, onUpdate);
    window.addEventListener("storage", onStorage);
    window.addEventListener("elizaos-view-event", onSharedViewEvent);
    void fetchSimpleViewsSnapshot().then((next) => {
      if (next) {
        applySimpleViewsSnapshot(next, { preserveLocalDataOnEmpty: true });
        refresh();
      }
    });
    return () => {
      window.removeEventListener(SIMPLE_VIEWS_EVENT, onUpdate);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("elizaos-view-event", onSharedViewEvent);
    };
  }, []);

  return snapshot;
}

interface AgentTextInputProps {
  id: string;
  label: string;
  value: string;
  onFill: (value: string) => void;
  group: string;
  placeholder?: string;
  style?: CSSProperties;
}

function AgentTextInput({
  id,
  label,
  value,
  onFill,
  group,
  placeholder,
  style,
}: AgentTextInputProps) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id,
    label,
    role: "text-input",
    group,
    fillable: true,
    getValue: () => value,
    onFill,
  });
  return (
    <input
      ref={ref}
      aria-label={label}
      {...agentProps}
      value={value}
      onChange={(event) => onFill(event.target.value)}
      placeholder={placeholder}
      style={{ ...fieldStyle, ...style }}
    />
  );
}

function AgentTextarea({
  id,
  label,
  value,
  onFill,
  group,
}: AgentTextInputProps) {
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id,
    label,
    role: "textarea",
    group,
    fillable: true,
    getValue: () => value,
    onFill,
  });
  return (
    <textarea
      ref={ref}
      aria-label={label}
      {...agentProps}
      value={value}
      onChange={(event) => onFill(event.target.value)}
      rows={5}
      style={{ ...fieldStyle, minHeight: 112, resize: "vertical" }}
    />
  );
}

function openSettings(): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", "/settings");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function NoteCard({
  note,
  onDelete,
}: {
  note: StickyNoteModel;
  onDelete: (id: string) => void;
}) {
  const cardElement = useAgentElement<HTMLDivElement>({
    id: `note-card-${note.id}`,
    label: `Note: ${note.title}`,
    role: "card",
    group: "notes-list",
    description: note.body,
    status: note.color,
  });
  const deleteElement = useAgentElement<HTMLButtonElement>({
    id: `delete-note-${note.id}`,
    label: `Delete note ${note.title}`,
    role: "button",
    group: "notes-list",
    onActivate: () => onDelete(note.id),
  });

  return (
    <div
      ref={cardElement.ref}
      {...cardElement.agentProps}
      style={{
        ...NOTE_COLORS[note.color],
        minHeight: 180,
        border: "1px solid",
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxShadow: "0 8px 20px rgba(31, 39, 30, 0.08)",
      }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: 10 }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            lineHeight: "22px",
            fontWeight: 700,
            overflowWrap: "anywhere",
          }}
        >
          {note.title}
        </h2>
        <button
          ref={deleteElement.ref}
          type="button"
          {...deleteElement.agentProps}
          onClick={() => onDelete(note.id)}
          style={{
            ...iconButtonStyle,
            width: 30,
            height: 30,
            minHeight: 30,
            background: "rgba(255,255,255,0.68)",
          }}
          title="Delete note"
        >
          <Trash2 size={16} aria-hidden />
        </button>
      </div>
      <p
        style={{
          margin: 0,
          color: "#253025",
          fontSize: 14,
          lineHeight: "21px",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {note.body}
      </p>
    </div>
  );
}

export function NotesView() {
  const { notes } = useSimpleViewsSnapshot();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [color, setColor] = useState<StickyColor>("yellow");
  const titleRef = useRef(title);
  const bodyRef = useRef(body);

  const setTitleValue = useCallback((value: string) => {
    titleRef.current = value;
    setTitle(value);
  }, []);

  const setBodyValue = useCallback((value: string) => {
    bodyRef.current = value;
    setBody(value);
  }, []);

  const addNote = useCallback(async () => {
    const nextTitle = titleRef.current.trim();
    const nextBody = bodyRef.current.trim();
    if (!nextTitle && !nextBody) return;
    await callSimpleViewsCapability("create-note", {
      title: nextTitle || "Untitled",
      body: nextBody || "New note",
      color,
    });
    setTitleValue("");
    setBodyValue("");
  }, [color, setBodyValue, setTitleValue]);

  const deleteNote = useCallback((id: string) => {
    void callSimpleViewsCapability("delete-note", { id });
  }, []);

  const clearNotes = useCallback(() => {
    void callSimpleViewsCapability("clear-notes");
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void addNote();
  };

  return (
    <main data-testid="simple-notes-view" style={shellStyle}>
      <header style={headerStyle}>
        <div style={titleWrapStyle}>
          <div style={iconBoxStyle}>
            <StickyNote size={18} aria-hidden />
          </div>
          <div>
            <h1 style={h1Style}>Notes</h1>
            <p style={subTextStyle}>{notes.length} sticky notes</p>
          </div>
        </div>
        <div style={toolbarStyle}>
          <AgentButton
            agentId="notes-clear"
            agentLabel="Clear notes"
            onClick={clearNotes}
            style={buttonStyle}
          >
            Clear
          </AgentButton>
          <AgentButton
            agentId="notes-open-settings"
            agentLabel="Open settings"
            onClick={openSettings}
            style={iconButtonStyle}
            title="Open settings"
          >
            <Settings size={16} aria-hidden />
          </AgentButton>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
          gap: 18,
          padding: 20,
          alignItems: "start",
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            ...panelStyle,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: 16,
          }}
        >
          <AgentTextInput
            id="note-title"
            label="Note title"
            value={title}
            onFill={setTitleValue}
            placeholder="Title"
            group="note-compose"
          />
          <AgentTextarea
            id="note-body"
            label="Note body"
            value={body}
            onFill={setBodyValue}
            group="note-compose"
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {COLORS.map((option) => (
              <AgentButton
                key={option}
                agentId={`note-color-${option}`}
                agentLabel={`Set note color ${option}`}
                agentRole="toggle"
                agentStatus={color === option ? "active" : undefined}
                onClick={() => setColor(option)}
                style={{
                  ...buttonStyle,
                  background: NOTE_COLORS[option].background,
                  borderColor:
                    color === option
                      ? "#15171c"
                      : NOTE_COLORS[option].borderColor,
                  minWidth: 72,
                  textTransform: "capitalize",
                }}
              >
                {option}
              </AgentButton>
            ))}
          </div>
          <AgentButton
            agentId="add-note"
            agentLabel="Add note"
            onClick={addNote}
            style={primaryButtonStyle}
          >
            <Plus size={16} aria-hidden />
            Add note
          </AgentButton>
        </form>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 16,
          }}
          aria-label="Sticky note wall"
        >
          {notes.map((note) => (
            <NoteCard key={note.id} note={note} onDelete={deleteNote} />
          ))}
        </section>
      </div>
    </main>
  );
}

function dateKey(date: Date): string {
  return todayDateKey(date);
}

function parseDateKey(value: string): Date {
  const normalized = normalizeDateKey(value) ?? todayDateKey();
  const [year, month, day] = normalized.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day));
}

function monthLabel(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, amount: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1),
  );
}

function buildCalendarDays(cursor: Date): Date[] {
  const monthStart = startOfMonth(cursor);
  const startOffset = monthStart.getUTCDay();
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(monthStart.getUTCDate() - startOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setUTCDate(gridStart.getUTCDate() + index);
    return day;
  });
}

function eventsForDate(
  events: SimpleCalendarEvent[],
  date: string,
): SimpleCalendarEvent[] {
  return events
    .filter((event) => event.date === date)
    .toSorted((a, b) =>
      `${a.time} ${a.title}`.localeCompare(`${b.time} ${b.title}`),
    );
}

function CalendarDayButton({
  day,
  selectedDate,
  cursorMonth,
  events,
  onSelect,
}: {
  day: Date;
  selectedDate: string;
  cursorMonth: number;
  events: SimpleCalendarEvent[];
  onSelect: (date: string) => void;
}) {
  const key = dateKey(day);
  const isSelected = key === selectedDate;
  const inMonth = day.getUTCMonth() === cursorMonth;
  const dayEvents = eventsForDate(events, key);
  const dayElement = useAgentElement<HTMLButtonElement>({
    id: `calendar-day-${key}`,
    label: `Select ${key}`,
    role: "button",
    group: "simple-calendar-grid",
    description:
      dayEvents.length > 0
        ? `${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`
        : "No events",
    status: isSelected
      ? "selected"
      : inMonth
        ? "current-month"
        : "outside-month",
    onActivate: () => onSelect(key),
  });

  return (
    <button
      ref={dayElement.ref}
      type="button"
      {...dayElement.agentProps}
      onClick={() => onSelect(key)}
      style={{
        minWidth: 0,
        minHeight: 78,
        border: isSelected ? "2px solid #476b3b" : "1px solid #dde1d8",
        borderRadius: 8,
        padding: 6,
        background: inMonth ? "#ffffff" : "#eef1eb",
        color: inMonth ? "#15171c" : "#687264",
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 13 }}>{day.getUTCDate()}</span>
      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {dayEvents.slice(0, 4).map((event) => (
          <span
            key={event.id}
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: EVENT_DOTS[event.color],
            }}
          />
        ))}
      </span>
      {dayEvents[0] ? (
        <span
          style={{
            fontSize: 11,
            lineHeight: "15px",
            color: "#505b4d",
            overflowWrap: "anywhere",
          }}
        >
          {dayEvents[0].title}
        </span>
      ) : null}
    </button>
  );
}

function EventRow({
  event,
  onDelete,
}: {
  event: SimpleCalendarEvent;
  onDelete: (id: string) => void;
}) {
  const rowElement = useAgentElement<HTMLDivElement>({
    id: `calendar-event-${event.id}`,
    label: `Event: ${event.title}`,
    role: "card",
    group: "simple-calendar-events",
    description: `${event.date} ${event.time}. ${event.notes}`,
    status: event.color,
  });
  const deleteElement = useAgentElement<HTMLButtonElement>({
    id: `delete-calendar-event-${event.id}`,
    label: `Delete calendar event ${event.title}`,
    role: "button",
    group: "simple-calendar-events",
    onActivate: () => onDelete(event.id),
  });

  return (
    <div
      ref={rowElement.ref}
      {...rowElement.agentProps}
      style={{
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) 32px",
        gap: 10,
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid #ecefe9",
      }}
    >
      <span
        style={{
          width: 8,
          height: 34,
          borderRadius: 999,
          background: EVENT_DOTS[event.color],
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: 14,
            lineHeight: "20px",
            overflowWrap: "anywhere",
          }}
        >
          {event.time} - {event.title}
        </div>
        {event.notes ? (
          <div
            style={{
              color: "#60695d",
              fontSize: 12,
              lineHeight: "17px",
              overflowWrap: "anywhere",
            }}
          >
            {event.notes}
          </div>
        ) : null}
      </div>
      <button
        ref={deleteElement.ref}
        type="button"
        {...deleteElement.agentProps}
        onClick={() => onDelete(event.id)}
        style={iconButtonStyle}
        title="Delete event"
      >
        <Trash2 size={16} aria-hidden />
      </button>
    </div>
  );
}

export function SimpleCalendarView() {
  const snapshot = useSimpleViewsSnapshot();
  const [selectedDate, setSelectedDate] = useState(() => readSelectedDate());
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("09:00");
  const [notes, setNotes] = useState("");
  const [color, setColor] = useState<StickyColor>("green");
  const selectedDateRef = useRef(selectedDate);
  const titleRef = useRef(title);
  const timeRef = useRef(time);
  const notesRef = useRef(notes);
  const colorRef = useRef(color);

  useEffect(() => {
    selectedDateRef.current = snapshot.selectedDate;
    setSelectedDate(snapshot.selectedDate);
  }, [snapshot.selectedDate]);

  const setTitleValue = useCallback((value: string) => {
    titleRef.current = value;
    setTitle(value);
  }, []);

  const setTimeValue = useCallback((value: string) => {
    timeRef.current = value;
    setTime(value);
  }, []);

  const setNotesValue = useCallback((value: string) => {
    notesRef.current = value;
    setNotes(value);
  }, []);

  const setColorValue = useCallback((value: StickyColor) => {
    colorRef.current = value;
    setColor(value);
  }, []);

  const cursor = useMemo(
    () => startOfMonth(parseDateKey(selectedDate)),
    [selectedDate],
  );
  const days = useMemo(() => buildCalendarDays(cursor), [cursor]);
  const selectedEvents = useMemo(
    () => eventsForDate(snapshot.events, selectedDate),
    [snapshot.events, selectedDate],
  );

  const selectDate = useCallback((date: string) => {
    const normalizedDate = normalizeDateKey(date);
    if (!normalizedDate) return;
    selectedDateRef.current = normalizedDate;
    setSelectedDate(normalizedDate);
    void callSimpleViewsCapability("select-calendar-date", {
      date: normalizedDate,
    });
  }, []);

  const moveMonth = useCallback(
    (amount: number) => {
      selectDate(dateKey(addMonths(cursor, amount)));
    },
    [cursor, selectDate],
  );

  const selectToday = useCallback(() => {
    selectDate(dateKey(new Date()));
  }, [selectDate]);

  const addEvent = useCallback(async () => {
    const eventTitle = titleRef.current.trim();
    if (!eventTitle) return;
    await callSimpleViewsCapability("create-calendar-event", {
      title: eventTitle,
      date: selectedDateRef.current,
      time: timeRef.current || "09:00",
      notes: notesRef.current.trim(),
      color: colorRef.current,
    });
    setTitleValue("");
    setNotesValue("");
  }, [setNotesValue, setTitleValue]);

  const deleteEvent = useCallback((id: string) => {
    void callSimpleViewsCapability("delete-calendar-event", { id });
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void addEvent();
  };

  return (
    <main data-testid="simple-calendar-view" style={shellStyle}>
      <header style={headerStyle}>
        <div style={titleWrapStyle}>
          <div style={iconBoxStyle}>
            <CalendarDays size={18} aria-hidden />
          </div>
          <div>
            <h1 style={h1Style}>Simple Calendar</h1>
            <p style={subTextStyle}>
              {monthLabel(cursor)} - {snapshot.events.length} events
            </p>
          </div>
        </div>
        <div style={toolbarStyle}>
          <AgentButton
            agentId="calendar-prev-month"
            agentLabel="Previous month"
            onClick={() => moveMonth(-1)}
            style={iconButtonStyle}
            title="Previous month"
          >
            <ChevronLeft size={16} aria-hidden />
          </AgentButton>
          <AgentButton
            agentId="calendar-today"
            agentLabel="Go to today"
            onClick={selectToday}
            style={buttonStyle}
          >
            Today
          </AgentButton>
          <AgentButton
            agentId="calendar-next-month"
            agentLabel="Next month"
            onClick={() => moveMonth(1)}
            style={iconButtonStyle}
            title="Next month"
          >
            <ChevronRight size={16} aria-hidden />
          </AgentButton>
          <AgentButton
            agentId="calendar-open-settings"
            agentLabel="Open settings"
            onClick={openSettings}
            style={iconButtonStyle}
            title="Open settings"
          >
            <Settings size={16} aria-hidden />
          </AgentButton>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          gap: 18,
          padding: 20,
          alignItems: "start",
        }}
      >
        <section style={{ ...panelStyle, padding: 14 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gap: 8,
              marginBottom: 8,
              color: "#60695d",
              fontSize: 12,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div key={day}>{day}</div>
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gap: 8,
            }}
          >
            {days.map((day) => (
              <CalendarDayButton
                key={dateKey(day)}
                day={day}
                selectedDate={selectedDate}
                cursorMonth={cursor.getUTCMonth()}
                events={snapshot.events}
                onSelect={selectDate}
              />
            ))}
          </div>
        </section>

        <aside
          style={{
            ...panelStyle,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: 16,
          }}
        >
          <div>
            <h2 style={{ ...h1Style, fontSize: 17, lineHeight: "23px" }}>
              {selectedDate}
            </h2>
            <p style={subTextStyle}>
              {selectedEvents.length} event
              {selectedEvents.length === 1 ? "" : "s"}
            </p>
          </div>

          <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
            <AgentTextInput
              id="calendar-event-title"
              label="Calendar event title"
              value={title}
              onFill={setTitleValue}
              placeholder="Event title"
              group="simple-calendar-compose"
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(88px, 112px)",
                gap: 8,
              }}
            >
              <AgentTextInput
                id="calendar-event-date"
                label="Calendar event date"
                value={selectedDate}
                onFill={selectDate}
                group="simple-calendar-compose"
              />
              <AgentTextInput
                id="calendar-event-time"
                label="Calendar event time"
                value={time}
                onFill={setTimeValue}
                group="simple-calendar-compose"
              />
            </div>
            <AgentTextarea
              id="calendar-event-notes"
              label="Calendar event notes"
              value={notes}
              onFill={setNotesValue}
              group="simple-calendar-compose"
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {COLORS.map((option) => (
                <AgentButton
                  key={option}
                  agentId={`calendar-event-color-${option}`}
                  agentLabel={`Set calendar event color ${option}`}
                  agentRole="toggle"
                  agentStatus={color === option ? "active" : undefined}
                  onClick={() => setColorValue(option)}
                  style={{
                    ...buttonStyle,
                    background: NOTE_COLORS[option].background,
                    borderColor:
                      color === option
                        ? "#15171c"
                        : NOTE_COLORS[option].borderColor,
                    minWidth: 72,
                    textTransform: "capitalize",
                  }}
                >
                  {option}
                </AgentButton>
              ))}
            </div>
            <AgentButton
              agentId="add-calendar-event"
              agentLabel="Add calendar event"
              onClick={addEvent}
              style={primaryButtonStyle}
            >
              <Plus size={16} aria-hidden />
              Add event
            </AgentButton>
          </form>

          <div>
            {selectedEvents.map((event) => (
              <EventRow key={event.id} event={event} onDelete={deleteEvent} />
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
