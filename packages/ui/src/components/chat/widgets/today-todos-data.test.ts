// Read-model unit tests for the home "Today" card: boundary parsing of the
// untrusted /api/lifeops/todos wire, the due/overdue-today selection, and the
// occurrence-complete write. Deterministic — `now` is injected, fetch is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";

const { getBaseUrlMock } = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
}));

vi.mock("../../../api", () => ({
  client: { getBaseUrl: getBaseUrlMock },
}));

import {
  completeTodayTodo,
  dueOrOverdueToday,
  fetchTodayTodos,
  isOverdue,
  loadTodayTodosForGlance,
  overdueCount,
  parseTodayTodos,
  type TodayTodo,
  todosEqual,
} from "./today-todos-data";

// A fixed clock: 2026-07-06T12:00:00Z. All fixtures are relative to it.
const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const YESTERDAY = "2026-07-05T09:00:00.000Z";
const EARLIER_TODAY = "2026-07-06T08:00:00.000Z";
const LATER_TODAY = "2026-07-06T22:00:00.000Z";
const TOMORROW = "2026-07-07T09:00:00.000Z";

function todo(over: Partial<TodayTodo> & { id: string }): TodayTodo {
  return {
    title: `Todo ${over.id}`,
    dueDate: LATER_TODAY,
    status: "pending",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  getBaseUrlMock.mockReturnValue("http://localhost");
});

describe("parseTodayTodos", () => {
  it("keeps only well-formed, due-dated records and normalizes status", () => {
    const parsed = parseTodayTodos({
      todos: [
        { id: "a", title: "Has due", status: "in_progress", dueDate: TOMORROW },
        { id: "b", title: "No due", status: "pending", dueDate: null },
        { id: "c", title: "Bad due", status: "pending", dueDate: "not-a-date" },
        {
          id: "d",
          title: "Unknown status",
          status: "weird",
          dueDate: TOMORROW,
        },
        { id: 5, title: "Bad id", status: "pending", dueDate: TOMORROW },
        { title: "No id", status: "pending", dueDate: TOMORROW },
        "garbage",
      ],
    });
    expect(parsed).toEqual([
      { id: "a", title: "Has due", status: "in_progress", dueDate: TOMORROW },
      {
        id: "d",
        title: "Unknown status",
        status: "pending",
        dueDate: TOMORROW,
      },
    ]);
  });

  it("returns [] for non-object / missing-array payloads", () => {
    expect(parseTodayTodos(null)).toEqual([]);
    expect(parseTodayTodos({})).toEqual([]);
    expect(parseTodayTodos({ todos: "nope" })).toEqual([]);
    expect(parseTodayTodos("nope")).toEqual([]);
  });
});

describe("dueOrOverdueToday", () => {
  it("keeps overdue + today, drops future and completed, sorts most-overdue first", () => {
    const glance = dueOrOverdueToday(
      [
        todo({ id: "future", dueDate: TOMORROW }),
        todo({ id: "today-late", dueDate: LATER_TODAY }),
        todo({ id: "overdue", dueDate: YESTERDAY }),
        todo({ id: "today-early", dueDate: EARLIER_TODAY }),
        todo({ id: "done", dueDate: YESTERDAY, status: "completed" }),
      ],
      NOW,
    );
    expect(glance.map((t) => t.id)).toEqual([
      "overdue",
      "today-early",
      "today-late",
    ]);
  });

  it("treats a due date at the last ms of today as still due today", () => {
    const endOfToday = "2026-07-06T23:59:59.999Z";
    const glance = dueOrOverdueToday(
      [todo({ id: "edge", dueDate: endOfToday })],
      NOW,
    );
    // Boundary check uses local end-of-day; a UTC-late timestamp on the same
    // calendar day resolves as due today under the test's UTC clock.
    expect(glance.map((t) => t.id)).toContain("edge");
  });
});

describe("isOverdue / overdueCount", () => {
  it("classifies before-start-of-today as overdue, today as not", () => {
    expect(isOverdue(todo({ id: "y", dueDate: YESTERDAY }), NOW)).toBe(true);
    expect(isOverdue(todo({ id: "t", dueDate: EARLIER_TODAY }), NOW)).toBe(
      false,
    );
  });

  it("counts only the overdue members of the glance", () => {
    const count = overdueCount(
      [
        todo({ id: "overdue", dueDate: YESTERDAY }),
        todo({ id: "today", dueDate: LATER_TODAY }),
        todo({ id: "future", dueDate: TOMORROW }),
      ],
      NOW,
    );
    expect(count).toBe(1);
  });
});

describe("fetchTodayTodos", () => {
  it("GETs the owner-todos route and parses the response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            todos: [
              { id: "a", title: "A", status: "pending", dueDate: TOMORROW },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const todos = await fetchTodayTodos();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/lifeops/todos",
    );
    expect(todos).toEqual([
      { id: "a", title: "A", status: "pending", dueDate: TOMORROW },
    ]);
  });

  it("throws on a non-2xx response so the caller can degrade (J4)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(fetchTodayTodos()).rejects.toThrow(
      "Todos request failed (500)",
    );
  });
});

describe("completeTodayTodo", () => {
  it("POSTs the occurrence-complete write with the encoded id", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await completeTodayTodo("occ 1/2");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/lifeops/occurrences/occ%201%2F2/complete",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("rejects on failure so an optimistic completion can roll back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 409 })),
    );
    await expect(completeTodayTodo("x")).rejects.toThrow(
      "Complete todo failed (409)",
    );
  });
});

describe("loadTodayTodosForGlance", () => {
  it("returns [] (gated, not pending) when unauthenticated", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadTodayTodosForGlance(false)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] without fetching on a limited cloud-agent base", async () => {
    getBaseUrlMock.mockReturnValue("https://agent-1.elizacloud.ai");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadTodayTodosForGlance(true)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a fetch failure so the caller keeps last-good (J4)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );
    expect(await loadTodayTodosForGlance(true)).toBeNull();
  });

  it("returns the parsed todos when authenticated on a full app base", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              todos: [
                { id: "a", title: "A", status: "pending", dueDate: TOMORROW },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    expect(await loadTodayTodosForGlance(true)).toEqual([
      { id: "a", title: "A", status: "pending", dueDate: TOMORROW },
    ]);
  });
});

describe("todosEqual", () => {
  it("is false against null and on any field change; true on identical content", () => {
    const a = [todo({ id: "1", title: "One", dueDate: TOMORROW })];
    expect(todosEqual(null, a)).toBe(false);
    expect(
      todosEqual(a, [todo({ id: "1", title: "One", dueDate: TOMORROW })]),
    ).toBe(true);
    expect(
      todosEqual(a, [todo({ id: "1", title: "Changed", dueDate: TOMORROW })]),
    ).toBe(false);
    expect(todosEqual(a, [])).toBe(false);
  });
});
