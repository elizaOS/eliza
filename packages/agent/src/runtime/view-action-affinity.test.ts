import { afterEach, describe, expect, it } from "vitest";
import {
  buildFullParamActionSet,
  compactActionsForIntent,
} from "./prompt-compaction.ts";
import {
  applyActiveViewAwareness,
  clearActiveViewContext,
  getActiveViewContext,
  renderActiveViewContextBlock,
  setActiveViewContext,
  VIEW_ACTION_MAP,
  validateViewActionMap,
  viewScopedActionNames,
} from "./view-action-affinity.ts";

const AWARE_VIEW = {
  viewId: "wallet",
  viewLabel: "Wallet",
  viewType: "gui" as const,
  viewPath: "/wallet",
};

afterEach(() => clearActiveViewContext());

describe("view-action-affinity", () => {
  it("stores and clears the active view", () => {
    expect(getActiveViewContext()).toBeNull();
    setActiveViewContext({
      viewId: "companion",
      viewLabel: "Companion",
      viewType: "gui",
      viewPath: "/companion",
    });
    expect(getActiveViewContext()?.viewId).toBe("companion");
    clearActiveViewContext();
    expect(getActiveViewContext()).toBeNull();
  });

  it("resolves scoped action names from the map", () => {
    expect(viewScopedActionNames("companion")).toEqual(new Set(["PLAY_EMOTE"]));
    expect(viewScopedActionNames("orchestrator")).toEqual(new Set(["TASKS"]));
    expect(viewScopedActionNames("a-view-with-no-actions").size).toBe(0);
    expect(viewScopedActionNames(null).size).toBe(0);
    expect(viewScopedActionNames(undefined).size).toBe(0);
  });

  it("merges view-scoped actions into the full-param set", () => {
    const set = buildFullParamActionSet([], viewScopedActionNames("companion"));
    // Universal actions are always present…
    expect(set.has("REPLY")).toBe(true);
    // …and the active view's scoped action is kept full.
    expect(set.has("PLAY_EMOTE")).toBe(true);
  });

  it("flags drift when a mapped action is not registered", () => {
    const warnings: string[] = [];
    validateViewActionMap(["REPLY", "PLAY_EMOTE"], {
      warn: (m) => warnings.push(m),
    });
    // TASKS / RUNTIME are not in the registered list → should warn.
    expect(warnings.some((w) => w.includes("TASKS"))).toBe(true);
    expect(warnings.some((w) => w.includes("RUNTIME"))).toBe(true);
    expect(warnings.some((w) => w.includes("PLAY_EMOTE"))).toBe(false);
  });

  it("does not warn when every mapped action is registered", () => {
    const allMapped = new Set<string>();
    for (const actions of Object.values(VIEW_ACTION_MAP)) {
      for (const a of actions) allMapped.add(a);
    }
    const warnings: string[] = [];
    validateViewActionMap([...allMapped], { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });

  it("renders an awareness block describing the active view", () => {
    const block = renderActiveViewContextBlock({
      viewId: "wallet",
      viewLabel: "Wallet",
      viewType: "gui",
      viewPath: "/wallet",
    });
    expect(block).toContain("# Active View");
    expect(block).toContain('"Wallet"');
    expect(block).toContain("list-elements");
    expect(block).toContain("agent-fill");
  });
});

describe("compactActionsForIntent with view-scoped actions", () => {
  const PROMPT = [
    "# Available Actions",
    "- REPLY: respond to the user",
    "  parameters: { text: string }",
    "- PLAY_EMOTE: play an avatar emote",
    "  parameters: { emote: string, intensity: number }",
    "- WHATEVER: some unrelated action",
    "  parameters: { foo: string }",
    "",
    "# Received Message",
    "12:00 User: hello there",
  ].join("\n");

  it("stubs an action's params when neither intent nor view keeps it", () => {
    const out = compactActionsForIntent(PROMPT);
    // PLAY_EMOTE param schema is dropped for plain chat with no active view…
    expect(out).toContain("- PLAY_EMOTE: play an avatar emote");
    expect(out).not.toContain("emote: string, intensity: number");
    // …REPLY (universal) keeps its params.
    expect(out).toContain("text: string");
  });

  it("keeps the active view's scoped action at full param detail", () => {
    const out = compactActionsForIntent(
      PROMPT,
      viewScopedActionNames("companion"),
    );
    // The companion view scopes PLAY_EMOTE → its params survive compaction.
    expect(out).toContain("emote: string, intensity: number");
    // The unrelated action is still stubbed.
    expect(out).not.toContain("foo: string");
  });
});

describe("applyActiveViewAwareness", () => {
  const PROMPT = "intro text\n\n# Available Actions\n- REPLY: respond\n";

  it("injects the awareness block just before # Available Actions", () => {
    const out = applyActiveViewAwareness(PROMPT, AWARE_VIEW);
    expect(out).toContain("# Active View");
    expect(out.indexOf("# Active View")).toBeLessThan(
      out.indexOf("# Available Actions"),
    );
    // Original content is preserved.
    expect(out).toContain("- REPLY: respond");
    expect(out).toContain("intro text");
  });

  it("is a no-op when no view is active", () => {
    expect(applyActiveViewAwareness(PROMPT, null)).toBe(PROMPT);
  });

  it("is idempotent", () => {
    const once = applyActiveViewAwareness(PROMPT, AWARE_VIEW);
    const twice = applyActiveViewAwareness(once, AWARE_VIEW);
    expect(twice).toBe(once);
  });

  it("prepends when there is no actions header", () => {
    const out = applyActiveViewAwareness("just a prompt", AWARE_VIEW);
    expect(out.startsWith("# Active View")).toBe(true);
    expect(out).toContain("just a prompt");
  });
});
