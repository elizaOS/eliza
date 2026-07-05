// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authMock,
  getBaseUrlMock,
  listWorkbenchTodosMock,
  mockState,
  publishHomeAttentionSpy,
} = vi.hoisted(() => ({
  // Auth gate (#11084) — mutable so tests can flip the session state.
  authMock: { authenticated: true },
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  listWorkbenchTodosMock: vi.fn(async () => ({ todos: [] })),
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
  publishHomeAttentionSpy.mockClear();
  authMock.authenticated = true;
});

afterEach(() => {
  cleanup();
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

  // #11084 — the widget mounts before the auth probe resolves; its workbench
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
    // Hold the cached todo (no poll) so the card stays rendered while asserting.
    authMock.authenticated = false;
    const { container } = render(
      <TodoWidget
        slot="home"
        events={[]}
        clearEvents={vi.fn()}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    expect(await screen.findByText("Cached todo")).toBeTruthy();
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-todos"]'),
    ).not.toBeNull();
  });

  it("home slot: falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    authMock.authenticated = false;
    const { container } = render(
      <TodoWidget slot="home" events={[]} clearEvents={vi.fn()} />,
    );
    expect(await screen.findByText("Cached todo")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("col-span-2");
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
