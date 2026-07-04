/**
 * Drives the unified TrajectoryLoggerView data wrapper through the rendered DOM.
 * The harness mounts the spatial surface, feeds real-shape trajectory data, and routes spatial action ids across the GUI and TUI surfaces.
 *
 * @vitest-environment jsdom
 */

import { NAVIGATE_VIEW_EVENT } from "@elizaos/ui/events";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrajectoryLoggerView } from "./TrajectoryLoggerView.js";

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
    ],
  };
}

function lastDetail() {
  return {
    trajectory: { ...listEnvelope().trajectories[1] },
    llmCalls: [
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
    providerAccesses: [],
    toolEvents: [],
    evaluationEvents: [],
  };
}

/** Install a fetch stub that serves the list envelope + per-id detail. */
function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith("/api/trajectories?")) {
        return {
          ok: true,
          json: async () => listEnvelope(),
        } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/api/trajectories/")[1] ?? "");
      const body =
        id === ACTIVE_ID
          ? activeDetail()
          : id === LAST_ID
            ? lastDetail()
            : null;
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
}

/** Install a fetch stub that 503s the list route (route absent on this surface). */
function installUnavailableFetch(): void {
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
}

function buttonByAgent(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TrajectoryLoggerView — unified GUI/XR wrapper", () => {
  it("renders the SpatialSurface-wrapped spatial view", async () => {
    installFetch();
    // The view bundle host (DynamicViewLoader) mounts the registered wrapper
    // inside a SpatialSurface — mirror that here, as the *SpatialView tests do,
    // so the surface attribute the host provides is present for the assertion.
    render(
      <SpatialSurface modality="gui">
        <TrajectoryLoggerView />
      </SpatialSurface>,
    );
    expect(document.querySelector("[data-spatial-surface]")).toBeTruthy();
    expect(screen.getByText("Back")).toBeTruthy();
  });

  it("polls real-shape data into the snapshot (recording state + populated phase)", async () => {
    installFetch();
    render(React.createElement(TrajectoryLoggerView));
    // An active trajectory exists -> the now strip reports recording.
    await waitFor(() => expect(screen.getByText(/recording/)).toBeTruthy());
    // HANDLE "respond" summary derived from the should_respond decision.
    await waitFor(() =>
      expect(document.body.textContent?.includes("respond")).toBe(true),
    );
  });

  it("expands a phase drilldown when its select button is pressed, then collapses on re-press", async () => {
    installFetch();
    render(React.createElement(TrajectoryLoggerView));
    await waitFor(() => expect(screen.getByText(/recording/)).toBeTruthy());

    const selectHandleNow = buttonByAgent("select-now-HANDLE");
    fireEvent.click(selectHandleNow);
    await waitFor(() => expect(screen.getByText("RESPOND")).toBeTruthy());
    expect(screen.getByText("user greeted the agent")).toBeTruthy();

    fireEvent.click(selectHandleNow);
    await waitFor(() => expect(screen.queryByText("RESPOND")).toBeNull());
  });

  it("invokes exitToApps when the Back affordance is pressed", async () => {
    installFetch();
    const exitToApps = vi.fn();
    render(<TrajectoryLoggerView exitToApps={exitToApps} />);
    fireEvent.click(buttonByAgent("back"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("dispatches eliza:navigate:view on Back when no exitToApps prop is supplied", async () => {
    installFetch();
    render(React.createElement(TrajectoryLoggerView));
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    try {
      fireEvent.click(buttonByAgent("back"));
    } finally {
      window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ viewId: "apps" });
  });

  it("renders the calm unavailable state when the trajectories route is absent (503)", async () => {
    installUnavailableFetch();
    render(React.createElement(TrajectoryLoggerView));
    await waitFor(() =>
      expect(
        screen.getByText(/Trajectory logging unavailable on this surface/),
      ).toBeTruthy(),
    );
  });
});
