import type { ReactElement } from "react";
import { useMemo } from "react";

import { CalendarClock, CheckCircle2, Clock3, Inbox } from "lucide-react";

import type { Todo } from "../../types.js";

/**
 * TodosView — three-lane todo board.
 *
 * Lanes:
 *  - Today    — pending / in_progress todos whose due date is today (or overdue).
 *  - Upcoming — pending / in_progress todos with a future due date.
 *  - Someday  — pending / in_progress todos with no due date.
 *
 * MIGRATION STATUS: SCAFFOLD.
 * Reference implementation: plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts
 * (the OWNER_TODOS surface). Filtering, drag-and-drop reordering, completion
 * toggles, and the per-row detail drawer will be ported in a follow-up pass.
 * For now this renders the three-lane layout so the view registers, mounts,
 * and is visually identifiable.
 */

export interface TodosViewProps {
  todos?: Todo[];
}

interface LaneDef {
  id: "today" | "upcoming" | "someday";
  label: string;
  description: string;
  Icon: typeof Inbox;
}

const LANES: LaneDef[] = [
  {
    id: "today",
    label: "Today",
    description: "Due now or overdue.",
    Icon: CheckCircle2,
  },
  {
    id: "upcoming",
    label: "Upcoming",
    description: "Scheduled for later.",
    Icon: CalendarClock,
  },
  {
    id: "someday",
    label: "Someday",
    description: "No due date yet.",
    Icon: Clock3,
  },
];

function isActive(todo: Todo): boolean {
  return todo.status === "pending" || todo.status === "in_progress";
}

function laneFor(todo: Todo, now: number): LaneDef["id"] {
  // TODO(migrate: plugins/plugin-lifeops/src/actions/owner-surfaces.ts):
  // use the same due-window classification as OWNER_TODOS once ported.
  const due = (todo as Todo & { dueAt?: string | null }).dueAt;
  if (!due) return "someday";
  const ts = Date.parse(due);
  if (Number.isNaN(ts)) return "someday";
  return ts <= now + 24 * 60 * 60 * 1000 ? "today" : "upcoming";
}

export function TodosView(props: TodosViewProps): ReactElement {
  const todos = props.todos ?? [];
  const now = Date.now();

  const byLane = useMemo(() => {
    const grouped: Record<LaneDef["id"], Todo[]> = {
      today: [],
      upcoming: [],
      someday: [],
    };
    for (const todo of todos) {
      if (!isActive(todo)) continue;
      grouped[laneFor(todo, now)].push(todo);
    }
    return grouped;
  }, [todos, now]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "1.5rem",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <h1
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "1.5rem",
            fontWeight: 600,
            margin: 0,
          }}
        >
          <Inbox size={22} aria-hidden /> Todos
        </h1>
        <p style={{ color: "#888", margin: 0 }}>
          Three lanes: Today, Upcoming, Someday.
        </p>
      </header>

      <section
        aria-label="Todo lanes"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "1rem",
          flex: 1,
          minHeight: 0,
        }}
      >
        {LANES.map((lane) => {
          const items = byLane[lane.id];
          const { Icon } = lane;
          return (
            <article
              key={lane.id}
              aria-label={`${lane.label} lane`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
                padding: "1rem",
                border: "1px solid #2a2a2a",
                borderRadius: 12,
                background: "rgba(255,255,255,0.02)",
                minHeight: 0,
              }}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <Icon size={18} aria-hidden />
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{lane.label}</span>
                  <span style={{ fontSize: "0.8rem", color: "#888" }}>
                    {lane.description}
                  </span>
                </div>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.8rem",
                    color: "#aaa",
                  }}
                >
                  {items.length}
                </span>
              </header>

              <ul
                style={{
                  flex: 1,
                  overflowY: "auto",
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                {items.length === 0 ? (
                  <li
                    style={{
                      color: "#666",
                      fontSize: "0.85rem",
                      fontStyle: "italic",
                    }}
                  >
                    Nothing here.
                  </li>
                ) : (
                  items.map((todo) => (
                    <li
                      key={todo.id}
                      style={{
                        padding: "0.5rem 0.75rem",
                        borderRadius: 8,
                        border: "1px solid #333",
                        background: "#111",
                      }}
                    >
                      <div style={{ fontSize: "0.9rem" }}>{todo.content}</div>
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "#888",
                          marginTop: "0.25rem",
                        }}
                      >
                        {todo.status}
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </article>
          );
        })}
      </section>
    </div>
  );
}

export default TodosView;
