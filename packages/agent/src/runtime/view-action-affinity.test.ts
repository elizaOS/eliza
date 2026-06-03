import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFullParamActionSet,
  compactActionsForIntent,
} from "./prompt-compaction.ts";
import {
  ACTIVE_VIEW_ELEMENT_RENDER_CAP,
  applyActiveViewAwareness,
  clearActiveViewContext,
  getActiveViewContext,
  renderActiveViewContextBlock,
  setActiveViewContext,
  setActiveViewElements,
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

  it("covers the major plugin views (expanded map)", () => {
    // wallet / trading / xr surfaces now boost their plugin actions.
    expect(viewScopedActionNames("wallet").has("EVM_SWAP")).toBe(true);
    expect(viewScopedActionNames("wallet").has("SOLANA_TRANSFER")).toBe(true);
    expect(viewScopedActionNames("polymarket").has("POLYMARKET_STATUS")).toBe(
      true,
    );
    expect(viewScopedActionNames("hyperliquid").has("PERPETUAL_MARKET")).toBe(
      true,
    );
    expect(viewScopedActionNames("facewear").has("XR_OPEN_VIEW")).toBe(true);
    expect(viewScopedActionNames("scape").has("SCAPE")).toBe(true);
    expect(viewScopedActionNames("2004scape").has("RS_2004")).toBe(true);
    expect(viewScopedActionNames("steward").has("WALLET")).toBe(true);
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
    // The wallet view scopes actions → the block names them for the planner.
    expect(block).toContain("most relevant while on this view");
    expect(block).toContain("EVM_SWAP");
  });
});

describe("active-view element snapshot", () => {
  const VIEW = {
    viewId: "wallet",
    viewLabel: "Wallet",
    viewType: "gui" as const,
    viewPath: "/wallet",
  };

  it("only accepts elements for the active view (gates stale reports)", () => {
    setActiveViewContext(VIEW);
    // A background/stale view's report is dropped.
    expect(
      setActiveViewElements("some-other-view", [
        { id: "x", role: "button", label: "X" },
      ]),
    ).toBe(false);
    expect(getActiveViewContext()?.elements).toBeUndefined();
    // The active view's report sticks.
    expect(
      setActiveViewElements("wallet", [
        { id: "send", role: "button", label: "Send" },
      ]),
    ).toBe(true);
    expect(getActiveViewContext()?.elements).toHaveLength(1);
  });

  it("no-ops when no view is active", () => {
    expect(
      setActiveViewElements("wallet", [
        { id: "send", role: "button", label: "Send" },
      ]),
    ).toBe(false);
  });

  it("renders elements into the awareness block, focused-first, by id", () => {
    const block = renderActiveViewContextBlock({
      ...VIEW,
      elements: [
        { id: "amount", role: "text-input", label: "Amount", value: "5" },
        { id: "send", role: "button", label: "Send", focused: true },
      ],
    });
    expect(block).toContain("Addressable elements currently in this view");
    // Focused element is listed first.
    const sendIdx = block.indexOf("- send [button]");
    const amountIdx = block.indexOf("- amount [text-input]");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(amountIdx).toBeGreaterThan(sendIdx);
    expect(block).toContain('"Send" (focused)');
    expect(block).toContain('"Amount" = "5"');
  });

  it("caps the rendered element list and notes the remainder", () => {
    const many = Array.from(
      { length: ACTIVE_VIEW_ELEMENT_RENDER_CAP + 5 },
      (_unused, i) => ({ id: `el-${i}`, role: "button", label: `E${i}` }),
    );
    const block = renderActiveViewContextBlock({ ...VIEW, elements: many });
    expect(block).toContain("…and 5 more — call list-elements for the rest.");
  });

  it("omits the elements section when none are reported", () => {
    const block = renderActiveViewContextBlock(VIEW);
    expect(block).not.toContain("Addressable elements currently in this view");
  });
});

// Drift guard: every action name in VIEW_ACTION_MAP must still exist as a
// declared `name: "X"` in source. Catches an upstream rename/removal turning a
// mapped action into a silent no-op (the runtime validator is advisory-only and
// not wired at boot). Source-static so it needs no running runtime.
describe("VIEW_ACTION_MAP names resolve to declared actions in source", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../../../..");
  const names = [
    ...new Set(Object.values(VIEW_ACTION_MAP).flatMap((a) => [...a])),
  ];

  it.each(names)("action %s is declared somewhere in source", (name) => {
    let found = "";
    try {
      found = execFileSync(
        "grep",
        ["-rlF", `name: "${name}"`, "plugins", "packages/agent/src"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      // grep exits 1 (no match) → found stays empty → assertion fails below.
    }
    expect(
      found,
      `no \`name: "${name}"\` found under plugins/ or packages/agent/src`,
    ).not.toBe("");
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

  // Mirrors the exact pipeline installPromptOptimizations runs on a planner
  // prompt: read the active view, weight its scoped actions through
  // compactActionsForIntent, then inject the awareness block. Locks the
  // integration contract the prompt-optimization wiring implements.
  it("end-to-end: active view weights its action AND injects awareness", () => {
    setActiveViewContext({
      viewId: "companion",
      viewLabel: "Companion",
      viewType: "gui",
      viewPath: "/companion",
    });
    const active = getActiveViewContext();
    let prompt = compactActionsForIntent(
      PROMPT,
      viewScopedActionNames(active?.viewId),
    );
    if (active && prompt.includes("# Available Actions")) {
      prompt = applyActiveViewAwareness(prompt, active);
    }
    // Weighting: the companion view's PLAY_EMOTE keeps full params…
    expect(prompt).toContain("emote: string, intensity: number");
    // …unrelated action stays stubbed…
    expect(prompt).not.toContain("foo: string");
    // …and awareness is injected once, before the action catalogue.
    expect(prompt).toContain("# Active View");
    expect(prompt.indexOf("# Active View")).toBeLessThan(
      prompt.indexOf("# Available Actions"),
    );
    expect(prompt.match(/# Active View/g)).toHaveLength(1);
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
