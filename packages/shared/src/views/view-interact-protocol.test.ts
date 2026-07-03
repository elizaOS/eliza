import { describe, expect, it } from "vitest";

import {
  AGENT_SURFACE_CAPABILITY_IDS,
  STANDARD_CAPABILITIES,
} from "./view-interact-protocol";

// Pins the view-interact protocol contract that both the agent server route
// (packages/agent/src/api/views-routes.ts) and the UI DynamicViewLoader dispatch
// against. These constants moved out of @elizaos/ui internals into shared so the
// agent no longer depends on hoisted UI (#12408); this test is the single
// guardrail that the ids/values stay frozen.
describe("view-interact protocol contract", () => {
  it("freezes the standard capability values dispatched by the frontend", () => {
    expect(STANDARD_CAPABILITIES).toEqual({
      GET_STATE: "get-state",
      REFRESH: "refresh",
      FOCUS_ELEMENT: "focus-element",
      GET_TEXT: "get-text",
      CLICK_ELEMENT: "click-element",
      FILL_INPUT: "fill-input",
    });
  });

  it("freezes the agent-surface capability ids handled by the shell registry", () => {
    expect([...AGENT_SURFACE_CAPABILITY_IDS].sort()).toEqual(
      [
        "agent-click",
        "agent-fill",
        "agent-focus",
        "agent-scroll-to",
        "describe-element",
        "get-agent-state",
        "get-focus",
        "list-elements",
        "set-highlight",
      ].sort(),
    );
  });

  it("keeps the standard and agent-surface capability id sets disjoint", () => {
    const standard: ReadonlySet<string> = new Set(
      Object.values(STANDARD_CAPABILITIES),
    );
    for (const id of AGENT_SURFACE_CAPABILITY_IDS) {
      expect(standard.has(id)).toBe(false);
    }
  });
});
