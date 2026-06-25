// @vitest-environment jsdom

/**
 * GoalsView is the single GUI/XR data wrapper over the read-only goals endpoint
 * served by the personal-assistant routes:
 *   GET {base}/api/lifeops/goals  ->  { goals: LifeOpsGoalRecord[] }
 *
 * It owns the fetch state machine (loading / error / ready), the status-filter
 * selection, and the quiet background poll, then renders the unified
 * {@link GoalsSpatialView} inside a SpatialSurface. These tests drive the
 * rendered spatial DOM — the same surface the bundle exports for the "gui" and
 * "xr" modalities — asserting the populated grouped list, the status-filter
 * toggle, the error -> Retry refetch, the empty set-a-goal chat affordance, and
 * the quiet 20s poll. The fetcher seam is injected so the suite stays offline;
 * `@elizaos/ui` is mocked so the wrapper renders outside a provider.
 *
 * External-API contract: the wire shape is mirrored verbatim from the PA
 * `/api/lifeops/goals` response (LifeOpsGoalRecord = { goal, links } from
 * @elizaos/shared); the fixtures below match that shape field-for-field.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; GoalsView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (set-a-goal affordance).
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));

import {
  type GoalsFetchers,
  GoalsView,
} from "../src/components/goals/GoalsView.tsx";

// ---------------------------------------------------------------------------
// Wire fixtures — mirror { goals: LifeOpsGoalRecord[] } exactly.
// ---------------------------------------------------------------------------

function goalRecord(
  overrides: {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    reviewState?: string;
    cadenceKind?: string | null;
    target?: string | null;
    linkCount?: number;
  } = {},
) {
  const id = overrides.id ?? "goal-1";
  const linkCount = overrides.linkCount ?? 0;
  return {
    goal: {
      id,
      agentId: "agent-1",
      domain: "personal",
      subjectType: "owner",
      subjectId: "owner-1",
      visibilityScope: "private",
      contextPolicy: "owner_only",
      title: overrides.title ?? "Run a half marathon",
      description: overrides.description ?? "Build up to 21km by autumn.",
      cadence:
        overrides.cadenceKind === undefined
          ? { kind: "weekly" }
          : overrides.cadenceKind === null
            ? null
            : { kind: overrides.cadenceKind },
      successCriteria:
        overrides.target === undefined
          ? { targetText: "21km continuous run" }
          : overrides.target === null
            ? {}
            : { targetText: overrides.target },
      status: overrides.status ?? "active",
      reviewState: overrides.reviewState ?? "on_track",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    },
    links: Array.from({ length: linkCount }, (_, i) => ({
      id: `link-${id}-${i}`,
      agentId: "agent-1",
      goalId: id,
      linkedType: "occurrence",
      linkedId: `occ-${i}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

function makeFetchers(overrides: Partial<GoalsFetchers> = {}): GoalsFetchers {
  return {
    fetchGoals: async () => ({ goals: [goalRecord()] }),
    ...overrides,
  };
}

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

function queryAgent(agentId: string): HTMLElement | null {
  return document.querySelector(
    `[data-agent-id="${agentId}"]`,
  ) as HTMLElement | null;
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("GoalsView — spatial GUI/XR wrapper", () => {
  it("shows the loading line while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(<GoalsView fetchers={makeFetchers({ fetchGoals: () => never })} />);
    expect(screen.getByText("Loading goals")).toBeTruthy();
  });

  it("renders the populated list grouped by status with real fields", async () => {
    render(
      <GoalsView
        fetchers={makeFetchers({
          fetchGoals: async () => ({
            goals: [
              goalRecord({
                id: "g-active",
                title: "Run a half marathon",
                status: "active",
                reviewState: "on_track",
                cadenceKind: "weekly",
                target: "21km continuous run",
                linkCount: 2,
              }),
              goalRecord({
                id: "g-paused",
                title: "Learn Spanish",
                status: "paused",
                reviewState: "idle",
              }),
            ],
          }),
        })}
      />,
    );
    await screen.findByText("Run a half marathon");
    // Cadence + target + linked-count meta line.
    expect(
      screen.getByText(/weekly · 21km continuous run · 2 linked/),
    ).toBeTruthy();
    expect(screen.getByText("Learn Spanish")).toBeTruthy();
    // The status-filter chips are present and addressable by the agent surface.
    expect(agent("filter:active")).toBeTruthy();
    expect(agent("filter:paused")).toBeTruthy();
  });

  it("shows the empty state when zero goals exist (no fabricated goals)", async () => {
    render(
      <GoalsView
        fetchers={makeFetchers({ fetchGoals: async () => ({ goals: [] }) })}
      />,
    );
    // #9486 'declutter plugin app views' replaced the "No goals yet" empty-state
    // copy with a bold "None" + the set-a-goal affordance; wait on the affordance
    // (data-agent-id="new", unique to the empty state) instead of the removed text.
    await waitFor(() => {
      expect(queryAgent("new")).not.toBeNull();
    });
    expect(queryAgent("filter:active")).toBeNull();
  });

  it("routes the set-a-goal affordance through the assistant chat", async () => {
    render(
      <GoalsView
        fetchers={makeFetchers({ fetchGoals: async () => ({ goals: [] }) })}
      />,
    );
    // #9486 'declutter plugin app views' replaced the "No goals yet" empty-state
    // copy with a bold "None" + the set-a-goal affordance; wait on the affordance
    // (data-agent-id="new", unique to the empty state) instead of the removed text.
    await waitFor(() => {
      expect(queryAgent("new")).not.toBeNull();
    });
    fireEvent.click(agent("new"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into the populated list", async () => {
    let attempt = 0;
    const fetchGoals = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { goals: [goalRecord()] };
    };
    render(<GoalsView fetchers={makeFetchers({ fetchGoals })} />);
    await screen.findByText("Could not load goals");
    expect(screen.getByText("boom")).toBeTruthy();
    fireEvent.click(agent("retry"));
    await screen.findByText("Run a half marathon");
  });

  it("quietly refetches on the background poll (no manual refresh control)", async () => {
    let calls = 0;
    const fetchGoals = async () => {
      calls += 1;
      return { goals: [goalRecord({ title: `pass ${calls}` })] };
    };
    vi.useFakeTimers();
    try {
      render(<GoalsView fetchers={makeFetchers({ fetchGoals })} />);
      await vi.waitFor(() => {
        expect(screen.getByText("pass 1")).toBeTruthy();
      });
      expect(calls).toBe(1);

      // One poll tick → exactly one more silent refetch, no loading flash.
      await vi.advanceTimersByTimeAsync(20000);
      expect(calls).toBe(2);
      await vi.waitFor(() => {
        expect(screen.getByText("pass 2")).toBeTruthy();
      });
      expect(screen.queryByText("Loading goals")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows the visible groups when a status filter chip is toggled", async () => {
    render(
      <GoalsView
        fetchers={makeFetchers({
          fetchGoals: async () => ({
            goals: [
              goalRecord({ id: "g-active", status: "active" }),
              goalRecord({
                id: "g-paused",
                title: "Learn Spanish",
                status: "paused",
              }),
            ],
          }),
        })}
      />,
    );
    await screen.findByText("Run a half marathon");
    expect(screen.getByText("Learn Spanish")).toBeTruthy();

    // Toggle the "Paused" filter: only the paused group should remain.
    fireEvent.click(agent("filter:paused"));
    await waitFor(() =>
      expect(screen.queryByText("Run a half marathon")).toBeNull(),
    );
    expect(screen.getByText("Learn Spanish")).toBeTruthy();
  });
});
