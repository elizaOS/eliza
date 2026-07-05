/**
 * Covers view-scoped agent actions: a scoped action's `validate()` is gated on
 * the active view (flips without restart when the view changes), scoped names
 * flow into the planner full-detail set via `viewScopedActionNames`, and the
 * element-sequence resolver throws a typed error (never a silent no-op) when the
 * view is inactive or a target element id is missing. Deterministic — drives the
 * real gate/registry/resolver against the live active-view state; no model.
 */
import { ElizaError } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveViewContext,
  setActiveViewContext,
} from "./active-view-state.ts";
import { buildFullParamActionSet } from "./prompt-compaction.ts";
import { viewScopedActionNames } from "./view-action-affinity.ts";
import {
  activeViewScopedActionNames,
  clearViewScopedActions,
  defineViewScopedAction,
  gateValidatorToActiveView,
  isViewActive,
  resolveScopedElementOps,
  type ScopedActionElementOp,
  VIEW_SCOPED_ACTION_TAG,
  viewScopedActionRegistryNames,
} from "./view-scoped-actions.ts";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;
const state = {} as State;

function activate(viewId: string, elements?: { id: string }[]): void {
  setActiveViewContext({
    viewId,
    viewLabel: viewId,
    viewType: "gui",
    viewPath: `/${viewId}`,
    elements: elements?.map((e) => ({ id: e.id, role: "input", label: e.id })),
  });
}

const baseAction: Action = {
  name: "SET_PROVIDER",
  description: "Set the inference provider in the settings view.",
  handler: async () => undefined,
  validate: async () => true,
};

beforeEach(() => {
  clearViewScopedActions();
  clearActiveViewContext();
});

afterEach(() => {
  clearViewScopedActions();
  clearActiveViewContext();
});

describe("gateValidatorToActiveView", () => {
  it("returns false when the view is not the active view", async () => {
    const validate = gateValidatorToActiveView("settings");
    activate("wallet");
    expect(await validate(runtime, message, state)).toBe(false);
  });

  it("returns true when the view is active and there is no inner validator", async () => {
    const validate = gateValidatorToActiveView("settings");
    activate("settings");
    expect(await validate(runtime, message, state)).toBe(true);
  });

  it("delegates to the inner validator only while the view is active", async () => {
    let innerCalls = 0;
    const validate = gateValidatorToActiveView("settings", async () => {
      innerCalls += 1;
      return false;
    });
    activate("wallet");
    expect(await validate(runtime, message, state)).toBe(false);
    expect(innerCalls).toBe(0); // inner is not consulted when view is inactive

    activate("settings");
    expect(await validate(runtime, message, state)).toBe(false);
    expect(innerCalls).toBe(1); // inner decides only once the view is active
  });
});

describe("defineViewScopedAction", () => {
  it("gates validate() on the active view and flips on view switch without restart", async () => {
    const action = defineViewScopedAction("settings", baseAction);

    activate("wallet");
    expect(await action.validate(runtime, message, state)).toBe(false);

    activate("settings");
    expect(await action.validate(runtime, message, state)).toBe(true);

    activate("wallet");
    expect(await action.validate(runtime, message, state)).toBe(false);
  });

  it("does not mutate the input action and tags the scoped result", () => {
    const action = defineViewScopedAction("settings", baseAction);
    expect(baseAction.tags).toBeUndefined();
    expect(action.tags).toContain(VIEW_SCOPED_ACTION_TAG);
    expect(action.tags).toContain("view:settings");
    expect(action.name).toBe("SET_PROVIDER");
  });

  it("records the scoped name only for its own view", () => {
    defineViewScopedAction("settings", baseAction);
    defineViewScopedAction("wallet", { ...baseAction, name: "SWAP_TOKENS" });

    expect(viewScopedActionRegistryNames("settings")).toEqual(["SET_PROVIDER"]);
    expect(viewScopedActionRegistryNames("wallet")).toEqual(["SWAP_TOKENS"]);
    expect(viewScopedActionRegistryNames("browser")).toEqual([]);
  });
});

describe("active view scoped-name reporting", () => {
  it("activeViewScopedActionNames tracks the active view", () => {
    defineViewScopedAction("settings", baseAction);
    expect(activeViewScopedActionNames()).toEqual([]);
    activate("settings");
    expect(activeViewScopedActionNames()).toEqual(["SET_PROVIDER"]);
    activate("wallet");
    expect(activeViewScopedActionNames()).toEqual([]);
  });

  it("scoped names flow into viewScopedActionNames and the planner full-detail set", () => {
    defineViewScopedAction("settings", baseAction);
    const scoped = viewScopedActionNames("settings");
    expect(scoped.has("SET_PROVIDER")).toBe(true);

    // The planner keeps caller-supplied (active-view) actions at full param
    // detail regardless of detected intent.
    const full = buildFullParamActionSet([], viewScopedActionNames("settings"));
    expect(full.has("SET_PROVIDER")).toBe(true);
    // A view without scoped actions contributes nothing.
    expect(buildFullParamActionSet([], viewScopedActionNames("browser")).has(
      "SET_PROVIDER",
    )).toBe(false);
  });
});

describe("isViewActive", () => {
  it("reflects the active view", () => {
    expect(isViewActive("settings")).toBe(false);
    activate("settings");
    expect(isViewActive("settings")).toBe(true);
    expect(isViewActive("wallet")).toBe(false);
  });
});

describe("resolveScopedElementOps", () => {
  const ops: ScopedActionElementOp[] = [
    { op: "agent-fill", elementId: "provider-select", value: "anthropic" },
    { op: "agent-click", elementId: "save-provider" },
  ];

  it("returns the ops unchanged when the view is active and all ids exist", () => {
    activate("settings", [{ id: "provider-select" }, { id: "save-provider" }]);
    expect(resolveScopedElementOps("settings", ops)).toBe(ops);
  });

  it("throws a typed error when the declaring view is not active", () => {
    activate("wallet", [{ id: "provider-select" }, { id: "save-provider" }]);
    try {
      resolveScopedElementOps("settings", ops);
      throw new Error("expected resolveScopedElementOps to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      expect((err as ElizaError).code).toBe("VIEW_SCOPED_ACTION_VIEW_INACTIVE");
    }
  });

  it("throws a typed error (no silent no-op) when a target element id is missing", () => {
    activate("settings", [{ id: "provider-select" }]); // save-provider absent
    try {
      resolveScopedElementOps("settings", ops);
      throw new Error("expected resolveScopedElementOps to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      const e = err as ElizaError;
      expect(e.code).toBe("VIEW_SCOPED_ACTION_ELEMENT_MISSING");
      expect(e.context?.missing).toEqual(["save-provider"]);
    }
  });

  it("throws when no view is active at all", () => {
    expect(() => resolveScopedElementOps("settings", ops)).toThrow(ElizaError);
  });
});
