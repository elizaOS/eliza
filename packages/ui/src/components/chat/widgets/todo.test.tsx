// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBaseUrlMock,
  listWorkbenchTodosMock,
  mockState,
  publishHomeAttentionSpy,
} = vi.hoisted(() => ({
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
});
