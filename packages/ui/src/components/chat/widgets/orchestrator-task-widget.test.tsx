/**
 * The shipped orchestrator task rail consumes initial and streamed snapshots,
 * renders lineage/progress, navigates into the workbench, and distinguishes
 * loading, empty, and failed server states. Transport is stubbed at the typed
 * client boundary; the real route/SSE process is covered by the plugin E2E.
 */

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorWidgetSnapshot } from "../../../api/client-orchestrator-widgets";

const mocks = vi.hoisted(() => ({
  getWidgets: vi.fn(),
  streamWidgets: vi.fn(),
  openedView: undefined as { path: string; pluginId: string } | undefined,
  streamClosed: false,
  streamSnapshot: undefined as
    | ((snapshot: OrchestratorWidgetSnapshot) => void)
    | undefined,
  streamError: undefined as ((error: Error) => void) | undefined,
}));

vi.mock("../../../api", () => ({
  client: {
    getOrchestratorWidgets: mocks.getWidgets,
    streamOrchestratorWidgets: mocks.streamWidgets,
  },
}));

vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => true,
}));

vi.mock("../../../state", () => ({
  useAppSelectorShallow: () => ({ t: undefined }),
}));

vi.mock("./home-widget-card", () => ({
  useWidgetNavigation: () => ({
    openView: (path: string, pluginId: string) => {
      mocks.openedView = { path, pluginId };
    },
  }),
}));

import { OrchestratorTaskWidget } from "./orchestrator-task-widget";

const populated: OrchestratorWidgetSnapshot = {
  version: "orchestrator.widgets.v1",
  generatedAt: "2026-07-13T00:00:00.000Z",
  totalTaskCount: 2,
  tasks: [
    {
      taskId: "task/parent",
      label: "Ship the orchestration rail",
      status: "running",
      model: "claude-opus-4-7",
      progressSummary: "Rendering the live SSE state",
      evidenceLinks: [],
      timestamps: {
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z",
      },
      childTaskIds: ["child-1"],
    },
  ],
};

const props = { events: [], clearEvents: vi.fn() };

beforeEach(() => {
  mocks.getWidgets.mockReset();
  mocks.streamWidgets.mockReset();
  mocks.openedView = undefined;
  mocks.streamClosed = false;
  mocks.streamSnapshot = undefined;
  mocks.streamError = undefined;
  mocks.streamWidgets.mockImplementation((_options, onSnapshot, onError) => {
    mocks.streamSnapshot = onSnapshot;
    mocks.streamError = onError;
    return () => {
      mocks.streamClosed = true;
    };
  });
});

afterEach(cleanup);

describe("OrchestratorTaskWidget", () => {
  it("renders the real compact DTO and opens its workbench task", async () => {
    mocks.getWidgets.mockResolvedValue(populated);
    render(<OrchestratorTaskWidget {...props} />);

    expect(await screen.findByText("Ship the orchestration rail")).toBeTruthy();
    expect(screen.getByText("Rendering the live SSE state")).toBeTruthy();
    expect(screen.getByText("1 child")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Ship the orchestration rail.*Open in workbench/i,
      }),
    );
    expect(mocks.openedView).toEqual({
      path: "/orchestrator?taskId=task%2Fparent",
      pluginId: "orchestrator",
    });
  });

  it("lets a shipped workbench host handle task selection in place", async () => {
    let selectedTaskId: string | undefined;
    mocks.getWidgets.mockResolvedValue(populated);
    render(
      <OrchestratorTaskWidget
        {...props}
        onOpenTask={(taskId) => {
          selectedTaskId = taskId;
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Ship the orchestration rail.*Open in workbench/i,
      }),
    );

    expect(selectedTaskId).toBe("task/parent");
    expect(mocks.openedView).toBeUndefined();
  });

  it("replaces the initial result when the SSE snapshot advances", async () => {
    mocks.getWidgets.mockResolvedValue({ ...populated, tasks: [] });
    render(<OrchestratorTaskWidget {...props} />);
    expect(await screen.findByText("No orchestration tasks yet")).toBeTruthy();

    await act(async () => {
      mocks.streamSnapshot?.(populated);
    });
    expect(await screen.findByText("Ship the orchestration rail")).toBeTruthy();
  });

  it("renders a retryable error instead of a healthy empty state", async () => {
    mocks.getWidgets.mockRejectedValue(new Error("task store unavailable"));
    render(<OrchestratorTaskWidget {...props} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("task store unavailable");
    // #10708 (chromeless widgets): the error state is a danger-tinted strip —
    // a radius + translucent fill, never the glass-card triad. It must NOT
    // reintroduce a `border border-*` on the container.
    const alertClass = alert.getAttribute("class") ?? "";
    expect(alertClass).not.toMatch(/\bborder\s+border-/);
    expect(alertClass).toMatch(/bg-danger/);
    expect(screen.queryByText("No orchestration tasks yet")).toBeNull();

    mocks.getWidgets.mockResolvedValue(populated);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry task progress" }),
    );
    expect(await screen.findByText("Ship the orchestration rail")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("keeps task metadata and the empty hint at accessible contrast", async () => {
    // The 9px metadata line and empty-state hint render `text-muted` at full
    // strength; the previous `/70` opacity was 3.54:1, below WCAG AA 4.5:1.
    mocks.getWidgets.mockResolvedValue(populated);
    const view = render(<OrchestratorTaskWidget {...props} />);
    const meta = (await screen.findByText("1 child")).parentElement;
    expect(meta?.className).toContain("text-muted");
    expect(meta?.className).not.toContain("text-muted/70");
    view.unmount();

    mocks.getWidgets.mockResolvedValue({ ...populated, tasks: [] });
    render(<OrchestratorTaskWidget {...props} />);
    const hint = await screen.findByText(
      "New coding tasks will appear here as they run.",
    );
    expect(hint.className).toContain("text-muted");
    expect(hint.className).not.toContain("text-muted/70");
  });

  it("closes the SSE subscription when the widget unmounts", () => {
    mocks.getWidgets.mockReturnValue(new Promise(() => {}));
    const view = render(<OrchestratorTaskWidget {...props} />);
    view.unmount();
    expect(mocks.streamClosed).toBe(true);
  });
});
