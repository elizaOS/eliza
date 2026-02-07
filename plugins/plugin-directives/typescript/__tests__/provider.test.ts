/**
 * @module provider.test
 * @description Tests for the DirectiveState provider and session state management.
 * Covers provider output, state updates, session isolation, default values,
 * state after removal, and model/exec directive application.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  applyDirectives,
  clearDirectiveState,
  getDirectiveState,
  setDirectiveState,
  parseDirectives,
  formatDirectiveState,
  formatDirectiveAcknowledgment,
  directiveStateProvider,
} from "../src/index";
import type { DirectiveState } from "../src/types";

// ============================================================================
// Helper: minimal mock runtime and message for provider.get()
// ============================================================================

function mockRuntime() {
  return {} as any;
}

function mockMessage(roomId: string) {
  return { roomId, content: { text: "" } } as any;
}

function mockState() {
  return {} as any;
}

// ============================================================================
// 1. DirectiveState Provider Returns Correct State
// ============================================================================

describe("DirectiveState provider", () => {
  const roomId = "provider-room-1";

  beforeEach(() => {
    clearDirectiveState(roomId);
  });

  it("returns default state for a fresh room", async () => {
    const result = await directiveStateProvider.get!(
      mockRuntime(),
      mockMessage(roomId),
      mockState(),
    );

    expect(result.text).toContain("Thinking: low");
    expect(result.text).toContain("Verbose: off");
    expect(result.text).toContain("Reasoning: off");
    expect(result.text).toContain("Elevated: off");

    expect(result.values?.thinkingLevel).toBe("low");
    expect(result.values?.verboseLevel).toBe("off");
    expect(result.values?.isElevated).toBe(false);
  });

  it("returns updated state after applying think directive", async () => {
    const directives = parseDirectives("/think:high");
    applyDirectives(roomId, directives);

    const result = await directiveStateProvider.get!(
      mockRuntime(),
      mockMessage(roomId),
      mockState(),
    );

    expect(result.values?.thinkingLevel).toBe("high");
    expect(result.text).toContain("Thinking: high");
  });

  it("returns updated state after applying verbose directive", async () => {
    const directives = parseDirectives("/verbose full");
    applyDirectives(roomId, directives);

    const result = await directiveStateProvider.get!(
      mockRuntime(),
      mockMessage(roomId),
      mockState(),
    );

    expect(result.values?.verboseLevel).toBe("full");
    expect(result.text).toContain("Verbose: full");
  });

  it("returns directive data in the data field", async () => {
    const directives = parseDirectives("/think:medium /reasoning on");
    applyDirectives(roomId, directives);

    const result = await directiveStateProvider.get!(
      mockRuntime(),
      mockMessage(roomId),
      mockState(),
    );

    const data = result.data as { directives: DirectiveState };
    expect(data.directives.thinking).toBe("medium");
    expect(data.directives.reasoning).toBe("on");
  });
});

// ============================================================================
// 2. State Updates When Directives Change
// ============================================================================

describe("State updates when directives change", () => {
  const roomId = "state-update-room";

  beforeEach(() => {
    clearDirectiveState(roomId);
  });

  it("overwrites previous thinking level with new one", () => {
    applyDirectives(roomId, parseDirectives("/think:low"));
    expect(getDirectiveState(roomId).thinking).toBe("low");

    applyDirectives(roomId, parseDirectives("/think:high"));
    expect(getDirectiveState(roomId).thinking).toBe("high");
  });

  it("preserves unrelated state when updating one directive", () => {
    applyDirectives(roomId, parseDirectives("/think:high"));
    applyDirectives(roomId, parseDirectives("/verbose on"));

    const state = getDirectiveState(roomId);
    expect(state.thinking).toBe("high"); // preserved
    expect(state.verbose).toBe("on"); // updated
  });

  it("applies multiple directives in a single message", () => {
    applyDirectives(
      roomId,
      parseDirectives("/think:medium /verbose full /elevated on"),
    );

    const state = getDirectiveState(roomId);
    expect(state.thinking).toBe("medium");
    expect(state.verbose).toBe("full");
    expect(state.elevated).toBe("on");
  });
});

// ============================================================================
// 3. Session Isolation (Different Rooms Get Different States)
// ============================================================================

describe("Session isolation", () => {
  const roomA = "isolation-room-A";
  const roomB = "isolation-room-B";

  beforeEach(() => {
    clearDirectiveState(roomA);
    clearDirectiveState(roomB);
  });

  it("room A changes do not affect room B", () => {
    applyDirectives(roomA, parseDirectives("/think:high /verbose full"));
    applyDirectives(roomB, parseDirectives("/think:low"));

    expect(getDirectiveState(roomA).thinking).toBe("high");
    expect(getDirectiveState(roomA).verbose).toBe("full");

    expect(getDirectiveState(roomB).thinking).toBe("low");
    expect(getDirectiveState(roomB).verbose).toBe("off"); // default
  });

  it("clearing room A does not affect room B", () => {
    applyDirectives(roomA, parseDirectives("/think:high"));
    applyDirectives(roomB, parseDirectives("/think:medium"));

    clearDirectiveState(roomA);

    expect(getDirectiveState(roomA).thinking).toBe("low"); // reset to default
    expect(getDirectiveState(roomB).thinking).toBe("medium"); // untouched
  });
});

// ============================================================================
// 4. Default State Values
// ============================================================================

describe("Default state values", () => {
  it("returns defaults for an unknown room", () => {
    const state = getDirectiveState("never-seen-before-room-xyz");

    expect(state.thinking).toBe("low");
    expect(state.verbose).toBe("off");
    expect(state.reasoning).toBe("off");
    expect(state.elevated).toBe("off");
    expect(state.exec).toEqual({});
    expect(state.model).toEqual({});
  });

  it("setDirectiveState replaces the entire state", () => {
    const roomId = "set-full-state";
    clearDirectiveState(roomId);

    const customState: DirectiveState = {
      thinking: "xhigh",
      verbose: "full",
      reasoning: "stream",
      elevated: "full",
      exec: { host: "gateway", security: "allowlist" },
      model: { provider: "openai", model: "gpt-5" },
    };

    setDirectiveState(roomId, customState);
    const retrieved = getDirectiveState(roomId);

    expect(retrieved.thinking).toBe("xhigh");
    expect(retrieved.verbose).toBe("full");
    expect(retrieved.reasoning).toBe("stream");
    expect(retrieved.elevated).toBe("full");
    expect(retrieved.exec.host).toBe("gateway");
    expect(retrieved.model.provider).toBe("openai");
    expect(retrieved.model.model).toBe("gpt-5");
  });
});

// ============================================================================
// 5. State After Directive Removal
// ============================================================================

describe("State after directive removal", () => {
  const roomId = "removal-room";

  beforeEach(() => {
    clearDirectiveState(roomId);
  });

  it("clearDirectiveState resets to defaults", () => {
    applyDirectives(
      roomId,
      parseDirectives("/think:high /verbose full /elevated on"),
    );

    // Verify state was applied
    expect(getDirectiveState(roomId).thinking).toBe("high");

    clearDirectiveState(roomId);

    const state = getDirectiveState(roomId);
    expect(state.thinking).toBe("low");
    expect(state.verbose).toBe("off");
    expect(state.elevated).toBe("off");
  });

  it("can re-apply directives after clearing", () => {
    applyDirectives(roomId, parseDirectives("/think:high"));
    clearDirectiveState(roomId);
    applyDirectives(roomId, parseDirectives("/think:medium"));

    expect(getDirectiveState(roomId).thinking).toBe("medium");
  });
});

// ============================================================================
// 6. Model Directive
// ============================================================================

describe("Model directive state", () => {
  const roomId = "model-room";

  beforeEach(() => {
    clearDirectiveState(roomId);
  });

  it("sets provider and model from /model provider/model", () => {
    const directives = parseDirectives("/model anthropic/claude-3-opus hello");
    applyDirectives(roomId, directives);

    const state = getDirectiveState(roomId);
    expect(state.model.provider).toBe("anthropic");
    expect(state.model.model).toBe("claude-3-opus");
  });

  it("sets auth profile from /model provider/model@profile", () => {
    const directives = parseDirectives("/model openai/gpt-5@premium");
    applyDirectives(roomId, directives);

    const state = getDirectiveState(roomId);
    expect(state.model.provider).toBe("openai");
    expect(state.model.model).toBe("gpt-5");
    expect(state.model.authProfile).toBe("premium");
  });
});

// ============================================================================
// 7. Format Functions
// ============================================================================

describe("Format functions", () => {
  it("formatDirectiveState includes all levels", () => {
    const state: DirectiveState = {
      thinking: "high",
      verbose: "full",
      reasoning: "stream",
      elevated: "on",
      exec: {},
      model: { provider: "anthropic", model: "claude-3" },
    };

    const text = formatDirectiveState(state);
    expect(text).toContain("Thinking: high");
    expect(text).toContain("Verbose: full");
    expect(text).toContain("Reasoning: stream");
    expect(text).toContain("Elevated: on");
    expect(text).toContain("Model: anthropic/claude-3");
  });

  it("formatDirectiveAcknowledgment lists changed directives", () => {
    const directives = parseDirectives("/think:high /verbose on");
    const ack = formatDirectiveAcknowledgment(directives);

    expect(ack).toContain("Thinking: high");
    expect(ack).toContain("Verbose: on");
  });

  it("formatDirectiveAcknowledgment returns 'No changes' for empty", () => {
    const directives = parseDirectives("just a normal message");
    const ack = formatDirectiveAcknowledgment(directives);

    expect(ack).toBe("No changes applied");
  });
});

// ============================================================================
// 8. Elevated + isElevated Flag
// ============================================================================

describe("Elevated directive and isElevated flag", () => {
  const roomId = "elevated-room";

  beforeEach(() => {
    clearDirectiveState(roomId);
  });

  it("isElevated is false by default", async () => {
    const result = await directiveStateProvider.get!(
      mockRuntime(),
      mockMessage(roomId),
      mockState(),
    );
    expect(result.values?.isElevated).toBe(false);
  });

  it("isElevated becomes true when elevated is set to on", async () => {
    applyDirectives(roomId, parseDirectives("/elevated on"));

    const result = await directiveStateProvider.get!(
      mockRuntime(),
      mockMessage(roomId),
      mockState(),
    );
    expect(result.values?.isElevated).toBe(true);
  });
});
