// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084) — mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

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

// useWidgetNavigation → reportUserViewSwitch (from the slash-command controller);
// stub it so the click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
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
  authMock.authenticated = true;
  publishHomeAttentionSpy.mockClear();
});

describe("GoalsAttentionWidget (#9143)", () => {
  it("shows ONE high-priority datum — the most-urgent goal title — minimal, icon-first", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Ship the redesign", reviewState: "on_track" }),
      record({
        id: "g2",
        title: "Recover churned users",
        reviewState: "at_risk",
      }),
      record({
        id: "g3",
        title: "Reconnect with the team",
        reviewState: "needs_attention",
      }),
    ]);

    render(<GoalsAttentionWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });

    const widget = screen.getByTestId("widget-goals-attention");
    // The card is a button (whole-card clickable) and minimal: the at_risk goal
    // wins, and the other goals are NOT shown (only the single datum).
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("Recover churned users");
    expect(widget.textContent).not.toContain("Ship the redesign");
    expect(widget.textContent).not.toContain("Reconnect with the team");
    // The badge carries the attention count (2 needing attention).
    expect(widget.textContent).toContain("2");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(/at risk/i);

    // A goal needs attention -> escalation weight published.
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "goals/goals.attention",
      HOME_SIGNAL_WEIGHTS.escalation,
    );
  });

  it("navigates to the Goals view when the card is clicked", async () => {
    mockGoalsResponse([
      record({
        id: "g1",
        title: "Recover churned users",
        reviewState: "at_risk",
      }),
    ]);
    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<GoalsAttentionWidget slot="home" />);
    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("widget-goals-attention"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/goals");
  });

  it("renders nothing when there are no live goals", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Done already", status: "satisfied" }),
      record({ id: "g2", title: "Old goal", status: "archived" }),
    ]);

    const { container } = render(<GoalsAttentionWidget slot="home" />);

    await waitFor(() => {
      expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("widget-goals-attention")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing (and clears its signal) when no goal needs attention", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Steady goal", reviewState: "on_track" }),
    ]);

    const { container } = render(<GoalsAttentionWidget slot="home" />);

    await waitFor(() => {
      expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
    await Promise.resolve();

    expect(screen.queryByTestId("widget-goals-attention")).toBeNull();
    expect(container.firstChild).toBeNull();
    // No urgent state -> clears its attention (weight null).
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "goals/goals.attention",
      null,
    );
  });

  it("publishes a positive escalation weight when a goal needs attention", async () => {
    mockGoalsResponse([
      record({
        id: "g1",
        title: "Reconnect with the team",
        reviewState: "needs_attention",
      }),
    ]);

    render(<GoalsAttentionWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    // HOME_SIGNAL_WEIGHTS.escalation === 10 (packages/ui/src/widgets/home-priority.ts).
    expect(publishHomeAttentionSpy).toHaveBeenCalledWith(
      "goals/goals.attention",
      HOME_SIGNAL_WEIGHTS.escalation,
    );
  });

  it("applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Ship it", reviewState: "at_risk" }),
    ]);

    const { container } = render(
      <GoalsAttentionWidget
        slot="home"
        spanClassName="col-span-2 row-span-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="widget-goals-attention"]'),
    ).not.toBeNull();
  });

  it("falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    mockGoalsResponse([
      record({ id: "g1", title: "Ship it", reviewState: "at_risk" }),
    ]);

    const { container } = render(<GoalsAttentionWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-goals-attention")).toBeTruthy();
    });
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
