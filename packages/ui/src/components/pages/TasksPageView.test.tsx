// @vitest-environment jsdom
//
// Structural tests for TasksPageView (#13565, views-redesign epic): the Tasks
// nav tab hosts the coding-agent tasks panel under the shared, uniform
// `ViewHeader`. We assert (a) the shell `ViewHeader` renders with the centered
// "Tasks" title and its icon-only back button, and (b) the panel is mounted in
// `fullPage` mode so it suppresses its own internal title row (one header per
// view, no duplicate heading). The panel + shell surface are mocked to isolate
// the host's composition from the panel's data behavior.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const panelProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

// The slot indirection resolves to the real coding-agent panel at runtime; here
// we stub it so the test asserts what props the host passes, not panel internals.
vi.mock("../../slots/task-coordinator-slots.js", () => ({
  CodingAgentTasksPanel: (props: Record<string, unknown>) => {
    panelProps.value = props;
    return <div data-testid="coding-agent-tasks-panel-stub" />;
  },
}));

import { TasksPageView } from "./TasksPageView";

afterEach(() => {
  cleanup();
  panelProps.value = null;
});

describe("TasksPageView", () => {
  it("renders the shared ViewHeader with a centered 'Tasks' title", () => {
    render(<TasksPageView />);
    const header = screen.getByTestId("view-header");
    expect(header).toBeTruthy();
    // The heading text lives in the ViewHeader's <h1>, not the panel.
    const heading = within(header).getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Tasks");
  });

  it("exposes the icon-only launcher back control from the header", () => {
    render(<TasksPageView />);
    // ViewBackButton is aria-labeled and icon-only (no visible text label).
    const back = screen.getByRole("button", { name: /back to launcher/i });
    expect(back).toBeTruthy();
    expect(back.textContent?.trim()).toBe("");
  });

  it("mounts the tasks panel in fullPage mode (panel suppresses its own header)", () => {
    render(<TasksPageView />);
    expect(screen.getByTestId("coding-agent-tasks-panel-stub")).toBeTruthy();
    expect(panelProps.value).toMatchObject({ fullPage: true });
  });

  it("wraps the view with the tasks-view test id", () => {
    render(<TasksPageView />);
    expect(screen.getByTestId("tasks-view")).toBeTruthy();
  });
});
