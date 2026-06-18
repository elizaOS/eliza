// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the three @elizaos/ui module specifiers TrajectoryLoggerView imports:
//   - "@elizaos/ui"                      -> Button (passthrough fwd ref/onClick/aria)
//                                           + OverlayAppContext (type-only, erased)
//   - "@elizaos/ui/agent-surface"        -> useAgentElement (ref + data-agent-* props)
//   - "@elizaos/ui/components/views/TerminalPluginView"
// Lightweight passthroughs keep the test self-contained while preserving the
// semantics we assert (Button forwards onClick/aria-label; PhaseChip's
// role="tab"/aria-current come from the real component, not the mock).
// ---------------------------------------------------------------------------
vi.mock("@elizaos/ui", () => ({
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: <T extends HTMLElement>(descriptor: {
    id: string;
    role?: string;
    label: string;
    status?: string;
  }) => ({
    ref: React.createRef<T>(),
    agentProps: {
      "data-agent-id": descriptor.id,
      "data-agent-role": descriptor.role ?? "region",
      "data-agent-label": descriptor.label,
      ...(descriptor.status ? { "data-state": descriptor.status } : {}),
    },
  }),
}));

vi.mock("@elizaos/ui/components/views/TerminalPluginView", () => ({
  TerminalPluginView: (props: { id: string; endpoints?: string[] }) =>
    React.createElement("div", {
      "data-testid": "terminal-plugin-view",
      "data-id": props.id,
      "data-endpoints": JSON.stringify(props.endpoints ?? null),
    }),
}));

import { TrajectoryLoggerView } from "./TrajectoryLoggerView.js";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

function overlayContext(exitToApps = vi.fn()) {
  return { exitToApps, uiTheme: "dark" as const, t };
}

// ---------------------------------------------------------------------------
// Real-shape fixtures. The list envelope and detail payload mirror exactly what
// @elizaos/plugin-training's GET /api/trajectories and GET /api/trajectories/:id
// return (see trajectory-routes.ts: listItemToUIRecord + trajectoryToUIDetail).
// ---------------------------------------------------------------------------
const ACTIVE_ID = "traj-active-1";
const LAST_ID = "traj-last-1";

function listEnvelope() {
  return {
    trajectories: [
      {
        id: ACTIVE_ID,
        agentId: "agent-1",
        roomId: null,
        entityId: null,
        conversationId: null,
        source: "chat",
        status: "active",
        startTime: 1_700_000_000_000,
        endTime: null,
        durationMs: null,
        llmCallCount: 1,
        providerAccessCount: 2,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        metadata: {},
        createdAt: "2023-11-14T22:13:20.000Z",
        updatedAt: "2023-11-14T22:13:20.000Z",
      },
      {
        id: LAST_ID,
        agentId: "agent-1",
        roomId: null,
        entityId: null,
        conversationId: null,
        source: "chat",
        status: "completed",
        startTime: 1_699_000_000_000,
        endTime: 1_699_000_001_000,
        durationMs: 1_000,
        llmCallCount: 2,
        providerAccessCount: 1,
        totalPromptTokens: 40,
        totalCompletionTokens: 20,
        metadata: {},
        createdAt: "2023-11-03T08:26:40.000Z",
        updatedAt: "2023-11-03T08:26:41.000Z",
      },
    ],
    total: 2,
    offset: 0,
    limit: 10,
  };
}

// Active trajectory mid-turn: only should_respond has fired (HANDLE active,
// rest idle). Mirrors a UITrajectoryDetailResult.
function activeDetail() {
  return {
    trajectory: { ...listEnvelope().trajectories[0] },
    llmCalls: [
      {
        id: "c-a1",
        trajectoryId: ACTIVE_ID,
        stepId: "s1",
        model: "gpt-x",
        systemPrompt: "",
        userPrompt: "hi",
        response: '{"action":"RESPOND","reasoning":"user greeted the agent"}',
        temperature: 0,
        maxTokens: 0,
        purpose: "",
        actionType: "",
        stepType: "should_respond",
        tags: [],
        latencyMs: 12,
        timestamp: 1_700_000_000_500,
        createdAt: "2023-11-14T22:13:20.500Z",
      },
    ],
    providerAccesses: [
      {
        id: "p-a1",
        trajectoryId: ACTIVE_ID,
        stepId: "s1",
        providerName: "RECENT_MESSAGES",
        purpose: "",
        data: {},
        timestamp: 1_700_000_000_400,
        createdAt: "2023-11-14T22:13:20.400Z",
      },
      {
        id: "p-a2",
        trajectoryId: ACTIVE_ID,
        stepId: "s1",
        providerName: "CHARACTER",
        purpose: "",
        data: {},
        timestamp: 1_700_000_000_410,
        createdAt: "2023-11-14T22:13:20.410Z",
      },
    ],
  };
}

// Completed trajectory: full HANDLE -> PLAN -> ACTION -> EVALUATE sequence.
function lastDetail() {
  return {
    trajectory: { ...listEnvelope().trajectories[1] },
    llmCalls: [
      {
        id: "c-l1",
        trajectoryId: LAST_ID,
        stepId: "s1",
        model: "gpt-x",
        systemPrompt: "",
        userPrompt: "what time is it",
        response: '{"action":"RESPOND"}',
        temperature: 0,
        maxTokens: 0,
        purpose: "",
        actionType: "",
        stepType: "should_respond",
        tags: [],
        latencyMs: 8,
        timestamp: 1_699_000_000_100,
        createdAt: "2023-11-03T08:26:40.100Z",
      },
      {
        id: "c-l2",
        trajectoryId: LAST_ID,
        stepId: "s2",
        model: "gpt-x",
        systemPrompt: "",
        userPrompt: "",
        response: "It is 3pm right now in your timezone.",
        temperature: 0,
        maxTokens: 0,
        purpose: "",
        actionType: "REPLY",
        stepType: "response",
        tags: [],
        latencyMs: 20,
        timestamp: 1_699_000_000_500,
        createdAt: "2023-11-03T08:26:40.500Z",
      },
    ],
    providerAccesses: [
      {
        id: "p-l1",
        trajectoryId: LAST_ID,
        stepId: "s1",
        providerName: "TIME",
        purpose: "",
        data: {},
        timestamp: 1_699_000_000_050,
        createdAt: "2023-11-03T08:26:40.050Z",
      },
    ],
    toolEvents: [
      {
        id: "te-l1",
        trajectoryId: LAST_ID,
        type: "tool_result",
        actionName: "REPLY",
        status: "completed",
        success: true,
        durationMs: 33,
        timestamp: 1_699_000_000_600,
      },
    ],
    evaluationEvents: [
      {
        id: "ee-l1",
        trajectoryId: LAST_ID,
        type: "evaluator",
        evaluatorName: "REFLECTION",
        decision: "continue",
        success: true,
        timestamp: 1_699_000_000_700,
      },
    ],
  };
}

/** Install a fetch stub that serves the list envelope + per-id detail. */
function installFetch(overrides?: {
  list?: () => unknown;
  detail?: (id: string) => { ok?: boolean; body: unknown };
}): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/trajectories?")) {
        return {
          ok: true,
          json: async () => (overrides?.list ?? listEnvelope)(),
        } as unknown as Response;
      }
      // /api/trajectories/:id
      const id = decodeURIComponent(url.split("/api/trajectories/")[1] ?? "");
      if (overrides?.detail) {
        const r = overrides.detail(id);
        return {
          ok: r.ok ?? true,
          status: r.ok === false ? 500 : 200,
          statusText: r.ok === false ? "Internal Server Error" : "OK",
          text: async () => "boom",
          json: async () => r.body,
        } as unknown as Response;
      }
      const body =
        id === ACTIVE_ID
          ? activeDetail()
          : id === LAST_ID
            ? lastDetail()
            : null;
      return {
        ok: true,
        json: async () => body,
      } as unknown as Response;
    }),
  );
  return { calls };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TrajectoryLoggerView populated render", () => {
  it("renders the header brand block, both Now/Last strips, and the recording badge", async () => {
    installFetch();
    render(<TrajectoryLoggerView {...overlayContext()} />);

    // Header brand title.
    expect(screen.getByText("Trajectories")).toBeTruthy();
    // Back button (Button mock forwards aria-label).
    expect(screen.getByLabelText("Back")).toBeTruthy();

    // Wait for the polling fetch to settle and the badge to render.
    await waitFor(() =>
      expect(screen.getByTestId("trajectory-logging-badge")).toBeTruthy(),
    );

    // An active trajectory exists -> badge reads "recording".
    expect(
      screen.getByTestId("trajectory-logging-badge").textContent,
    ).toContain("recording");

    // Both strip labels render.
    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getByText("Last")).toBeTruthy();
  });

  it("shows specific populated phase data: HANDLE 'respond' (Now) and PLAN 'REPLY' (Last)", async () => {
    installFetch();
    render(<TrajectoryLoggerView {...overlayContext()} />);

    await waitFor(() =>
      expect(screen.getByTestId("trajectory-logging-badge")).toBeTruthy(),
    );

    // Now strip: should_respond RESPOND -> HANDLE summary "respond".
    // (The HANDLE PhaseChip in the now strip carries the summary text.)
    await waitFor(() => {
      const handleNow = document.querySelector(
        '[data-agent-id="phase-now-handle"]',
      );
      expect(handleNow?.textContent).toContain("respond");
    });

    // Last strip: response actionType REPLY -> PLAN summary "REPLY".
    const planLast = document.querySelector(
      '[data-agent-id="phase-last-plan"]',
    );
    expect(planLast?.textContent).toContain("REPLY");

    // Last strip ACTION shows the REPLY tool result summary.
    const actionLast = document.querySelector(
      '[data-agent-id="phase-last-action"]',
    );
    expect(actionLast?.textContent).toContain("REPLY");

    // All four phase chips exist in each strip (8 total). The "tab" role is
    // carried via the agent-surface data-agent-role attribute (not an ARIA role).
    const tabs = document.querySelectorAll('[data-agent-role="tab"]');
    expect(tabs.length).toBe(8);
  });

  it("shows 'idle' badge and 'no turn yet' when there is no active trajectory", async () => {
    installFetch({
      list: () => {
        const env = listEnvelope();
        // Drop the active trajectory; only the completed one remains.
        return { ...env, trajectories: [env.trajectories[1]], total: 1 };
      },
    });
    render(<TrajectoryLoggerView {...overlayContext()} />);

    await waitFor(() =>
      expect(
        screen.getByTestId("trajectory-logging-badge").textContent,
      ).toContain("idle"),
    );

    // The "now" slot has no trajectory -> the empty marker is shown.
    expect(screen.getByText("no turn yet")).toBeTruthy();
  });

  it("surfaces the readJson error message in the header when the list fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.startsWith("/api/trajectories?")) {
          return {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => "Trajectories service not available",
            json: async () => ({}),
          } as unknown as Response;
        }
        return { ok: true, json: async () => null } as unknown as Response;
      }),
    );
    render(<TrajectoryLoggerView {...overlayContext()} />);

    await waitFor(() =>
      expect(
        screen.getByText(/\[trajectory-logger\] 503 Service Unavailable/),
      ).toBeTruthy(),
    );
    // No badge while erroring (header is mutually exclusive).
    expect(screen.queryByTestId("trajectory-logging-badge")).toBeNull();
  });
});

describe("TrajectoryLoggerView interactions", () => {
  it("clicking the Back button invokes exitToApps once", async () => {
    installFetch();
    const exitToApps = vi.fn();
    render(<TrajectoryLoggerView {...overlayContext(exitToApps)} />);

    await waitFor(() =>
      expect(screen.getByTestId("trajectory-logging-badge")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Back"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("clicking a HANDLE chip opens the drilldown with decision + provider chips; clicking again closes it", async () => {
    installFetch();
    render(<TrajectoryLoggerView {...overlayContext()} />);

    await waitFor(() =>
      expect(screen.getByTestId("trajectory-logging-badge")).toBeTruthy(),
    );

    const handleNow = document.querySelector(
      '[data-agent-id="phase-now-handle"]',
    ) as HTMLButtonElement;
    expect(handleNow).toBeTruthy();
    // Not selected initially.
    expect(handleNow.getAttribute("aria-current")).toBeNull();

    fireEvent.click(handleNow);

    // Drilldown appears: decision RESPOND + its reasoning + provider chips.
    await waitFor(() => expect(screen.getByText("RESPOND")).toBeTruthy());
    expect(screen.getByText("user greeted the agent")).toBeTruthy();
    expect(screen.getByText("RECENT_MESSAGES")).toBeTruthy();
    expect(screen.getByText("CHARACTER")).toBeTruthy();

    // The clicked chip becomes the selected tab.
    expect(handleNow.getAttribute("aria-current")).toBe("true");

    // Click again -> drilldown closes (decision text gone), aria-current cleared.
    fireEvent.click(handleNow);
    await waitFor(() => expect(screen.queryByText("RESPOND")).toBeNull());
    expect(handleNow.getAttribute("aria-current")).toBeNull();
  });

  it("clicking a PLAN chip in the Last strip shows actionType + response preview", async () => {
    installFetch();
    render(<TrajectoryLoggerView {...overlayContext()} />);

    await waitFor(() =>
      expect(screen.getByTestId("trajectory-logging-badge")).toBeTruthy(),
    );

    const planLast = document.querySelector(
      '[data-agent-id="phase-last-plan"]',
    ) as HTMLButtonElement;
    fireEvent.click(planLast);

    await waitFor(() => {
      // The actionType (mono) appears in the drilldown body.
      const drilldown = document.querySelector(".max-h-\\[52vh\\]");
      expect(drilldown).toBeTruthy();
      expect(drilldown?.textContent).toContain("REPLY");
      // The response preview text is rendered.
      expect(drilldown?.textContent).toContain(
        "It is 3pm right now in your timezone.",
      );
    });
  });

  it("selecting a chip in the other strip swaps the selection (one drilldown at a time)", async () => {
    installFetch();
    render(<TrajectoryLoggerView {...overlayContext()} />);

    await waitFor(() =>
      expect(screen.getByTestId("trajectory-logging-badge")).toBeTruthy(),
    );

    const handleNow = document.querySelector(
      '[data-agent-id="phase-now-handle"]',
    ) as HTMLButtonElement;
    const evalLast = document.querySelector(
      '[data-agent-id="phase-last-evaluate"]',
    ) as HTMLButtonElement;

    fireEvent.click(handleNow);
    await waitFor(() => expect(screen.getByText("RESPOND")).toBeTruthy());
    expect(handleNow.getAttribute("aria-current")).toBe("true");

    // Switch to EVALUATE in the last strip; HANDLE selection is replaced.
    fireEvent.click(evalLast);
    await waitFor(() =>
      expect(evalLast.getAttribute("aria-current")).toBe("true"),
    );
    expect(handleNow.getAttribute("aria-current")).toBeNull();

    // The EVALUATE body shows the evaluator name + decision.
    const drilldown = document.querySelector(".max-h-\\[52vh\\]");
    expect(
      within(drilldown as HTMLElement).getByText("REFLECTION"),
    ).toBeTruthy();
    expect(within(drilldown as HTMLElement).getByText("continue")).toBeTruthy();
  });
});
