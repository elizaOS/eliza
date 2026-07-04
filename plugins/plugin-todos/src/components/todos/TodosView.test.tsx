/**
 * @vitest-environment jsdom
 *
 * Drives the unified TodosView (the single GUI/XR data wrapper) through the
 * rendered DOM: the same component the bundle exports for both the "gui" and
 * "xr" modalities. It is a read-only three-lane board (Today / Upcoming /
 * Someday) over the single endpoint PA serves:
 *   GET {base}/api/lifeops/todos -> { todos: TodoWire[] }
 *
 * The default fetcher hits that URL via `client.getBaseUrl()`; every test here
 * injects the `fetchers` seam so the suite stays offline. We assert the rendered
 * spatial DOM across the four states:
 *
 *   - loading  while the first fetch is in flight,
 *   - error    with a Retry that refetches into populated,
 *   - empty    honest "ask Eliza to add one", no fabricated todos, routed
 *              through client.sendChatMessage,
 *   - populated the three lanes, with lane assignment by dueDate (<= now+24h
 *              incl. overdue -> Today, future -> Upcoming, missing/unparseable
 *              -> Someday), active-only filter (completed excluded), and the
 *              quiet overdue line.
 *
 * The board stays fresh via a quiet 15s background poll (asserted with fake
 * timers below) — there is no manual refresh control.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; TodosView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (add-a-todo affordance). The spatial primitives
// come from the separate `@elizaos/ui/spatial` subpath, which is not mocked.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
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

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("TodosView — states", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({ fetchTodos: () => never }),
      }),
    );
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("renders the populated three-lane board", async () => {
    render(React.createElement(TodosView, { fetchers: makeFetchers() }));
    await screen.findByText("Overdue task");
    expect(screen.getByText("Today (2)")).toBeTruthy();
    expect(screen.getByText("Upcoming (1)")).toBeTruthy();
    expect(screen.getByText("Someday (1)")).toBeTruthy();
    expect(
      screen.queryByText("Three lanes: Today, Upcoming, Someday."),
    ).toBeNull();
  });

  it("shows the empty state when the route returns no active todos", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({ fetchTodos: async () => ({ todos: [] }) }),
      }),
    );
    await screen.findByText("None");
    expect(screen.queryByText("Overdue task")).toBeNull();
  });

  it("treats an all-completed payload as empty (no fabricated lanes)", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({
          fetchTodos: async () => ({
            todos: [todo({ title: "Done", status: "completed" })],
          }),
        }),
      }),
    );
    await screen.findByText("None");
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("routes the add-a-todo affordance through the assistant chat", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({ fetchTodos: async () => ({ todos: [] }) }),
      }),
    );
    await screen.findByText("None");
    fireEvent.click(agent("add"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into populated", async () => {
    let attempt = 0;
    const fetchTodos = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return populated();
    };
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({ fetchTodos }),
      }),
    );
    await screen.findByText("boom");
    fireEvent.click(agent("retry"));
    await screen.findByText("Overdue task");
  });
});

describe("TodosView — lane assignment + filtering", () => {
  it("routes overdue/within-24h to Today, future to Upcoming, no-due to Someday", async () => {
    render(React.createElement(TodosView, { fetchers: makeFetchers() }));
    await screen.findByText("Overdue task");

    expect(screen.getByText("Due in two hours")).toBeTruthy();
    expect(screen.getByText("Due in five days")).toBeTruthy();
    expect(screen.getByText("No due date")).toBeTruthy();
    // Lane counts encode the assignment: Today=2, Upcoming=1, Someday=1.
    expect(screen.getByText("Today (2)")).toBeTruthy();
    expect(screen.getByText("Upcoming (1)")).toBeTruthy();
    expect(screen.getByText("Someday (1)")).toBeTruthy();
  });

  it("routes an unparseable dueDate to Someday", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({
          fetchTodos: async () => ({
            todos: [todo({ title: "Garbage due", dueDate: "not-a-date" })],
          }),
        }),
      }),
    );
    await screen.findByText("Garbage due");
    expect(screen.getByText("Someday (1)")).toBeTruthy();
    expect(screen.getByText("Today (0)")).toBeTruthy();
  });

  it("excludes completed todos from every lane and every count", async () => {
    render(React.createElement(TodosView, { fetchers: makeFetchers() }));
    await screen.findByText("Overdue task");
    expect(screen.queryByText("Done task")).toBeNull();
    expect(screen.getByText("Today (2)")).toBeTruthy();
    expect(screen.getByText("Upcoming (1)")).toBeTruthy();
    expect(screen.getByText("Someday (1)")).toBeTruthy();
  });

  it("keeps empty lanes compact", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({
          fetchTodos: async () => ({
            todos: [
              todo({
                title: "Only today",
                dueDate: new Date(Date.now() - HOUR).toISOString(),
              }),
            ],
          }),
        }),
      }),
    );
    await screen.findByText("Only today");
    // Today has the item, Upcoming + Someday are empty.
    expect(screen.queryByText("Nothing here.")).toBeNull();
    expect(screen.getByText("Upcoming (0)")).toBeTruthy();
    expect(screen.getByText("Someday (0)")).toBeTruthy();
  });
});

describe("TodosView — proactive overdue line", () => {
  it("surfaces one quiet line when active todos are past due", async () => {
    render(React.createElement(TodosView, { fetchers: makeFetchers() }));
    await screen.findByText("Overdue task");
    expect(screen.getByText("1 todo is overdue.")).toBeTruthy();
  });

  it("pluralizes the overdue line for multiple past-due todos", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({
          fetchTodos: async () => ({
            todos: [
              todo({
                title: "Late one",
                dueDate: new Date(Date.now() - HOUR).toISOString(),
              }),
              todo({
                title: "Late two",
                status: "in_progress",
                dueDate: new Date(Date.now() - DAY).toISOString(),
              }),
            ],
          }),
        }),
      }),
    );
    await screen.findByText("Late one");
    expect(screen.getByText("2 todos are overdue.")).toBeTruthy();
  });

  it("renders no proactive line when nothing is overdue", async () => {
    render(
      React.createElement(TodosView, {
        fetchers: makeFetchers({
          fetchTodos: async () => ({
            todos: [
              todo({
                title: "Future",
                dueDate: new Date(Date.now() + 5 * DAY).toISOString(),
              }),
            ],
          }),
        }),
      }),
    );
    await screen.findByText("Future");
    expect(screen.queryByText(/overdue/)).toBeNull();
  });
});

describe("TodosView — staying fresh", () => {
  it("has no manual refresh control", async () => {
    render(React.createElement(TodosView, { fetchers: makeFetchers() }));
    await screen.findByText("Overdue task");
    expect(document.querySelector('[data-agent-id="refresh"]')).toBeNull();
  });

  it("refetches on the background poll without manual interaction", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchTodos = async () => {
        calls += 1;
        return populated();
      };
      render(
        React.createElement(TodosView, {
          fetchers: makeFetchers({ fetchTodos }),
        }),
      );
      // Flush the initial mount fetch.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      // The quiet poll fires on its interval (15s) and refetches.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
