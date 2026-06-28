/**
 * Agent-loop registry (#9170 M10).
 *
 * The registry maps a model string → loop, with the built-in local grounder as
 * the match-anything fallback. These tests pin selection precedence, the
 * model-family matcher, and the predictStep/predictClick seam of the default
 * LocalGrounderLoop.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  _resetAgentLoopsForTests,
  type AgentLoop,
  createAgentLoop,
  DEFAULT_AGENT_LOOP_MODEL,
  LocalGrounderLoop,
  listAgentLoops,
  matchesModelFamily,
  registerAgentLoop,
  selectAgentLoopRegistration,
  unregisterAgentLoop,
} from "../actor/agent-loop.js";
import type { CascadeResult } from "../actor/types.js";

function noopLoop(name: string): AgentLoop {
  return {
    name,
    async predictStep(): Promise<CascadeResult> {
      return {
        scene_summary: "",
        rois: [],
        proposed: { kind: "wait", displayId: 0, rationale: "" },
      };
    },
    async predictClick() {
      return null;
    },
  };
}

describe("agent-loop registry", () => {
  afterEach(() => _resetAgentLoopsForTests());

  it("falls back to the local grounder for any model string", () => {
    const reg = selectAgentLoopRegistration("some/unknown-model");
    expect(reg.name).toBe(DEFAULT_AGENT_LOOP_MODEL);
  });

  it("creates a LocalGrounderLoop by default", () => {
    const loop = createAgentLoop("local-grounder", {
      runtime: null,
      getScene: () => null,
    });
    expect(loop).toBeInstanceOf(LocalGrounderLoop);
    expect(loop.name).toBe(DEFAULT_AGENT_LOOP_MODEL);
  });

  it("prefers a registered loop over the local fallback when it matches", () => {
    registerAgentLoop({
      name: "anthropic-cua",
      matches: matchesModelFamily("anthropic"),
      create: () => noopLoop("anthropic-cua"),
      priority: 10,
    });
    expect(selectAgentLoopRegistration("anthropic/claude-opus").name).toBe(
      "anthropic-cua",
    );
    // A non-matching string still falls back to the local grounder.
    expect(
      selectAgentLoopRegistration("openai/computer-use-preview").name,
    ).toBe(DEFAULT_AGENT_LOOP_MODEL);
  });

  it("ranks higher-priority registrations first when several match", () => {
    registerAgentLoop({
      name: "low",
      matches: () => true,
      create: () => noopLoop("low"),
      priority: 1,
    });
    registerAgentLoop({
      name: "high",
      matches: () => true,
      create: () => noopLoop("high"),
      priority: 5,
    });
    expect(selectAgentLoopRegistration("anything").name).toBe("high");
  });

  it("unregisters a loop, reverting to the fallback", () => {
    registerAgentLoop({
      name: "temp",
      matches: matchesModelFamily("openai"),
      create: () => noopLoop("temp"),
      priority: 3,
    });
    expect(selectAgentLoopRegistration("openai/x").name).toBe("temp");
    unregisterAgentLoop("temp");
    expect(selectAgentLoopRegistration("openai/x").name).toBe(
      DEFAULT_AGENT_LOOP_MODEL,
    );
  });

  it("listAgentLoops returns registrations sorted by descending priority", () => {
    registerAgentLoop({
      name: "p2",
      matches: () => false,
      create: () => noopLoop("p2"),
      priority: 2,
    });
    const names = listAgentLoops().map((r) => r.name);
    // The local grounder sits at -Infinity, so it is last.
    expect(names[0]).toBe("p2");
    expect(names[names.length - 1]).toBe(DEFAULT_AGENT_LOOP_MODEL);
  });
});

describe("matchesModelFamily", () => {
  const m = matchesModelFamily("anthropic");
  it("matches family slash/dash/equals/substring forms", () => {
    expect(m("anthropic")).toBe(true);
    expect(m("anthropic/claude-3-7")).toBe(true);
    expect(m("anthropic-claude")).toBe(true);
    expect(m("provider/anthropic/model")).toBe(true);
    expect(m("ANTHROPIC/Claude")).toBe(true);
  });
  it("does not match unrelated families", () => {
    expect(matchesModelFamily("openai")("anthropic/claude")).toBe(false);
  });
});

describe("LocalGrounderLoop.predictClick", () => {
  it("returns null when there is no ref/roi to ground", async () => {
    const loop = new LocalGrounderLoop({ runtime: null, getScene: () => null });
    const result = await loop.predictClick({
      scene: {
        timestamp: 1,
        displays: [
          {
            id: 0,
            bounds: [0, 0, 1920, 1080],
            scaleFactor: 1,
            primary: true,
            name: "d0",
          },
        ],
        focused_window: null,
        apps: [],
        ocr: [],
        ax: [],
        vlm_scene: null,
        vlm_elements: null,
      },
      captures: new Map(),
      targetDisplayId: 0,
      instruction: "click something",
    });
    expect(result).toBeNull();
  });
});
