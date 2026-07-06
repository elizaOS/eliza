// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface WorkbenchTodoFixture {
  id: string;
  name: string;
  description: string;
  type: string;
  isCompleted: boolean;
  isUrgent: boolean;
  priority: number | null;
}

const {
  authMock,
  getBaseUrlMock,
  fetchMock,
  listWorkbenchTodosMock,
  mockState,
  publishHomeAttentionSpy,
} = vi.hoisted(() => ({
  // Auth gate (#11084) - mutable so tests can flip the session state.
  authMock: { authenticated: true },
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  fetchMock: vi.fn(),
  listWorkbenchTodosMock: vi.fn(
    async (): Promise<{ todos: WorkbenchTodoFixture[] }> => ({ todos: [] }),
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
      ] satisfies WorkbenchTodoFixture[],
    },
    t: (_key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? "",
  },
  publishHomeAttentionSpy: vi.fn(),
}));

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

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import { TODO_PLUGIN_WIDGETS } from "./todo";

const TodoWidget = TODO_PLUGIN_WIDGETS.find(
  (widget) => widget.id === "todo.items",
)?.Component;

if (!TodoWidget) {
  throw new Error("todo.items widget not registered");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockLifeOpsResponses({
  todos = [],
  goals = [],
}: {
  todos?: unknown[];
  goals?: unknown[];
} = {}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/lifeops/todos")) {
      return jsonResponse({ todos });
    }
    if (url.includes("/api/lifeops/goals")) {
      return jsonResponse({ goals });
    }
    if (url.includes("/api/lifeops/occurrences/")) {
      return jsonResponse({});
    }
    return jsonResponse({});
  });
}

function isoDaysFromNow(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString();
}

beforeEach(() => {
  getBaseUrlMock.mockReset();
  getBaseUrlMock.mockReturnValue("http://localhost");
  listWorkbenchTodosMock.mockClear();
  listWorkbenchTodosMock.mockResolvedValue({ todos: [] });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockLifeOpsResponses();
  publishHomeAttentionSpy.mockClear();
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

  it("home slot: applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    mockLifeOpsResponses({
      todos: [
        {
          id: "owner-today",
          title: "Call pharmacy",
          status: "pending",
          dueDate: new Date().toISOString(),
        },
      ],
    });
    const { container } = render(
      <TodoWidget
        slot="home"
        events={[]}
        clearEvents={vi.fn()}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    expect(await screen.findByText("Call pharmacy")).toBeTruthy();
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-todos"]'),
    ).not.toBeNull();
  });

  it("home slot: falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    mockLifeOpsResponses({
      todos: [
        {
          id: "owner-today",
          title: "Call pharmacy",
          status: "pending",
          dueDate: new Date().toISOString(),
        },
      ],
    });
    const { container } = render(
      <TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />,
    );
    expect(await screen.findByText("Call pharmacy")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });

  it("home slot: renders only owner todos due or overdue today", async () => {
    mockState.workbench.todos = [
      {
        id: "workbench-1",
        name: "Agent workbench todo",
        description: "",
        type: "task",
        isCompleted: false,
        isUrgent: false,
        priority: null,
      },
    ];
    mockLifeOpsResponses({
      todos: [
        {
          id: "owner-overdue",
          title: "Pay rent",
          status: "pending",
          dueDate: isoDaysFromNow(-1),
        },
        {
          id: "owner-today",
          title: "Call pharmacy",
          status: "pending",
          dueDate: new Date().toISOString(),
        },
        {
          id: "owner-tomorrow",
          title: "Pack lunch",
          status: "pending",
          dueDate: isoDaysFromNow(1),
        },
        {
          id: "owner-undated",
          title: "Someday",
          status: "pending",
          dueDate: null,
        },
        {
          id: "owner-done",
          title: "Already done",
          status: "completed",
          dueDate: new Date().toISOString(),
        },
      ],
    });

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);

    expect(await screen.findByText("Pay rent")).toBeTruthy();
    expect(await screen.findByText("Call pharmacy")).toBeTruthy();
    expect(screen.queryByText("Pack lunch")).toBeNull();
    expect(screen.queryByText("Someday")).toBeNull();
    expect(screen.queryByText("Already done")).toBeNull();
    expect(screen.queryByText("Agent workbench todo")).toBeNull();
    expect(listWorkbenchTodosMock).not.toHaveBeenCalled();
  });

  it("home slot: completing an owner todo posts to the occurrence endpoint and refreshes", async () => {
    let completed = false;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/lifeops/todos")) {
          const todos = completed
            ? []
            : [
                {
                  id: "owner-today",
                  title: "Call pharmacy",
                  status: "pending",
                  dueDate: new Date().toISOString(),
                },
              ];
          return jsonResponse({ todos });
        }
        if (url.includes("/api/lifeops/goals")) {
          return jsonResponse({ goals: [] });
        }
        if (url.includes("/api/lifeops/occurrences/owner-today/complete")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            metadata: { source: "home_today_widget" },
          });
          completed = true;
          return jsonResponse({});
        }
        return jsonResponse({});
      },
    );

    render(<TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Complete "Call pharmacy"/ }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost/api/lifeops/occurrences/owner-today/complete",
        expect.objectContaining({ method: "POST" }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Call pharmacy")).toBeNull();
    });
  });

  it("home slot: renders an at-risk goal as one flagged row inside Today (spec §E item 5)", async () => {
    mockState.workbench.todos = [];
    listWorkbenchTodosMock.mockResolvedValue({ todos: [] });
    mockLifeOpsResponses({
      goals: [
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
    });

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
    mockState.workbench.todos = [];
    listWorkbenchTodosMock.mockResolvedValue({ todos: [] });
    mockLifeOpsResponses({
      goals: [
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
    });

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
