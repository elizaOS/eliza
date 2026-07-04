/**
 * Todos spatial view tests render deterministic HTML and TUI markup without a
 * live runtime.
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_LANES,
  type TodoCard,
  type TodosSnapshot,
  TodosSpatialView,
} from "./TodosSpatialView.tsx";

function card(overrides: Partial<TodoCard> & { id: string }): TodoCard {
  return {
    title: `Todo ${overrides.id}`,
    inProgress: false,
    due: "",
    ...overrides,
  };
}

const snapshot: TodosSnapshot = {
  state: "ready",
  overdue: 1,
  lanes: {
    today: [
      card({ id: "t1", title: "Overdue task", due: "Jun 20" }),
      card({ id: "t2", title: "Due soon", inProgress: true, due: "Jun 22" }),
    ],
    upcoming: [card({ id: "u1", title: "Plan trip", due: "Jun 27" })],
    someday: [card({ id: "s1", title: "Read a book" })],
  },
};

const view = <TodosSpatialView snapshot={snapshot} />;

describe("TodosSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Today");
      expect(flat).toContain("Upcoming");
      expect(flat).toContain("Someday");
      expect(flat).toContain("Overdue task");
      expect(flat).toContain("Plan trip");
      expect(flat).toContain("Read a book");
      expect(flat).toContain("overdue");
    }
  });

  it("GUI + XR: renders DOM with the surface marker and lane content, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Overdue task");
      expect(html).toContain("Plan trip");
      expect(html).toContain('data-agent-id="todo-t1"');
      expect(html).toContain('data-agent-id="todo-u1"');
    }
  });

  it("loading state renders a quiet loading line", () => {
    const loading: TodosSnapshot = {
      state: "loading",
      lanes: EMPTY_LANES,
      overdue: 0,
    };
    const lines = renderViewToLines(
      <TodosSpatialView snapshot={loading} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Loading");
  });

  it("empty state renders the add-a-todo affordance", () => {
    const empty: TodosSnapshot = {
      state: "empty",
      lanes: EMPTY_LANES,
      overdue: 0,
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <TodosSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(html).toContain("None");
    expect(html).toContain('data-agent-id="add"');
  });

  it("error state renders the message and a Retry control", () => {
    const error: TodosSnapshot = {
      state: "error",
      lanes: EMPTY_LANES,
      overdue: 0,
      error: "boom",
    };
    const lines = renderViewToLines(<TodosSpatialView snapshot={error} />, 54);
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("boom");
    expect(flat).toContain("Retry");

    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <TodosSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="retry"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("todos-test", () => view);
    try {
      const component = getTerminalView("todos-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Overdue task");
    } finally {
      unregister();
    }
  });
});
