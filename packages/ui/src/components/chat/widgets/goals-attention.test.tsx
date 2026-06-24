// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBaseUrlMock, publishHomeAttentionSpy } = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  publishHomeAttentionSpy: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: { getBaseUrl: getBaseUrlMock },
}));

vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishHomeAttentionSpy,
}));

import { GoalsAttentionWidget } from "./goals-attention";

// Build a `/api/lifeops/goals` wire record matching GoalsView's GoalRecordWire
// (plugins/plugin-goals/src/components/goals/GoalsView.tsx): `{ goal, links }`.
function record(goal: {
  id: string;
  title: string;
  status?: string;
  reviewState?: string;
}) {
  return {
    goal: {
      id: goal.id,
      title: goal.title,
      description: "",
      cadence: null,
      successCriteria: {},
      status: goal.status ?? "active",
      reviewState: goal.reviewState ?? "idle",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    links: [],
  };
}

function mockGoalsResponse(records: ReturnType<typeof record>[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ goals: records }),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  publishHomeAttentionSpy.mockClear();
});

describe("GoalsAttentionWidget (#9143)", () => {
  it("renders attention-first goal rows from the fetched data", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Ship the redesign", reviewState: "on_track" }),
      record({
        id: "g2",
        title: "Recover churned users",
        reviewState: "at_risk",
      }),
    ]);

    render(<GoalsAttentionWidget pluginId="goals" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    // Both live goals render, and the at_risk one carries its badge.
    expect(screen.getByText("Recover churned users")).toBeTruthy();
    expect(screen.getByText("Ship the redesign")).toBeTruthy();
    expect(screen.getByText("At risk")).toBeTruthy();
  });

  it("renders nothing when there are no live goals", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Done already", status: "satisfied" }),
      record({ id: "g2", title: "Old goal", status: "archived" }),
    ]);

    const { container } = render(<GoalsAttentionWidget pluginId="goals" />);

    await waitFor(() => {
      expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("widget-goals-attention")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes a positive escalation weight when a goal needs attention", async () => {
    mockGoalsResponse([
      record({
        id: "g1",
        title: "Reconnect with the team",
        reviewState: "needs_attention",
      }),
    ]);

    render(<GoalsAttentionWidget pluginId="goals" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    // HOME_SIGNAL_WEIGHTS.escalation === 10 (packages/ui/src/widgets/home-priority.ts).
    expect(publishHomeAttentionSpy).toHaveBeenCalledWith(
      "goals/goals.attention",
      10,
    );
  });

  it("publishes null (no boost) when no goal needs attention", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Steady goal", reviewState: "on_track" }),
    ]);

    render(<GoalsAttentionWidget pluginId="goals" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "goals/goals.attention",
      null,
    );
  });
});
