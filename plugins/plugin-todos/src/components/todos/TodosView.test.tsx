// @vitest-environment jsdom

/**
 * TodosView is a three-lane todo board (Today / Upcoming / Someday) whose only
 * data source is its `todos` prop (TodosViewProps.todos: Todo[]). There is no
 * hook, no fetch, and no /api call in the component, so these tests render the
 * view with realistic Todo fixtures and assert the de-facto rendered contract:
 *
 *   - the "Todos" <h1> header (with Inbox icon) + the verbatim subtitle,
 *   - lane assignment by dueAt: <= now+24h (incl. overdue) -> Today,
 *     future -> Upcoming, missing/unparseable -> Someday,
 *   - active-only filter: only `pending` / `in_progress` render; `completed`
 *     and `cancelled` are excluded from every lane AND from the count badges,
 *   - per-lane count badge == number of active items in that lane,
 *   - per-row rendering of both todo.content and todo.status,
 *   - the "Nothing here." italic placeholder for an empty lane.
 *
 * It then asserts — as a tripwire — that the view exposes ZERO interactive
 * controls. The completion toggle, drag-and-drop reorder, per-row detail
 * drawer, and lane filtering are documented SCAFFOLD/TODO (see the banner in
 * TodosView.tsx). When the first real control lands, the tripwire fails loudly,
 * forcing this file to grow real interaction coverage.
 *
 * External-API contract test: N/A. dataSource is props only — the component
 * performs no fetch / no parser / no /api call, so there is no real API shape
 * to validate against. (The /api/workbench/todos route in app-core is a
 * separate AgentRuntime-tasks compat surface and is NOT consumed by this view.)
 *
 * TUI / XR contract test: N/A. The plugin declares a single `gui` view
 * (componentExport TodosView) and no interact() capability / no tui|xr
 * viewType, so there is no terminal surface to exercise.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Todo, TodoStatus } from "../../types.js";
import { TodosView } from "./TodosView.tsx";

afterEach(() => {
  cleanup();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let seq = 0;

/**
 * Build a full Todo. The view reads a `dueAt` field that is cast onto Todo at
 * runtime (it is not part of the declared Todo interface), so we attach it via
 * an intersection type to match the component's `(todo as Todo & { dueAt? })`.
 */
function makeTodo(
  overrides: Partial<Todo> & { dueAt?: string | null },
): Todo & { dueAt?: string | null } {
  seq += 1;
  const now = new Date();
  const base: Todo & { dueAt?: string | null } = {
    id: `todo-${seq}`,
    entityId: "entity-1",
    agentId: "agent-1",
    roomId: null,
    worldId: null,
    content: `Todo ${seq}`,
    activeForm: `Doing todo ${seq}`,
    status: "pending" as TodoStatus,
    parentTodoId: null,
    parentTrajectoryStepId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  return { ...base, ...overrides };
}

/** Resolve the <article> element for a lane by its aria-label. */
function lane(label: "Today" | "Upcoming" | "Someday"): HTMLElement {
  return screen.getByRole("article", { name: `${label} lane` });
}

/** Read the count badge for a lane (the last numeric span in the lane header). */
function laneCount(label: "Today" | "Upcoming" | "Someday"): string {
  const header = within(lane(label))
    .getByText(label)
    .closest("header") as HTMLElement;
  // The badge span is the trailing numeric span in the lane header.
  const spans = Array.from(header.querySelectorAll("span"));
  const badge = spans[spans.length - 1];
  return badge.textContent ?? "";
}

describe("TodosView — header + static contract", () => {
  it("renders the 'Todos' h1 header and the verbatim subtitle", () => {
    render(<TodosView todos={[]} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Todos" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Three lanes: Today, Upcoming, Someday."),
    ).toBeTruthy();
  });

  it("renders all three lanes with their labels and verbatim descriptions", () => {
    render(<TodosView todos={[]} />);

    const today = within(lane("Today"));
    expect(today.getByText("Today")).toBeTruthy();
    expect(today.getByText("Due now or overdue.")).toBeTruthy();

    const upcoming = within(lane("Upcoming"));
    expect(upcoming.getByText("Upcoming")).toBeTruthy();
    expect(upcoming.getByText("Scheduled for later.")).toBeTruthy();

    const someday = within(lane("Someday"));
    expect(someday.getByText("Someday")).toBeTruthy();
    expect(someday.getByText("No due date yet.")).toBeTruthy();
  });
});

describe("TodosView — lane assignment by dueAt", () => {
  it("routes overdue, within-24h, future, and no-due todos to the correct lanes", () => {
    const now = Date.now();
    const todos = [
      makeTodo({
        content: "Overdue task",
        status: "pending",
        dueAt: new Date(now - HOUR).toISOString(),
      }),
      makeTodo({
        content: "Due in two hours",
        status: "in_progress",
        dueAt: new Date(now + 2 * HOUR).toISOString(),
      }),
      makeTodo({
        content: "Due in five days",
        status: "pending",
        dueAt: new Date(now + 5 * DAY).toISOString(),
      }),
      makeTodo({
        content: "No due date",
        status: "pending",
        dueAt: null,
      }),
    ];

    render(<TodosView todos={todos} />);

    // Today lane: overdue + within-24h.
    const today = within(lane("Today"));
    expect(today.getByText("Overdue task")).toBeTruthy();
    expect(today.getByText("Due in two hours")).toBeTruthy();
    // Those contents must NOT bleed into the other lanes.
    expect(within(lane("Upcoming")).queryByText("Overdue task")).toBeNull();
    expect(within(lane("Someday")).queryByText("Due in two hours")).toBeNull();

    // Upcoming lane: future due date.
    expect(within(lane("Upcoming")).getByText("Due in five days")).toBeTruthy();
    expect(within(lane("Today")).queryByText("Due in five days")).toBeNull();

    // Someday lane: no due date.
    expect(within(lane("Someday")).getByText("No due date")).toBeTruthy();
    expect(within(lane("Upcoming")).queryByText("No due date")).toBeNull();
  });

  it("routes an unparseable dueAt to Someday", () => {
    const todos = [
      makeTodo({
        content: "Garbage due date",
        status: "pending",
        dueAt: "not-a-date",
      }),
    ];

    render(<TodosView todos={todos} />);

    expect(within(lane("Someday")).getByText("Garbage due date")).toBeTruthy();
    expect(within(lane("Today")).queryByText("Garbage due date")).toBeNull();
    expect(within(lane("Upcoming")).queryByText("Garbage due date")).toBeNull();
  });

  it("treats a dueAt exactly at the now+24h boundary as Today (inclusive)", () => {
    // laneFor uses `ts <= now + 24h` -> today. now is captured inside the
    // component, so a slightly-under-24h due date is unambiguously Today.
    const todos = [
      makeTodo({
        content: "Boundary task",
        status: "pending",
        dueAt: new Date(Date.now() + DAY - 5 * 60 * 1000).toISOString(),
      }),
    ];

    render(<TodosView todos={todos} />);

    expect(within(lane("Today")).getByText("Boundary task")).toBeTruthy();
    expect(within(lane("Upcoming")).queryByText("Boundary task")).toBeNull();
  });
});

describe("TodosView — per-lane count badges", () => {
  it("shows a count badge equal to the number of active items in each lane", () => {
    const now = Date.now();
    const todos = [
      makeTodo({
        content: "Overdue",
        status: "pending",
        dueAt: new Date(now - HOUR).toISOString(),
      }),
      makeTodo({
        content: "Soon",
        status: "in_progress",
        dueAt: new Date(now + 3 * HOUR).toISOString(),
      }),
      makeTodo({
        content: "Later",
        status: "pending",
        dueAt: new Date(now + 5 * DAY).toISOString(),
      }),
      makeTodo({ content: "Whenever", status: "pending", dueAt: null }),
    ];

    render(<TodosView todos={todos} />);

    expect(laneCount("Today")).toBe("2");
    expect(laneCount("Upcoming")).toBe("1");
    expect(laneCount("Someday")).toBe("1");
  });

  it("shows a 0 badge for every lane when there are no todos", () => {
    render(<TodosView todos={[]} />);

    expect(laneCount("Today")).toBe("0");
    expect(laneCount("Upcoming")).toBe("0");
    expect(laneCount("Someday")).toBe("0");
  });
});

describe("TodosView — active-only filter", () => {
  it("excludes completed and cancelled todos from every lane and every count", () => {
    const now = Date.now();
    const todos = [
      makeTodo({
        content: "Active overdue",
        status: "pending",
        dueAt: new Date(now - HOUR).toISOString(),
      }),
      // completed/cancelled with due dates that WOULD land in real lanes if
      // they were active — they must still be excluded everywhere.
      makeTodo({
        content: "Done task",
        status: "completed",
        dueAt: new Date(now - HOUR).toISOString(),
      }),
      makeTodo({
        content: "Killed task",
        status: "cancelled",
        dueAt: new Date(now + 5 * DAY).toISOString(),
      }),
      makeTodo({
        content: "Done no-due",
        status: "completed",
        dueAt: null,
      }),
    ];

    render(<TodosView todos={todos} />);

    // The active todo is present.
    expect(within(lane("Today")).getByText("Active overdue")).toBeTruthy();

    // None of the inactive todos appear anywhere in the document.
    expect(screen.queryByText("Done task")).toBeNull();
    expect(screen.queryByText("Killed task")).toBeNull();
    expect(screen.queryByText("Done no-due")).toBeNull();

    // And they are not counted: only the single active todo is in Today.
    expect(laneCount("Today")).toBe("1");
    expect(laneCount("Upcoming")).toBe("0");
    expect(laneCount("Someday")).toBe("0");
  });
});

describe("TodosView — per-row rendering", () => {
  it("renders both content and status text on each todo row", () => {
    const now = Date.now();
    const todos = [
      makeTodo({
        content: "Write the report",
        status: "pending",
        dueAt: new Date(now - HOUR).toISOString(),
      }),
      makeTodo({
        content: "Review the PR",
        status: "in_progress",
        dueAt: new Date(now + 2 * HOUR).toISOString(),
      }),
    ];

    render(<TodosView todos={todos} />);

    const today = within(lane("Today"));

    // Each row shows its content...
    const reportRow = today.getByText("Write the report").closest("li");
    expect(reportRow).toBeTruthy();
    // ...and its status text on the same row.
    expect(within(reportRow as HTMLElement).getByText("pending")).toBeTruthy();

    const prRow = today.getByText("Review the PR").closest("li");
    expect(prRow).toBeTruthy();
    expect(within(prRow as HTMLElement).getByText("in_progress")).toBeTruthy();
  });
});

describe("TodosView — empty-lane placeholder", () => {
  it("renders 'Nothing here.' for each lane that has no active items", () => {
    // One todo in Today only -> Upcoming and Someday are empty.
    const todos = [
      makeTodo({
        content: "Only today task",
        status: "pending",
        dueAt: new Date(Date.now() - HOUR).toISOString(),
      }),
    ];

    render(<TodosView todos={todos} />);

    // Today is populated, so no placeholder inside it.
    expect(within(lane("Today")).queryByText("Nothing here.")).toBeNull();
    // The two empty lanes show the placeholder.
    expect(within(lane("Upcoming")).getByText("Nothing here.")).toBeTruthy();
    expect(within(lane("Someday")).getByText("Nothing here.")).toBeTruthy();
  });

  it("renders 'Nothing here.' in all three lanes when there are no todos", () => {
    render(<TodosView todos={[]} />);
    expect(screen.getAllByText("Nothing here.")).toHaveLength(3);
  });

  it("renders 'Nothing here.' in all three lanes when given no todos prop at all", () => {
    render(<TodosView />);
    expect(screen.getAllByText("Nothing here.")).toHaveLength(3);
  });
});

describe("TodosView — interaction tripwire", () => {
  it("exposes ZERO interactive controls (tripwire for the toggle/drag/drawer migration)", () => {
    const now = Date.now();
    const { container } = render(
      <TodosView
        todos={[
          makeTodo({
            content: "Active task",
            status: "pending",
            dueAt: new Date(now - HOUR).toISOString(),
          }),
        ]}
      />,
    );

    // No ARIA-addressable interactive roles.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);

    // No raw interactive DOM elements either.
    expect(
      container.querySelectorAll("button, input, a, select, textarea"),
    ).toHaveLength(0);
  });
});
