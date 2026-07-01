// @vitest-environment jsdom
//
// Behavioral coverage for the chat-sidebar Todos widget (`TODO_PLUGIN_WIDGETS`).
//
// Reality check: the FOCUS brief mentions "completing/toggling a todo" and
// "tapping navigates to todos". The component that is actually registered and
// mounted (`TodoSidebarWidget` in ./todo) is a READ-ONLY display widget — it
// renders no checkbox/toggle control and passes no `onTitleClick`, so there is
// no toggle mutation and no navigation rail to exercise. The real API boundary
// it drives is `client.listWorkbenchTodos()` (a refresh read), seeded from the
// `state.workbench.todos` slice. These tests assert that real behavior: the
// seed→render, the exact refresh call + its result replacing the render, the
// empty / loading / error states, the home-slot self-hide + attention signal,
// the visible cap, dedupe, and rapid-fire poll idempotency.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkbenchOverview,
  WorkbenchTodo,
} from "../../../api/client-types-config";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";

const { listWorkbenchTodosMock, publishMock, intervalRef } = vi.hoisted(() => ({
  listWorkbenchTodosMock: vi.fn(),
  publishMock: vi.fn(),
  intervalRef: { callback: null as null | (() => void) },
}));

// Collaborator: the typed HTTP client. Only the refresh read is exercised.
vi.mock("../../../api", () => ({
  client: { listWorkbenchTodos: listWorkbenchTodosMock },
}));

// Collaborator: the home-attention self-signal hook. Spy so we can assert the
// urgent weight is (or isn't) published on the home slot.
vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishMock,
}));

// Collaborator: the visibility-gated poll. Capture the latest callback so a
// test can simulate a poll tick deterministically (no real timers/visibility).
vi.mock("../../../hooks", () => ({
  useIntervalWhenDocumentVisible: (cb: () => void) => {
    intervalRef.callback = cb;
  },
}));

// Collaborator: the app store. Drive the workbench slice + translate fn from a
// single mutable holder. The `workbench` object identity is kept STABLE within
// a test (set once before render) so the widget's `[workbench?.todos]` effect
// does not loop.
let appState: { workbench: WorkbenchOverview | undefined; t: null } = {
  workbench: undefined,
  t: null,
};
vi.mock("../../../state", () => ({
  useAppSelectorShallow: <T,>(selector: (s: typeof appState) => T): T =>
    selector(appState),
}));

import { TODO_PLUGIN_WIDGETS } from "./todo";

const TodoSidebarWidget = TODO_PLUGIN_WIDGETS[0].Component;

function todo(
  over: Partial<WorkbenchTodo> & { id: string; name: string },
): WorkbenchTodo {
  return {
    description: "",
    priority: null,
    isUrgent: false,
    isCompleted: false,
    type: "task",
    ...over,
  };
}

function workbench(todos: WorkbenchTodo[]): WorkbenchOverview {
  return { tasks: [], triggers: [], todos };
}

/** Seed the store slice, then render. `refresh` defaults to echoing the seed. */
async function renderWidget(
  seed: WorkbenchTodo[],
  opts: {
    slot?: "home";
    refresh?: WorkbenchTodo[] | Promise<{ todos: WorkbenchTodo[] }>;
  } = {},
) {
  appState = { workbench: workbench(seed), t: null };
  if (opts.refresh instanceof Promise) {
    listWorkbenchTodosMock.mockReturnValue(opts.refresh);
  } else {
    listWorkbenchTodosMock.mockResolvedValue({ todos: opts.refresh ?? seed });
  }
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<TodoSidebarWidget events={[]} clearEvents={() => {}} slot={opts.slot} />);
  });
  // biome-ignore lint/style/noNonNullAssertion: assigned inside act above.
  return result!;
}

afterEach(() => {
  cleanup();
  intervalRef.callback = null;
});

beforeEach(() => {
  listWorkbenchTodosMock.mockReset();
  publishMock.mockReset();
});

describe("TodoSidebarWidget", () => {
  it("renders open todos seeded from the store, urgent-first", async () => {
    const { container } = await renderWidget([
      todo({ id: "a", name: "Plain task" }),
      todo({ id: "b", name: "Fire drill", isUrgent: true }),
      todo({ id: "c", name: "Prioritized", priority: 1 }),
    ]);

    const section = container.querySelector(
      '[data-testid="chat-widget-todos"]',
    ) as HTMLElement;
    expect(section).not.toBeNull();
    const names = Array.from(
      section.querySelectorAll(".truncate.text-txt"),
    ).map((el) => el.textContent);
    // Sort contract: urgent first, then prioritized, then plain (name tiebreak).
    expect(names).toEqual(["Fire drill", "Prioritized", "Plain task"]);
    // Urgent row carries its badge.
    expect(section.textContent).toContain("Urgent");
    expect(section.textContent).toContain("P1");
  });

  it("calls client.listWorkbenchTodos exactly once on mount and renders the fetched result over the seed", async () => {
    await renderWidget([todo({ id: "seed", name: "Stale seed" })], {
      refresh: [todo({ id: "fresh", name: "Fresh from server" })],
    });

    expect(listWorkbenchTodosMock).toHaveBeenCalledTimes(1);
    expect(listWorkbenchTodosMock).toHaveBeenCalledWith();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Fresh from server");
    });
    // The server result replaces the seed, not merges with it.
    expect(document.body.textContent).not.toContain("Stale seed");
  });

  it("shows the explicit empty state (not blank) when there are no open todos in the chat slot", async () => {
    const { container } = await renderWidget([
      todo({ id: "done", name: "Finished", isCompleted: true }),
    ]);
    const section = container.querySelector(
      '[data-testid="chat-widget-todos"]',
    ) as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain("No open todos");
    // A single completed todo => "1 completed todo hidden" (singular).
    expect(section.textContent).not.toContain("1 completed todos");
  });

  it("shows the loading placeholder while the first (non-silent) refresh is in flight with no seed", async () => {
    // Deferred refresh so we can observe the pending state deterministically.
    let resolve!: (v: { todos: WorkbenchTodo[] }) => void;
    const pending = new Promise<{ todos: WorkbenchTodo[] }>((r) => {
      resolve = r;
    });
    const { container } = await renderWidget([], { refresh: pending });

    const section = container.querySelector(
      '[data-testid="chat-widget-todos"]',
    ) as HTMLElement;
    expect(section.textContent).toContain("Refreshing todos");

    await act(async () => {
      resolve({ todos: [todo({ id: "x", name: "Arrived" })] });
      await pending;
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Arrived");
    });
    expect(container.textContent).not.toContain("Refreshing todos");
  });

  it("keeps the seeded todos when the refresh rejects (error does not blank the list)", async () => {
    await renderWidget([todo({ id: "s", name: "Survives failure" })], {
      refresh: Promise.reject(new Error("network down")),
    });
    // The seed persists; the widget does not fall back to an empty render.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Survives failure");
    });
    expect(document.body.textContent).not.toContain("No open todos");
    expect(document.body.textContent).not.toContain("Refreshing todos");
  });

  it("self-hides (renders null) on the home slot when there are no open todos", async () => {
    const { container } = await renderWidget([], { slot: "home" });
    expect(container.querySelector('[data-testid="chat-widget-todos"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes the reminder weight on the home slot only when an open todo is urgent", async () => {
    await renderWidget([todo({ id: "u", name: "Urgent", isUrgent: true })], {
      slot: "home",
    });
    expect(publishMock).toHaveBeenLastCalledWith(
      "todo/todo.items",
      HOME_SIGNAL_WEIGHTS.reminder,
    );
  });

  it("clears the home attention signal (null) when no open todo is urgent", async () => {
    await renderWidget([todo({ id: "n", name: "Calm", priority: 2 })], {
      slot: "home",
    });
    expect(publishMock).toHaveBeenLastCalledWith("todo/todo.items", null);
  });

  it("caps visible open todos at 8 and reports the overflow + hidden-completed counts", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      todo({ id: `o${i}`, name: `Open ${i}` }),
    );
    many.push(todo({ id: "d1", name: "Done 1", isCompleted: true }));
    many.push(todo({ id: "d2", name: "Done 2", isCompleted: true }));
    const { container } = await renderWidget(many);

    const section = container.querySelector(
      '[data-testid="chat-widget-todos"]',
    ) as HTMLElement;
    const rows = section.querySelectorAll(".truncate.text-txt");
    expect(rows.length).toBe(8);
    // 10 open, 8 shown => "+2 more open todos" (plural).
    expect(section.textContent).toContain("+2 more open todos");
    // 2 completed folded away.
    expect(section.textContent).toContain("2 completed todos hidden");
  });

  it("dedupes todos that share an id, keeping the last write", async () => {
    const { container } = await renderWidget([
      todo({ id: "dup", name: "First copy" }),
      todo({ id: "dup", name: "Second copy" }),
      todo({ id: "other", name: "Untouched" }),
    ]);
    const section = container.querySelector(
      '[data-testid="chat-widget-todos"]',
    ) as HTMLElement;
    const names = Array.from(
      section.querySelectorAll(".truncate.text-txt"),
    ).map((el) => el.textContent);
    expect(names).toContain("Second copy");
    expect(names).not.toContain("First copy");
    expect(names.filter((n) => n === "Second copy")).toHaveLength(1);
    expect(names).toContain("Untouched");
  });

  it("is idempotent under rapid-fire poll ticks — extra refreshes re-render the same list without crashing", async () => {
    await renderWidget([todo({ id: "seed", name: "Item" })], {
      refresh: [todo({ id: "seed", name: "Item" })],
    });
    expect(intervalRef.callback).toBeTypeOf("function");
    // Simulate five back-to-back visibility poll ticks.
    await act(async () => {
      for (let i = 0; i < 5; i++) intervalRef.callback?.();
      await Promise.resolve();
    });
    // 1 mount call + 5 poll ticks.
    expect(listWorkbenchTodosMock).toHaveBeenCalledTimes(6);
    expect(document.body.textContent).toContain("Item");
    // Never a duplicate render of the single item.
    const rows = document.querySelectorAll(
      '[data-testid="chat-widget-todos"] .truncate.text-txt',
    );
    expect(rows.length).toBe(1);
  });
});
