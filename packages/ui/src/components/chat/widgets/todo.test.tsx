// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authMock,
  getBaseUrlMock,
  listWorkbenchTodosMock,
  mockState,
  publishHomeAttentionSpy,
  openViewSpy,
} = vi.hoisted(() => ({
  // Auth gate (#11084) - mutable so tests can flip the session state.
  authMock: { authenticated: true },
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  listWorkbenchTodosMock: vi.fn(
    async (): Promise<{
      todos: Array<{
        id: string;
        name: string;
        description: string;
        type: string;
        isCompleted: boolean;
        isUrgent: boolean;
        priority: number | null;
      }>;
    }> => ({ todos: [] }),
  ),
  mockState: {
    workbench: {
      todos: [
        {
          id: "cached-1",
          name: "Cached todo",
          description: "",
          type: "task",
          isCompleted: false,
          isUrgent: false,
          priority: null,
        },
      ],
    },
    t: (_key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? "",
  },
  publishHomeAttentionSpy: vi.fn(),
  openViewSpy: vi.fn(),
}));

// The home card fetches owner todos (/api/lifeops/todos) and the urgent goal
// (/api/lifeops/goals) through the read models, and completes a row through
// /api/lifeops/occurrences/:id/complete. This router drives the REAL read path.
const completeState = { status: 200, calls: [] as string[] };
function stubLifeopsFetch(todos: unknown[], goals: unknown[] = []) {
  completeState.status = 200;
  completeState.calls = [];
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/lifeops/occurrences/") && u.endsWith("/complete")) {
      completeState.calls.push(u);
      return new Response("{}", { status: completeState.status });
    }
    if (u.includes("/api/lifeops/todos")) {
      return new Response(JSON.stringify({ todos }), { status: 200 });
    }
    if (u.includes("/api/lifeops/goals")) {
      return new Response(JSON.stringify({ goals }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const overdueDue = () => new Date(Date.now() - DAY_MS).toISOString();
const dueTodayDue = () => new Date().toISOString();
const futureDue = () => new Date(Date.now() + 2 * DAY_MS).toISOString();
function ownerTodo(over: {
  id: string;
  title?: string;
  status?: string;
  dueDate: string;
}) {
  return { title: `Todo ${over.id}`, status: "pending", ...over };
}

vi.mock("../../../api", () => ({
  client: {
    getBaseUrl: getBaseUrlMock,
    listWorkbenchTodos: listWorkbenchTodosMock,
  },
}));

vi.mock("../../../hooks", () => ({
  useIntervalWhenDocumentVisible: vi.fn(),
}));

vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../../state", () => ({
  useAppSelectorShallow: <T,>(selector: (state: typeof mockState) => T): T =>
    selector(mockState),
}));

vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishHomeAttentionSpy,
}));

vi.mock("./home-widget-card", () => ({
  useWidgetNavigation: () => ({ openView: openViewSpy }),
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import { TODO_PLUGIN_WIDGETS } from "./todo";

const TodoWidget = TODO_PLUGIN_WIDGETS.find(
  (widget) => widget.id === "todo.items",
)?.Component;

if (!TodoWidget) {
  throw new Error("todo.items widget not registered");
}

beforeEach(() => {
  getBaseUrlMock.mockReset();
  getBaseUrlMock.mockReturnValue("http://localhost");
  listWorkbenchTodosMock.mockClear();
  listWorkbenchTodosMock.mockResolvedValue({ todos: [] });
  publishHomeAttentionSpy.mockClear();
  openViewSpy.mockClear();
  authMock.authenticated = true;
  mockState.workbench.todos = [
    {
      id: "cached-1",
      name: "Cached todo",
      description: "",
      type: "task",
      isCompleted: false,
      isUrgent: false,
      priority: null,
    },
  ];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TodoSidebarWidget", () => {
  it("uses cached todos and skips workbench polling on limited cloud agent bases", async () => {
    getBaseUrlMock.mockReturnValue("https://agent-1.elizacloud.ai");

    render(
      <TodoWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    expect(await screen.findByText("Cached todo")).toBeTruthy();
    const row = screen.getByTestId("workbench-todo-row");
    expect(row.className).toBe("py-1.5");
    expect(row.className).not.toContain("border");
    expect(row.className).not.toContain("bg-");
    await Promise.resolve();
    expect(listWorkbenchTodosMock).not.toHaveBeenCalled();
  });

  // #11084 - the widget mounts before the auth probe resolves; its workbench
  // poll must not fire a single request while the session is unauthenticated.
  it("does not poll workbench todos while unauthenticated", async () => {
    authMock.authenticated = false;

    render(
      <TodoWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    expect(await screen.findByText("Cached todo")).toBeTruthy();
    await Promise.resolve();
    expect(listWorkbenchTodosMock).not.toHaveBeenCalled();
  });

  it("polls workbench todos once the session is authenticated", async () => {
    render(
      <TodoWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(listWorkbenchTodosMock).toHaveBeenCalled();
    });
  });

  it("refreshes immediately when a workbench todo change event arrives", async () => {
    listWorkbenchTodosMock
      .mockResolvedValueOnce({
        todos: [
          {
            id: "cached-1",
            name: "Cached todo",
            description: "",
            type: "task",
            isCompleted: false,
            isUrgent: false,
            priority: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        todos: [
          {
            id: "live-1",
            name: "Live todo",
            description: "",
            type: "task",
            isCompleted: false,
            isUrgent: false,
            priority: null,
          },
        ],
      });

    const { rerender } = render(
      <TodoWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(listWorkbenchTodosMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <TodoWidget
        slot="chat-sidebar"
        clearEvents={vi.fn()}
        events={[
          {
            id: "evt-workbench-1",
            timestamp: Date.now(),
            eventType: "workbench.todo.changed",
            summary: "Todo updated",
            source: {
              type: "agent_event",
              stream: "workbench",
              data: {
                type: "workbench.todo.changed",
                operation: "created",
                todoId: "live-1",
              },
            },
          },
        ]}
      />,
    );

    expect(await screen.findByText("Live todo")).toBeTruthy();
    expect(listWorkbenchTodosMock).toHaveBeenCalledTimes(2);
  });

  it("home slot: renders the OWNER's due/overdue todos, not the agent workbench (#14734)", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "od", title: "Pay rent", dueDate: overdueDue() }),
      ownerTodo({
        id: "td",
        title: "Call the dentist",
        dueDate: dueTodayDue(),
      }),
      ownerTodo({ id: "fut", title: "Book flights", dueDate: futureDue() }),
    ]);

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);

    // Owner todos with due dates render...
    expect(await screen.findByText("Pay rent")).toBeTruthy();
    expect(screen.getByText("Call the dentist")).toBeTruthy();
    // ...the future todo is not a glance...
    expect(screen.queryByText("Book flights")).toBeNull();
    // ...and the agent's workbench checklist never appears on the Today card.
    expect(screen.queryByText("Cached todo")).toBeNull();
    // Overdue carries the accent badge; due-today is neutral.
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText("Due today")).toBeTruthy();
  });

  it("home slot: self-hides when nothing is due/overdue and there is no urgent goal", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "fut", title: "Book flights", dueDate: futureDue() }),
    ]);
    const { container } = render(
      <TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />,
    );
    await waitFor(() => {
      expect(container.firstElementChild).toBeNull();
    });
  });

  it("home slot: tapping a row completes it through the occurrence-complete write and it disappears (#14734)", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "occ-1", title: "Pay rent", dueDate: overdueDue() }),
    ]);
    const user = userEvent.setup();

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);
    const row = await screen.findByTestId("today-todo-row");
    // First reload after complete returns an empty list (the occurrence is done).
    await user.click(row);

    await waitFor(() => {
      expect(completeState.calls).toContain(
        "http://localhost/api/lifeops/occurrences/occ-1/complete",
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Pay rent")).toBeNull();
    });
  });

  it("home slot: restores the row when the completion write fails (J4 rollback)", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "occ-2", title: "Pay rent", dueDate: overdueDue() }),
    ]);
    completeState.status = 500;
    const user = userEvent.setup();

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);
    const row = await screen.findByTestId("today-todo-row");
    await user.click(row);

    await waitFor(() => {
      expect(completeState.calls.length).toBe(1);
    });
    // The write failed, so the row must come back rather than silently drop.
    await waitFor(() => {
      expect(screen.getByText("Pay rent")).toBeTruthy();
    });
  });

  it("home slot: an overdue todo publishes the reminder attention weight", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "od", title: "Pay rent", dueDate: overdueDue() }),
    ]);
    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);
    await screen.findByText("Pay rent");
    await waitFor(() => {
      expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
        "todo/todo.items",
        HOME_SIGNAL_WEIGHTS.reminder,
      );
    });
  });

  it("home slot: tapping the header opens the routed todos view", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "od", title: "Pay rent", dueDate: overdueDue() }),
    ]);
    const user = userEvent.setup();
    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);
    await screen.findByText("Pay rent");
    await user.click(screen.getByRole("button", { name: /Today/ }));
    expect(openViewSpy).toHaveBeenCalledWith("/todos", "todos");
  });

  it("home slot: applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "od", title: "Pay rent", dueDate: overdueDue() }),
    ]);
    const { container } = render(
      <TodoWidget
        slot="home"
        events={[]}
        clearEvents={vi.fn()}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    expect(await screen.findByText("Pay rent")).toBeTruthy();
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-todos"]'),
    ).not.toBeNull();
  });

  it("home slot: falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    stubLifeopsFetch([
      ownerTodo({ id: "od", title: "Pay rent", dueDate: overdueDue() }),
    ]);
    const { container } = render(
      <TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />,
    );
    expect(await screen.findByText("Pay rent")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });

  it("home slot: renders an at-risk goal as one flagged row inside Today (spec §E item 5)", async () => {
    stubLifeopsFetch(
      [],
      [
        {
          goal: {
            id: "goal-at-risk",
            title: "Ship the release",
            status: "active",
            reviewState: "at_risk",
          },
          links: [],
        },
      ],
    );

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);

    const row = await screen.findByTestId("todo-goal-attention-row");
    expect(row.textContent).toContain("Ship the release");
    expect(row.textContent).toContain("At risk");
    expect(screen.queryByTestId("widget-goals-attention")).toBeNull();

    await waitFor(() => {
      expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
        "todo/todo.items",
        HOME_SIGNAL_WEIGHTS.escalation,
      );
    });
  });

  it("home slot: preserves needs-attention goals in the merged Today row", async () => {
    stubLifeopsFetch(
      [],
      [
        {
          goal: {
            id: "goal-needs-attention",
            title: "Reconnect with the team",
            status: "active",
            reviewState: "needs_attention",
          },
          links: [],
        },
      ],
    );

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);

    const row = await screen.findByTestId("todo-goal-attention-row");
    expect(row.textContent).toContain("Reconnect with the team");
    expect(row.textContent).toContain("Needs attention");
  });

  it("chat-sidebar slot: does NOT wrap the section in a grid-span root (#11752)", async () => {
    authMock.authenticated = false;
    const { container } = render(
      <TodoWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );
    expect(await screen.findByText("Cached todo")).toBeTruthy();
    expect(container.firstElementChild?.className ?? "").not.toContain(
      "col-span-2",
    );
  });
});
