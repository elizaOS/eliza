// @vitest-environment jsdom

/**
 * TodosView is a data-fetching three-lane todo board (Today / Upcoming /
 * Someday) over the single read-only endpoint PA serves:
 *   GET {base}/api/lifeops/todos -> { todos: TodoWire[] }
 *
 * The default fetcher hits that URL via `client.getBaseUrl()`; every test here
 * injects the `fetchers` seam so the suite stays offline. We assert the de-facto
 * rendered contract across the four states:
 *
 *   - loading  (todos-loading)   while the first fetch is in flight,
 *   - error    (todos-error)     + a Retry that refetches into populated,
 *   - empty    (todos-empty)     honest "ask Eliza to add one", no fabricated
 *                                todos, routed through client.sendChatMessage,
 *   - populated(todos-populated) the three lanes, with lane assignment by
 *                                dueDate (<= now+24h incl. overdue -> Today,
 *                                future -> Upcoming, missing/unparseable ->
 *                                Someday), active-only filter (completed
 *                                excluded), per-lane counts, and per-row title.
 *
 * The header Refresh control is agent-instrumented (useAgentElement, mocked to
 * an inert hook here) and refetches on activation.
 *
 * External-API contract test: the wire shape { todos: { id, title, status,
 * dueDate } } mirrors the projection PA emits from getOverview().owner
 * occurrences; the populated fixture below is the validated shape. The PA route
 * is covered by PA's own tsc/build; this view test validates the consuming side.
 *
 * TUI / XR contract test: N/A. The plugin declares a single `gui` view
 * (componentExport TodosView) and no interact() capability / no tui|xr
 * viewType, so there is no terminal surface to exercise.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; TodosView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (add-a-todo affordance). `@elizaos/ui/agent-surface`
// is mocked to an inert hook so the instrumented button renders outside a
// provider.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { type TodosFetchers, TodosView } from "./TodosView.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface TodoWire {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
}

let seq = 0;
function todo(overrides: Partial<TodoWire>): TodoWire {
  seq += 1;
  return {
    id: `todo-${seq}`,
    title: `Todo ${seq}`,
    status: "pending",
    dueDate: null,
    ...overrides,
  };
}

function populated(): { todos: TodoWire[] } {
  const now = Date.now();
  return {
    todos: [
      todo({
        title: "Overdue task",
        status: "pending",
        dueDate: new Date(now - HOUR).toISOString(),
      }),
      todo({
        title: "Due in two hours",
        status: "in_progress",
        dueDate: new Date(now + 2 * HOUR).toISOString(),
      }),
      todo({
        title: "Due in five days",
        status: "pending",
        dueDate: new Date(now + 5 * DAY).toISOString(),
      }),
      todo({ title: "No due date", status: "pending", dueDate: null }),
      // completed must be excluded from every lane + count.
      todo({
        title: "Done task",
        status: "completed",
        dueDate: new Date(now - HOUR).toISOString(),
      }),
    ],
  };
}

function makeFetchers(overrides: Partial<TodosFetchers> = {}): TodosFetchers {
  return {
    fetchTodos: async () => populated(),
    ...overrides,
  };
}

function lane(label: "Today" | "Upcoming" | "Someday"): HTMLElement {
  return screen.getByRole("article", { name: `${label} lane` });
}

function laneCount(label: "Today" | "Upcoming" | "Someday"): string {
  return within(lane(label)).getByLabelText(`${label} count`).textContent ?? "";
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("TodosView — states", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(<TodosView fetchers={makeFetchers({ fetchTodos: () => never })} />);
    expect(screen.getByTestId("todos-loading")).toBeTruthy();
  });

  it("renders the populated three-lane board", async () => {
    render(<TodosView fetchers={makeFetchers()} />);
    expect(await screen.findByTestId("todos-populated")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Todos" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Three lanes: Today, Upcoming, Someday."),
    ).toBeTruthy();
  });

  it("shows the empty state when the route returns no active todos", async () => {
    render(
      <TodosView fetchers={makeFetchers({ fetchTodos: async () => ({ todos: [] }) })} />,
    );
    expect(await screen.findByTestId("todos-empty")).toBeTruthy();
    expect(screen.getByText(/No todos/i)).toBeTruthy();
    expect(screen.queryByTestId("todos-populated")).toBeNull();
  });

  it("treats an all-completed payload as empty (no fabricated lanes)", async () => {
    render(
      <TodosView
        fetchers={makeFetchers({
          fetchTodos: async () => ({
            todos: [todo({ title: "Done", status: "completed" })],
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("todos-empty")).toBeTruthy();
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("routes the add-a-todo affordance through the assistant chat", async () => {
    render(
      <TodosView fetchers={makeFetchers({ fetchTodos: async () => ({ todos: [] }) })} />,
    );
    await screen.findByTestId("todos-empty");
    fireEvent.click(screen.getByRole("button", { name: /add a todo/i }));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into populated", async () => {
    let attempt = 0;
    const fetchTodos = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return populated();
    };
    render(<TodosView fetchers={makeFetchers({ fetchTodos })} />);
    expect(await screen.findByTestId("todos-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("todos-populated")).toBeTruthy();
  });
});

describe("TodosView — lane assignment + filtering", () => {
  it("routes overdue/within-24h to Today, future to Upcoming, no-due to Someday", async () => {
    render(<TodosView fetchers={makeFetchers()} />);
    await screen.findByTestId("todos-populated");

    const today = within(lane("Today"));
    expect(today.getByText("Overdue task")).toBeTruthy();
    expect(today.getByText("Due in two hours")).toBeTruthy();

    expect(within(lane("Upcoming")).getByText("Due in five days")).toBeTruthy();
    expect(within(lane("Today")).queryByText("Due in five days")).toBeNull();

    expect(within(lane("Someday")).getByText("No due date")).toBeTruthy();
    expect(within(lane("Upcoming")).queryByText("No due date")).toBeNull();
  });

  it("routes an unparseable dueDate to Someday", async () => {
    render(
      <TodosView
        fetchers={makeFetchers({
          fetchTodos: async () => ({
            todos: [todo({ title: "Garbage due", dueDate: "not-a-date" })],
          }),
        })}
      />,
    );
    await screen.findByTestId("todos-populated");
    expect(within(lane("Someday")).getByText("Garbage due")).toBeTruthy();
    expect(within(lane("Today")).queryByText("Garbage due")).toBeNull();
  });

  it("excludes completed todos from every lane and every count", async () => {
    render(<TodosView fetchers={makeFetchers()} />);
    await screen.findByTestId("todos-populated");

    expect(screen.queryByText("Done task")).toBeNull();
    expect(laneCount("Today")).toBe("2");
    expect(laneCount("Upcoming")).toBe("1");
    expect(laneCount("Someday")).toBe("1");
  });

  it("shows 'Nothing here.' in lanes with no active items", async () => {
    render(
      <TodosView
        fetchers={makeFetchers({
          fetchTodos: async () => ({
            todos: [
              todo({
                title: "Only today",
                dueDate: new Date(Date.now() - HOUR).toISOString(),
              }),
            ],
          }),
        })}
      />,
    );
    await screen.findByTestId("todos-populated");
    expect(within(lane("Today")).queryByText("Nothing here.")).toBeNull();
    expect(within(lane("Upcoming")).getByText("Nothing here.")).toBeTruthy();
    expect(within(lane("Someday")).getByText("Nothing here.")).toBeTruthy();
  });
});

describe("TodosView — refresh", () => {
  it("refetches when the header refresh control is activated", async () => {
    let calls = 0;
    const fetchTodos = async () => {
      calls += 1;
      return populated();
    };
    render(<TodosView fetchers={makeFetchers({ fetchTodos })} />);
    await screen.findByTestId("todos-populated");
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(calls).toBe(2));
  });
});
