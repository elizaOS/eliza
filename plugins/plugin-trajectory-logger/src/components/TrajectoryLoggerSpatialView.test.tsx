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
      expect(flat).toContain("Trajectories");
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
      expect(html).toContain("Trajectories");
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
      expect(lines.join("\n")).toContain("Trajectories");
    } finally {
      unregister();
    }
  });
});
