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
});
