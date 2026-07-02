// @vitest-environment jsdom
//
// E2E-ish: drives the CockpitRoute container through the REAL spawn path
// (poll roster -> render deck -> form submit -> client.createOrchestratorTask),
// mocking only at the client boundary (the live orchestrator). Proves the
// cockpit's spawn wiring end to end without a running agent.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrchestratorRooms: vi.fn(),
  createOrchestratorTask: vi.fn(),
  addOrchestratorAgent: vi.fn(),
}));

type ButtonMockProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> & {
  agent?: string;
  children?: ReactNode;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  size?: string;
  variant?: string;
};

vi.mock("@elizaos/ui", () => ({
  client: {
    getOrchestratorRooms: mocks.getOrchestratorRooms,
    createOrchestratorTask: mocks.createOrchestratorTask,
    addOrchestratorAgent: mocks.addOrchestratorAgent,
  },
  Button: (props: ButtonMockProps) => {
    const {
      children,
      variant: _variant,
      size: _size,
      agent: _agent,
      onPress,
      onClick,
      ...rest
    } = props;
    return (
      <button type="button" {...rest} onClick={onClick ?? onPress}>
        {children}
      </button>
    );
  },
  // Stub the presentational view: surface the deck count + a spawn button that
  // fires onCreateSession with a representative create-task input.
  CockpitView: (props: {
    rooms: { rooms: unknown[] } | null;
    onCreateSession: (i: unknown) => void;
    onSelectRoom?: (id: string) => void;
    busy?: boolean;
    error?: string | null;
  }) => (
    <div>
      <span data-testid="rooms-count">{props.rooms?.rooms?.length ?? -1}</span>
      {props.error ? <span data-testid="err">{props.error}</span> : null}
      <button
        type="button"
        data-testid="spawn"
        disabled={props.busy}
        onClick={() =>
          props.onCreateSession({
            title: "fix the auth bug",
            goal: "fix the auth bug",
            providerPolicy: {
              preferredFramework: "elizaos",
              providerSource: "eliza-cloud",
              model: "gemma-4-31b",
            },
          })
        }
      >
        spawn
      </button>
      <button
        type="button"
        data-testid="drill-in"
        onClick={() => props.onSelectRoom?.("task-1")}
      >
        open
      </button>
    </div>
  ),
}));

// Stub the (separately-tested) heavy session pane — the container test only
// proves the drill-in ROUTING (deck ⇄ pane), not the pane internals.
vi.mock("./CockpitSessionPane", () => ({
  CockpitSessionPane: (props: { taskId: string; onBack: () => void }) => (
    <div>
      <span data-testid="pane-task">{props.taskId}</span>
      <button type="button" data-testid="pane-back" onClick={props.onBack}>
        back
      </button>
    </div>
  ),
}));

import { CockpitRoute } from "./CockpitRoute";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CockpitRoute — live spawn wiring (agent mocked at client boundary)", () => {
  beforeEach(() => {
    mocks.getOrchestratorRooms.mockResolvedValue({ rooms: [{ taskId: "t1" }] });
    mocks.createOrchestratorTask.mockResolvedValue({ id: "task-1" });
    mocks.addOrchestratorAgent.mockResolvedValue({ id: "task-1" });
  });

  it("polls the room roster and renders the deck", async () => {
    render(<CockpitRoute />);
    await waitFor(() => expect(mocks.getOrchestratorRooms).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("rooms-count").textContent).toBe("1"),
    );
  });

  it("spawning creates the task AND spawns the agent with the picked mode", async () => {
    render(<CockpitRoute />);
    await waitFor(() => expect(mocks.getOrchestratorRooms).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("spawn"));
    // 1. the durable task is created with the providerPolicy
    await waitFor(() =>
      expect(mocks.createOrchestratorTask).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: "fix the auth bug",
          providerPolicy: expect.objectContaining({
            preferredFramework: "elizaos",
            providerSource: "eliza-cloud",
          }),
        }),
      ),
    );
    // 2. and the coding agent is ACTUALLY spawned into it with the picked mode
    // (regression guard for the "create writes an idle row that spawns nothing"
    // bug — create alone is not enough).
    await waitFor(() =>
      expect(mocks.addOrchestratorAgent).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({
          framework: "elizaos",
          providerSource: "eliza-cloud",
          model: "gemma-4-31b",
          task: "fix the auth bug",
        }),
      ),
    );
  });

  it("drills into a room and back (deck ⇄ session pane)", async () => {
    render(<CockpitRoute />);
    await waitFor(() => expect(mocks.getOrchestratorRooms).toHaveBeenCalled());
    // tap a deck room → the focused session pane replaces the deck
    fireEvent.click(screen.getByTestId("drill-in"));
    await waitFor(() =>
      expect(screen.getByTestId("pane-task").textContent).toBe("task-1"),
    );
    expect(screen.queryByTestId("rooms-count")).toBeNull();
    // back → the deck returns
    fireEvent.click(screen.getByTestId("pane-back"));
    await waitFor(() => expect(screen.getByTestId("rooms-count")).toBeTruthy());
    expect(screen.queryByTestId("pane-task")).toBeNull();
  });

  it("surfaces a roster-fetch error", async () => {
    mocks.getOrchestratorRooms.mockRejectedValue(
      new Error("orchestrator down"),
    );
    render(<CockpitRoute />);
    await waitFor(() =>
      expect(screen.getByTestId("err").textContent).toContain(
        "orchestrator down",
      ),
    );
  });
});
