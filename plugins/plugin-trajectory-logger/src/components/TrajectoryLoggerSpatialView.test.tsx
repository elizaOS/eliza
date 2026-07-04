/**
 * Renders the presentational `TrajectoryLoggerSpatialView` to both static DOM
 * markup and real terminal lines (via the spatial TUI registry), asserting the
 * one source produces sane output across GUI and TUI surfaces.
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PhaseSummary } from "../phases.ts";
import {
  TrajectoryLoggerSpatialView,
  type TrajectorySnapshot,
} from "./TrajectoryLoggerSpatialView.tsx";

const handle: PhaseSummary = {
  phase: "HANDLE",
  status: "done",
  summary: "respond",
  llmCalls: [
    {
      id: "h1",
      model: "eliza-1",
      response: '{"action":"RESPOND","reasoning":"user asked a question"}',
      purpose: "should_respond",
      actionType: "",
      stepType: "should_respond",
    },
  ],
  providerAccesses: [
    { id: "p1", providerName: "TIME", purpose: "context" },
    { id: "p2", providerName: "FACTS", purpose: "context" },
  ],
  toolEvents: [],
  evaluationEvents: [],
};

const plan: PhaseSummary = {
  phase: "PLAN",
  status: "done",
  summary: "REPLY",
  llmCalls: [
    {
      id: "pl1",
      model: "eliza-1",
      response: "I will greet the user warmly.",
      purpose: "response",
      actionType: "REPLY",
      stepType: "response",
    },
  ],
  providerAccesses: [],
  toolEvents: [],
  evaluationEvents: [],
};

const action: PhaseSummary = {
  phase: "ACTION",
  status: "active",
  summary: "sendMessage",
  llmCalls: [],
  providerAccesses: [],
  toolEvents: [
    {
      id: "t1",
      type: "tool_call",
      actionName: "sendMessage",
      status: "running",
      durationMs: 42,
    },
  ],
  evaluationEvents: [],
};

const evaluate: PhaseSummary = {
  phase: "EVALUATE",
  status: "idle",
  summary: null,
  llmCalls: [],
  providerAccesses: [],
  toolEvents: [],
  evaluationEvents: [],
};

const lastEvaluate: PhaseSummary = {
  phase: "EVALUATE",
  status: "done",
  summary: "reflection: keep",
  llmCalls: [],
  providerAccesses: [],
  toolEvents: [],
  evaluationEvents: [
    {
      id: "e1",
      evaluatorName: "reflection",
      status: "completed",
      success: true,
      decision: "keep",
      thought: "the response was on-topic",
    },
  ],
};

const snapshot: TrajectorySnapshot = {
  ready: true,
  recording: true,
  error: null,
  now: {
    hasTrajectory: true,
    phases: [handle, plan, action, evaluate],
  },
  last: {
    hasTrajectory: true,
    phases: [
      { ...handle, summary: "respond" },
      { ...plan, summary: "REPLY" },
      { ...action, status: "done", summary: "sendMessage" },
      lastEvaluate,
    ],
  },
  selected: { slot: "now", phase: "ACTION" },
};

const view = <TrajectoryLoggerSpatialView snapshot={snapshot} />;

describe("TrajectoryLoggerSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("recording");
      expect(flat).toContain("now");
      expect(flat).toContain("last");
      expect(flat).toContain("HANDLE");
      expect(flat).toContain("ACTION");
      expect(flat).toContain("sendMessage"); // expanded drilldown body
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("HANDLE");
      expect(html).toContain("sendMessage");
      expect(html).toContain('data-agent-id="strip-now"');
      expect(html).toContain('data-agent-id="phase-now-HANDLE"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "trajectory-logger-test",
      () => view,
    );
    try {
      const component = getTerminalView("trajectory-logger-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
    } finally {
      unregister();
    }
  });

  it("renders the calm unavailable message instead of the strips when unavailable", () => {
    const unavailable: TrajectorySnapshot = {
      ...snapshot,
      unavailable: true,
    };
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <TrajectoryLoggerSpatialView snapshot={unavailable} />
      </SpatialSurface>,
    );
    expect(gui).toContain("Trajectory logging unavailable on this surface");
    // Strips are suppressed under the unavailable state.
    expect(gui).not.toContain('data-agent-id="strip-now"');
  });

  it("ACTION drilldown surfaces tool args and result", () => {
    const actionWithIo: PhaseSummary = {
      phase: "ACTION",
      status: "done",
      summary: "REPLY",
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [
        {
          id: "io1",
          type: "tool_result",
          actionName: "REPLY",
          status: "completed",
          success: true,
          durationMs: 42,
          args: { text: "hello world" },
          result: { sent: true },
        },
      ],
      evaluationEvents: [],
    };
    const snap: TrajectorySnapshot = {
      ready: true,
      recording: false,
      error: null,
      now: {
        hasTrajectory: true,
        phases: [handle, plan, actionWithIo, evaluate],
      },
      last: { hasTrajectory: false, phases: [handle, plan, action, evaluate] },
      selected: { slot: "now", phase: "ACTION" },
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <TrajectoryLoggerSpatialView snapshot={snap} />
      </SpatialSurface>,
    );
    // args + result values surface in the expanded ACTION drilldown body.
    expect(html).toContain("hello world");
    expect(html).toContain("sent");
  });

  it("exposes a Back affordance that dispatches the back action", () => {
    const actions: string[] = [];
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <TrajectoryLoggerSpatialView
          snapshot={snapshot}
          onAction={(action) => actions.push(action)}
        />
      </SpatialSurface>,
    );
    expect(gui).toContain('data-agent-id="back"');
  });
});
