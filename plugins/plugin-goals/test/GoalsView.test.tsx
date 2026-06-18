// @vitest-environment jsdom

/**
 * GoalsView is a data-fetching view over the single read-only goals endpoint
 * served by the personal-assistant routes:
 *   GET {base}/api/lifeops/goals  ->  { goals: LifeOpsGoalRecord[] }
 *
 * These tests cover the four-state machine (loading / error / empty / populated)
 * plus the retry, refresh, status-filter, and set-a-goal affordances. The
 * fetcher seam is injected so the suite stays offline; `@elizaos/ui` and
 * `@elizaos/ui/agent-surface` are mocked so the instrumented controls render
 * outside a provider.
 *
 * External-API contract test: the wire shape is mirrored verbatim from the PA
 * `/api/lifeops/goals` response (LifeOpsGoalRecord = { goal, links } from
 * @elizaos/shared); the fixtures below match that shape field-for-field.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; GoalsView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (set-a-goal affordance). `@elizaos/ui/agent-surface`
// is mocked to an inert hook so the instrumented controls render outside a
// provider.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
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

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("GoalsView", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(<GoalsView fetchers={makeFetchers({ fetchGoals: () => never })} />);
    expect(screen.getByTestId("goals-loading")).toBeTruthy();
  });

  it("renders the populated goals list grouped by status with real fields", async () => {
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
    expect(await screen.findByTestId("goals-populated")).toBeTruthy();
    const activeGroup = screen.getByTestId("goals-group-active");
    expect(within(activeGroup).getByText("Run a half marathon")).toBeTruthy();
    // Cadence + target + linked-count meta line.
    expect(
      within(activeGroup).getByText(/weekly · 21km continuous run · 2 linked/),
    ).toBeTruthy();
    expect(screen.getByTestId("goals-group-paused")).toBeTruthy();
    expect(screen.getByText("Learn Spanish")).toBeTruthy();
  });

  it("shows the empty state when zero goals exist (no fabricated goals)", async () => {
    render(
      <GoalsView
        fetchers={makeFetchers({ fetchGoals: async () => ({ goals: [] }) })}
      />,
    );
    expect(await screen.findByTestId("goals-empty")).toBeTruthy();
    expect(screen.getByText(/No goals yet/i)).toBeTruthy();
    expect(screen.queryByTestId("goals-populated")).toBeNull();
  });

  it("routes the set-a-goal affordance through the assistant chat", async () => {
    render(
      <GoalsView
        fetchers={makeFetchers({ fetchGoals: async () => ({ goals: [] }) })}
      />,
    );
    await screen.findByTestId("goals-empty");
    fireEvent.click(screen.getByRole("button", { name: /set a goal/i }));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into the populated state", async () => {
    let attempt = 0;
    const fetchGoals = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { goals: [goalRecord()] };
    };
    render(<GoalsView fetchers={makeFetchers({ fetchGoals })} />);
    expect(await screen.findByTestId("goals-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("goals-populated")).toBeTruthy();
  });

  it("refetches when the header refresh control is activated", async () => {
    let calls = 0;
    const fetchGoals = async () => {
      calls += 1;
      return { goals: [goalRecord()] };
    };
    render(<GoalsView fetchers={makeFetchers({ fetchGoals })} />);
    await screen.findByTestId("goals-populated");
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(calls).toBe(2));
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
    await screen.findByTestId("goals-populated");
    expect(screen.getByTestId("goals-group-active")).toBeTruthy();
    expect(screen.getByTestId("goals-group-paused")).toBeTruthy();

    // Toggle the "Paused" filter: only the paused group should remain.
    fireEvent.click(screen.getByRole("button", { name: "Paused" }));
    await waitFor(() =>
      expect(screen.queryByTestId("goals-group-active")).toBeNull(),
    );
    expect(screen.getByTestId("goals-group-paused")).toBeTruthy();
  });
});
