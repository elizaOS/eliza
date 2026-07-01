// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TrajectoryDetailResult,
  TrajectoryListResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { __resetResourceCache } from "../../hooks/resource-cache";
import { getViewChatBinding } from "../../state/view-chat-binding";
import { TrajectoriesView } from "./TrajectoriesView";

// TrajectoriesView + its embedded TrajectoryDetailView both talk to the runtime
// exclusively through the `client` singleton imported from `../../api/client`.
// That is the single data seam — mock it and drive everything else through the
// real components so we assert real state transitions, exact request payloads,
// the selected-id round-trip, and the confirm-gated mutations.
const clientMock = vi.hoisted(() => ({
  getTrajectories: vi.fn(),
  getTrajectoryDetail: vi.fn(),
  deleteTrajectories: vi.fn(),
  clearAllTrajectories: vi.fn(),
  exportTrajectories: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

// The view reads t / setActionNotice / copyToClipboard off the app store. Give
// it a deterministic translator (defaultValue with {{token}} interpolation, else
// an explicit label map) so text assertions are unambiguous, plus spied action
// callbacks so we can assert the notice payloads the mutations emit.
const stateMock = vi.hoisted(() => {
  const LABELS: Record<string, string> = {
    "trajectoriesview.NoTrajectoriesYet": "No trajectories yet",
    "trajectoriesview.NoTrajectoriesMatchingFilters": "No matching trajectories",
    "trajectoriesview.LoadingTrajectories": "Loading trajectories...",
    "trajectorydetailview.UnableToLoad": "Unable to load trajectory",
    "common.next": "Next",
    "common.prev": "Prev",
    "common.export": "Export",
    "common.tokens": "tokens",
  };
  const t = (
    key: string,
    options?: Record<string, unknown> & { defaultValue?: string },
  ): string => {
    if (options && typeof options.defaultValue === "string") {
      let out = options.defaultValue;
      for (const [k, v] of Object.entries(options)) {
        if (k === "defaultValue") continue;
        out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
      return out;
    }
    return LABELS[key] ?? key;
  };
  return {
    t,
    setActionNotice: vi.fn(),
    copyToClipboard: vi.fn(),
  };
});

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof stateMock) => unknown) => sel(stateMock),
}));

function traj(overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    id: "traj-1",
    agentId: "agent-1",
    source: "alpha",
    status: "completed",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_005_000,
    durationMs: 5000,
    llmCallCount: 2,
    providerAccessCount: 1,
    totalPromptTokens: 100,
    totalCompletionTokens: 40,
    scenarioId: null,
    batchId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    roomId: null,
    entityId: null,
    conversationId: null,
    metadata: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const TRAJ_1 = traj({ id: "traj-1", source: "alpha" });
const TRAJ_2 = traj({
  id: "traj-2",
  source: "beta",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

function list(
  trajectories: TrajectoryRecord[],
  overrides: Partial<TrajectoryListResult> = {},
): TrajectoryListResult {
  return {
    trajectories,
    total: trajectories.length,
    offset: 0,
    limit: 50,
    ...overrides,
  };
}

function detail(
  id: string,
  overrides: Partial<TrajectoryDetailResult> = {},
): TrajectoryDetailResult {
  const record = id === "traj-2" ? TRAJ_2 : TRAJ_1;
  return {
    trajectory: record,
    llmCalls: [
      {
        id: `${id}-call-1`,
        trajectoryId: id,
        stepId: "step-1",
        timestamp: 1_700_000_000_000,
        model: `model-${id}`,
        systemPrompt: "you are helpful",
        userPrompt: "hello there",
        response: "hi back",
        temperature: 0.2,
        maxTokens: 512,
        purpose: "response",
        actionType: "REPLY",
        stepType: "response",
        latencyMs: 1200,
        promptTokens: 100,
        completionTokens: 40,
        createdAt: "2026-01-01T00:00:00.000Z",
        tags: ["llm"],
      },
    ],
    providerAccesses: [
      {
        id: `${id}-prov-1`,
        trajectoryId: id,
        stepId: "step-1",
        providerName: "TimeProvider",
        purpose: "inject time",
        data: { now: "noon" },
        timestamp: 1_700_000_000_000,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetResourceCache();
  clientMock.getTrajectories.mockResolvedValue(list([TRAJ_1, TRAJ_2]));
  clientMock.getTrajectoryDetail.mockImplementation(async (id: string) =>
    detail(id),
  );
  clientMock.deleteTrajectories.mockResolvedValue({ deleted: 1 });
  clientMock.clearAllTrajectories.mockResolvedValue({ deleted: 2 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TrajectoriesView — list + selection", () => {
  it("fetches page 0 with the default limit, renders a sidebar item per record, and auto-opens the first trajectory's detail", async () => {
    render(<TrajectoriesView />);

    const sidebar = await screen.findByTestId("trajectories-sidebar");
    expect(within(sidebar).getByText("alpha")).toBeTruthy();
    expect(within(sidebar).getByText("beta")).toBeTruthy();

    // Exact request payload for the first page (no search).
    expect(clientMock.getTrajectories).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      search: undefined,
    });

    // Auto-selection opens the FIRST record's detail — the id round-trips into
    // the detail fetch, and the fetched llm-call model renders.
    await waitFor(() => {
      expect(clientMock.getTrajectoryDetail).toHaveBeenCalledWith("traj-1");
    });
    await waitFor(() =>
      expect(screen.getAllByText("model-traj-1").length).toBeGreaterThan(0),
    );
    // Provider access ("span") from the detail payload is rendered.
    expect(screen.getAllByText("TimeProvider").length).toBeGreaterThan(0);
  });

  it("round-trips the clicked trajectory id back to the controlled onSelect handler", async () => {
    const onSelect = vi.fn();
    render(
      <TrajectoriesView
        selectedTrajectoryId="traj-1"
        onSelectTrajectory={onSelect}
      />,
    );

    const sidebar = await screen.findByTestId("trajectories-sidebar");
    const betaButton = within(sidebar).getByText("beta").closest("button");
    expect(betaButton).toBeTruthy();

    fireEvent.click(betaButton as HTMLButtonElement);

    // The exact id — not the object, not the index — is handed back.
    expect(onSelect).toHaveBeenCalledWith("traj-2");
  });

  it("re-fetches detail for the newly selected trajectory in standalone mode", async () => {
    render(<TrajectoriesView />);

    const sidebar = await screen.findByTestId("trajectories-sidebar");
    await waitFor(() =>
      expect(clientMock.getTrajectoryDetail).toHaveBeenCalledWith("traj-1"),
    );

    fireEvent.click(
      within(sidebar).getByText("beta").closest("button") as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(clientMock.getTrajectoryDetail).toHaveBeenCalledWith("traj-2"),
    );
    await waitFor(() =>
      expect(screen.getAllByText("model-traj-2").length).toBeGreaterThan(0),
    );
  });
});

describe("TrajectoriesView — search / filter", () => {
  it("re-queries with the search term (page reset to 0) and clears it back to undefined", async () => {
    clientMock.getTrajectories.mockImplementation(
      async (opts: { search?: string }) =>
        opts.search
          ? list([TRAJ_2], { total: 1 })
          : list([TRAJ_1, TRAJ_2]),
    );

    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    expect(within(sidebar).getByText("alpha")).toBeTruthy();

    // The composer binding is this view's search box.
    const binding = getViewChatBinding();
    expect(binding?.onQuery).toBeTypeOf("function");

    act(() => binding?.onQuery?.("beta"));

    await waitFor(() =>
      expect(clientMock.getTrajectories).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        search: "beta",
      }),
    );
    // Filtered list only shows the match.
    await waitFor(() => {
      expect(within(sidebar).queryByText("alpha")).toBeNull();
    });
    expect(within(sidebar).getByText("beta")).toBeTruthy();

    // Clearing the box drops the search param entirely (empty !== "  " garbage).
    act(() => binding?.onQuery?.(""));
    await waitFor(() =>
      expect(clientMock.getTrajectories).toHaveBeenLastCalledWith({
        limit: 50,
        offset: 0,
        search: undefined,
      }),
    );
  });
});

describe("TrajectoriesView — pagination", () => {
  it("advances the offset by pageSize when Next is clicked and only shows pager past one page", async () => {
    clientMock.getTrajectories.mockImplementation(
      async (opts: { offset: number }) =>
        opts.offset === 0
          ? list([TRAJ_1, TRAJ_2], { total: 120, offset: 0 })
          : list([traj({ id: "traj-50", source: "gamma" })], {
              total: 120,
              offset: 50,
            }),
    );

    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");

    const next = within(sidebar).getByRole("button", { name: "Next" });
    expect(next.hasAttribute("disabled")).toBe(false);
    // On the first page, Prev is disabled.
    expect(
      within(sidebar)
        .getByRole("button", { name: "Prev" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(next);

    await waitFor(() =>
      expect(clientMock.getTrajectories).toHaveBeenCalledWith({
        limit: 50,
        offset: 50,
        search: undefined,
      }),
    );
    expect(await within(sidebar).findByText("gamma")).toBeTruthy();
  });

  it("hides the pager when the total fits on a single page", async () => {
    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    await within(sidebar).findByText("alpha");

    expect(within(sidebar).queryByRole("button", { name: "Next" })).toBeNull();
    expect(within(sidebar).queryByRole("button", { name: "Prev" })).toBeNull();
  });
});

describe("TrajectoriesView — empty / loading / error", () => {
  it("shows the loading placeholder while the first fetch is in flight, then the list", async () => {
    const gate = deferred<TrajectoryListResult>();
    clientMock.getTrajectories.mockReturnValueOnce(gate.promise);

    render(<TrajectoriesView />);

    expect(screen.getByText("Loading trajectories...")).toBeTruthy();

    await act(async () => {
      gate.resolve(list([TRAJ_1, TRAJ_2]));
      await gate.promise;
    });

    await waitFor(() =>
      expect(screen.queryByText("Loading trajectories...")).toBeNull(),
    );
    expect(screen.getByTestId("trajectories-sidebar")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("renders the empty state when there are no trajectories", async () => {
    clientMock.getTrajectories.mockResolvedValue(list([]));

    render(<TrajectoriesView />);

    await waitFor(() =>
      expect(screen.getAllByText("No trajectories yet").length).toBeGreaterThan(
        0,
      ),
    );
    // With nothing selected, detail is never fetched.
    expect(clientMock.getTrajectoryDetail).not.toHaveBeenCalled();
  });

  it("surfaces the list fetch error in a danger notice and shows no detail", async () => {
    clientMock.getTrajectories.mockRejectedValue(new Error("list boom"));

    render(<TrajectoriesView />);

    await waitFor(() =>
      expect(screen.getByText("list boom")).toBeTruthy(),
    );
    expect(clientMock.getTrajectoryDetail).not.toHaveBeenCalled();
  });

  it("shows the detail error panel when the detail fetch fails (list still renders)", async () => {
    clientMock.getTrajectoryDetail.mockRejectedValue(new Error("detail boom"));

    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    expect(within(sidebar).getByText("alpha")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("detail boom")).toBeTruthy());
  });
});

describe("TrajectoriesView — delete (confirm-gated)", () => {
  it("does NOT delete until the confirm step is taken, then deletes the selected id and emits a success notice", async () => {
    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    await within(sidebar).findByText("alpha");

    // First click only opens the confirmation — no mutation yet.
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Delete current" }),
    );
    expect(clientMock.deleteTrajectories).not.toHaveBeenCalled();

    // Confirm fires the delete with the currently-selected id.
    fireEvent.click(within(sidebar).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(clientMock.deleteTrajectories).toHaveBeenCalledWith(["traj-1"]),
    );
    await waitFor(() =>
      expect(stateMock.setActionNotice).toHaveBeenCalledWith(
        "Trajectory deleted.",
        "success",
        2400,
      ),
    );
  });

  it("cancels the delete without mutating", async () => {
    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    await within(sidebar).findByText("alpha");

    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Delete current" }),
    );
    fireEvent.click(within(sidebar).getByRole("button", { name: "Cancel" }));

    expect(clientMock.deleteTrajectories).not.toHaveBeenCalled();
    // Back to the trigger, list intact.
    expect(
      within(sidebar).getByRole("button", { name: "Delete current" }),
    ).toBeTruthy();
  });

  it("is idempotent under an in-flight delete: the trigger disables and cannot re-fire", async () => {
    const gate = deferred<{ deleted: number }>();
    clientMock.deleteTrajectories.mockReturnValueOnce(gate.promise);

    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    await within(sidebar).findByText("alpha");

    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Delete current" }),
    );
    fireEvent.click(within(sidebar).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(clientMock.deleteTrajectories).toHaveBeenCalledTimes(1),
    );

    // While the delete is pending the trigger is disabled — hammering it does
    // not queue a second delete.
    const trigger = within(sidebar).getByRole("button", {
      name: "Delete current",
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(clientMock.deleteTrajectories).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ deleted: 1 });
      await gate.promise;
    });
  });
});

describe("TrajectoriesView — clear all (confirm-gated)", () => {
  it("clears every trajectory after confirm and drops to the empty state", async () => {
    render(<TrajectoriesView />);
    const sidebar = await screen.findByTestId("trajectories-sidebar");
    await within(sidebar).findByText("alpha");

    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Clear all" }),
    );
    expect(clientMock.clearAllTrajectories).not.toHaveBeenCalled();

    fireEvent.click(within(sidebar).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(clientMock.clearAllTrajectories).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("No trajectories yet").length,
      ).toBeGreaterThan(0),
    );
    expect(stateMock.setActionNotice).toHaveBeenCalledWith(
      "Trajectories cleared.",
      "success",
      2400,
    );
  });
});
