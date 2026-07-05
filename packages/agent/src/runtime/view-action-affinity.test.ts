/**
 * Covers view-action affinity: the derived view→action map, the active-view
 * context/element snapshot lifecycle, the awareness block rendered into planner
 * prompts, the drift/coverage validators, and the end-to-end weave with
 * prompt-compaction. Deterministic — synthetic plugin views registered in the
 * live views-registry, plus a source-static git-grep drift guard over
 * plugins/ and packages/agent/src.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
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
  validateViewActionMap,
  validateViewCoverage,
  viewActionAffinityMap,
  viewScopedActionNames,
  viewScopedNamedActions,
} from "./view-action-affinity.ts";

const AWARE_VIEW = {
  viewId: "wallet",
  viewLabel: "Wallet",
  viewType: "gui" as const,
  viewPath: "/wallet",
};

const AFFINITY_TEST_PLUGIN = "@test/view-action-affinity";

beforeEach(async () => {
  await registerPluginViews({
    name: AFFINITY_TEST_PLUGIN,
    description: "Synthetic view action affinity fixtures.",
    views: [
      {
        id: "wallet",
        label: "Wallet",
        relatedActions: [
          "WALLET",
          "EVM_SWAP",
          "EVM_TRANSFER",
          "SOLANA_SWAP",
          "SOLANA_TRANSFER",
          "CROSS_CHAIN_TRANSFER",
          "BIRDEYE_WALLET_PORTFOLIO",
        ],
      },
      { id: "orchestrator", label: "Orchestrator", relatedActions: ["TASKS"] },
      { id: "training", label: "Training", relatedActions: ["RUNTIME"] },
      {
        id: "polymarket",
        label: "Polymarket",
        relatedActions: ["POLYMARKET_STATUS"],
      },
      {
        id: "hyperliquid",
        label: "Hyperliquid",
        relatedActions: ["PERPETUAL_MARKET"],
      },
      {
        id: "facewear",
        label: "Facewear",
        relatedActions: [
          "FACEWEAR_CONNECT",
          "FACEWEAR_DEBUG",
          "SMARTGLASSES_CONTROL",
          "SMARTGLASSES_STATUS",
          "SMARTGLASSES_DISPLAY_TEXT",
          "SMARTGLASSES_MICROPHONE",
          "XR_OPEN_VIEW",
          "XR_CLOSE_VIEW",
          "XR_SWITCH_VIEW",
          "XR_LIST_VIEWS",
          "XR_RESIZE_VIEW",
          "XR_QUERY_VISION",
        ],
      },
      { id: "steward", label: "Steward", relatedActions: ["WALLET"] },
      {
        id: "calendar",
        label: "Calendar",
        relatedActions: ["CALENDAR", "CONFLICT_DETECT"],
      },
      {
        id: "health",
        label: "Health",
        relatedActions: ["OWNER_HEALTH", "OWNER_SCREENTIME"],
      },
      { id: "todos", label: "Todos", relatedActions: ["OWNER_TODOS"] },
      {
        id: "goals",
        label: "Goals",
        relatedActions: [
          "OWNER_GOALS",
          "OWNER_ALARMS",
          "OWNER_REMINDERS",
          "OWNER_ROUTINES",
        ],
      },
      { id: "inbox", label: "Inbox", relatedActions: ["INBOX"] },
      { id: "finances", label: "Finances", relatedActions: ["OWNER_FINANCES"] },
      {
        id: "lifeops",
        label: "LifeOps",
        relatedActions: ["PERSONAL_ASSISTANT"],
      },
      {
        id: "documents",
        label: "Documents",
        relatedActions: ["OWNER_DOCUMENTS"],
      },
    ],
  });
});

afterEach(() => {
  clearActiveViewContext();
  unregisterPluginViews(AFFINITY_TEST_PLUGIN);
});

describe("view-action-affinity", () => {
  it("stores and clears the active view", () => {
    expect(getActiveViewContext()).toBeNull();
    setActiveViewContext({
      viewId: "wallet",
      viewLabel: "Wallet",
      viewType: "gui",
      viewPath: "/wallet",
    });
    expect(getActiveViewContext()?.viewId).toBe("wallet");
    clearActiveViewContext();
    expect(getActiveViewContext()).toBeNull();
  });

  it("resolves scoped action names from the map", () => {
    expect(viewScopedActionNames("training")).toEqual(new Set(["RUNTIME"]));
    expect(viewScopedActionNames("orchestrator")).toEqual(new Set(["TASKS"]));
    expect(viewScopedActionNames("a-view-with-no-actions").size).toBe(0);
    expect(viewScopedActionNames(null).size).toBe(0);
    expect(viewScopedActionNames(undefined).size).toBe(0);
  });

  it("covers the major plugin views (expanded map)", () => {
    // wallet / trading / xr surfaces boost their plugin actions.
    expect(viewScopedActionNames("wallet").has("EVM_SWAP")).toBe(true);
    expect(viewScopedActionNames("wallet").has("SOLANA_TRANSFER")).toBe(true);
    expect(viewScopedActionNames("polymarket").has("POLYMARKET_STATUS")).toBe(
      true,
    );
    expect(viewScopedActionNames("hyperliquid").has("PERPETUAL_MARKET")).toBe(
      true,
    );
    expect(viewScopedActionNames("facewear").has("XR_OPEN_VIEW")).toBe(true);
    expect(viewScopedActionNames("steward").has("WALLET")).toBe(true);
  });

  it("emphasizes each LifeOps/utility view's own domain actions", () => {
    expect(viewScopedActionNames("calendar").has("CALENDAR")).toBe(true);
    expect(viewScopedActionNames("calendar").has("CONFLICT_DETECT")).toBe(true);
    expect(viewScopedActionNames("health").has("OWNER_HEALTH")).toBe(true);
    expect(viewScopedActionNames("todos").has("OWNER_TODOS")).toBe(true);
    expect(viewScopedActionNames("goals").has("OWNER_GOALS")).toBe(true);
    expect(viewScopedActionNames("inbox").has("INBOX")).toBe(true);
    expect(viewScopedActionNames("finances").has("OWNER_FINANCES")).toBe(true);
    expect(viewScopedActionNames("lifeops").has("PERSONAL_ASSISTANT")).toBe(
      true,
    );
  });

  it("merges view-scoped actions into the full-param set", () => {
    const set = buildFullParamActionSet([], viewScopedActionNames("wallet"));
    // Universal actions are always present…
    expect(set.has("REPLY")).toBe(true);
    // …and the active view's scoped action is kept full.
    expect(set.has("EVM_SWAP")).toBe(true);
  });

  it("flags drift when a mapped action is not registered", () => {
    const warnings: string[] = [];
    validateViewActionMap(["REPLY", "TASKS"], {
      warn: (m) => warnings.push(m),
    });
    // RUNTIME is mapped but not in the registered list → should warn.
    expect(warnings.some((w) => w.includes("RUNTIME"))).toBe(true);
    // TASKS IS in the registered list → should not warn for it.
    expect(warnings.some((w) => w.includes("TASKS"))).toBe(false);
  });

  it("aggregates all missing actions into a single warn line, with per-action debug detail", () => {
    const warnings: string[] = [];
    const debugs: string[] = [];
    // Register nothing → every mapped action is "missing". Deployments without
    // the optional wallet/polymarket/… plugins hit this shape at boot; the
    // detector must not flood the log with one warn per (view, action) pair.
    validateViewActionMap([], {
      warn: (m) => warnings.push(m),
      debug: (m) => debugs.push(m),
    });
    expect(warnings).toHaveLength(1);
    // Summary carries the count, per-view grouping, and the not-loaded hint.
    expect(warnings[0]).toContain("view action affinity:");
    expect(warnings[0]).toContain("not registered");
    expect(warnings[0]).toContain("wallet: WALLET, EVM_SWAP");
    expect(warnings[0]).toContain("plugins not loaded in this config");
    // Per-action detail is preserved at debug level.
    const totalMapped = Object.values(viewActionAffinityMap()).reduce(
      (n, a) => n + a.length,
      0,
    );
    expect(debugs).toHaveLength(totalMapped);
    expect(debugs.some((d) => d.includes('affinity for "wallet"'))).toBe(true);
  });

  it("aggregated warn works when the logger has no debug method", () => {
    const warnings: string[] = [];
    validateViewActionMap([], { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  it("does not warn when every mapped action is registered", () => {
    const allMapped = new Set<string>();
    for (const actions of Object.values(viewActionAffinityMap())) {
      for (const a of actions) allMapped.add(a);
    }
    const warnings: string[] = [];
    validateViewActionMap([...allMapped], { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });

  // ── #8798: view-coverage completeness ─────────────────────────────────────

  it("documents view has a domain-action affinity entry", () => {
    // The documents view (a CONTEXT_VIEWS surface) maps the OWNER_DOCUMENTS
    // domain action (#8798).
    expect(viewActionAffinityMap().documents).toContain("OWNER_DOCUMENTS");
  });

  it("built-in plugins-page/settings keep RUNTIME affinity via their declarations (#13589 stub migration)", () => {
    // The 2-entry HOST_VIEW_ACTION_AFFINITY stub ({plugins-page,settings}→RUNTIME)
    // was deleted; both built-in views declare relatedActions: ["RUNTIME"] in
    // builtin-views.ts, so once registered the derived map (and the scoped-name
    // resolver the planner reads) must still yield RUNTIME — no behavior change.
    registerBuiltinViews();
    const map = viewActionAffinityMap();
    expect(map["plugins-page"]).toContain("RUNTIME");
    expect(map.settings).toContain("RUNTIME");
    expect(viewScopedActionNames("plugins-page").has("RUNTIME")).toBe(true);
    expect(viewScopedActionNames("settings").has("RUNTIME")).toBe(true);
  });

  it("validateViewCoverage warns for a registered view with no affinity and no capabilities", () => {
    const warnings: string[] = [];
    const uncovered = validateViewCoverage(
      ["wallet", "screenshare", "feed"],
      ["feed"], // feed declares ViewCapability → covered
      { warn: (m) => warnings.push(m) },
    );
    // wallet is mapped, feed has capabilities → only screenshare is uncovered.
    expect(uncovered).toEqual(["screenshare"]);
    expect(warnings.some((w) => w.includes("screenshare"))).toBe(true);
    expect(warnings.some((w) => w.includes("wallet"))).toBe(false);
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

  it("surfaces a view's named scopedActions in the awareness block (#13589)", async () => {
    // A view that declares scopedActions (gated named actions) → the awareness
    // block names them so the planner knows what it can invoke while here.
    const SCOPED_PLUGIN = "@test/view-scoped-named";
    // Unique view id — the beforeEach fixture already owns "wallet", and the
    // registry's conflict guard keeps the first registration for a shared id.
    await registerPluginViews({
      name: SCOPED_PLUGIN,
      description: "Scoped named action fixture.",
      views: [
        {
          id: "scoped-wallet",
          label: "Scoped Wallet",
          scopedActions: [
            {
              name: "VIEW_WALLET_SWAP_TOKENS",
              description: "Swap tokens using the wallet view controls",
              steps: [{ kind: "agent-click", target: "swap-button" }],
            },
          ],
        },
      ],
    });
    try {
      expect(viewScopedNamedActions("scoped-wallet")).toEqual([
        {
          name: "VIEW_WALLET_SWAP_TOKENS",
          description: "Swap tokens using the wallet view controls",
        },
      ]);
      const block = renderActiveViewContextBlock({
        viewId: "scoped-wallet",
        viewLabel: "Scoped Wallet",
        viewType: "gui",
        viewPath: "/scoped-wallet",
      });
      expect(block).toContain("Named actions this view exposes only while");
      expect(block).toContain("VIEW_WALLET_SWAP_TOKENS: Swap tokens");
    } finally {
      unregisterPluginViews(SCOPED_PLUGIN);
    }
  });

  it("acknowledges a just-happened switch only while it is fresh (#8788)", () => {
    const base = {
      viewId: "wallet",
      viewLabel: "Wallet",
      viewType: "gui" as const,
      viewPath: "/wallet",
    };
    // Fresh agent-initiated switch → acknowledgement line present.
    const fresh = renderActiveViewContextBlock({
      ...base,
      switchedAt: new Date().toISOString(),
      source: "agent",
    });
    expect(fresh).toContain("just switched into this view");
    expect(fresh).toContain("(you navigated here)");

    // Fresh user-initiated switch → acknowledged, without the "you navigated" note.
    const userFresh = renderActiveViewContextBlock({
      ...base,
      switchedAt: new Date().toISOString(),
      source: "user",
    });
    expect(userFresh).toContain("just switched into this view");
    expect(userFresh).not.toContain("(you navigated here)");

    // Stale switch (older than the freshness window) → no acknowledgement.
    const stale = renderActiveViewContextBlock({
      ...base,
      switchedAt: new Date(Date.now() - 20_000).toISOString(),
      source: "agent",
    });
    expect(stale).not.toContain("just switched into this view");

    // No switchedAt (sitting on the view) → no acknowledgement.
    expect(renderActiveViewContextBlock(base)).not.toContain(
      "just switched into this view",
    );
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

// Drift guard: every related action name must still exist as a
// declared `name: "X"` in source. Catches an upstream rename/removal turning a
// mapped action into a silent no-op (the runtime validator is advisory-only and
// not wired at boot). Source-static so it needs no running runtime.
describe("view related action names resolve to declared actions in source", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../../../..");

  it("all related actions are declared somewhere in source", () => {
    const names = [
      ...new Set(Object.values(viewActionAffinityMap()).flatMap((a) => [...a])),
    ];
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let out = "";
    try {
      out = execFileSync(
        "git",
        [
          "grep",
          "-hoE",
          // Accept both an inline `name: "X"` and an action name pulled from a
          // hoisted const (`const ACTION_NAME = "X"` then `name: ACTION_NAME`,
          // as plugin-documents does). The leading `name:`/`=` keeps this from
          // matching the relatedActions arrays themselves (`["X"]`).
          `(name:|=) "(${escaped.join("|")})"`,
          "--",
          "plugins",
          "packages/agent/src",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      // git grep exits 1 (no match) → declaredNames stays empty → each
      // assertion below fails with its per-name message.
    }
    const declaredNames = new Set(
      [...out.matchAll(/(?:name:|=) "([^"]+)"/g)].map((m) => m[1]),
    );

    for (const name of names) {
      expect(
        declaredNames.has(name),
        `no \`name: "${name}"\` found under plugins/ or packages/agent/src`,
      ).toBe(true);
    }
  });
});

describe("compactActionsForIntent with view-scoped actions", () => {
  const PROMPT = [
    "# Available Actions",
    "- REPLY: respond to the user",
    "  parameters: { text: string }",
    "- EVM_SWAP: swap tokens on an EVM chain",
    "  parameters: { fromToken: string, amount: number }",
    "- WHATEVER: some unrelated action",
    "  parameters: { foo: string }",
    "",
    "# Received Message",
    "12:00 User: hello there",
  ].join("\n");

  it("summarizes an action's params when neither intent nor view keeps it", () => {
    const out = compactActionsForIntent(PROMPT);
    // EVM_SWAP param schema is dropped for plain chat with no active view…
    expect(out).toContain("- EVM_SWAP: swap tokens on an EVM chain");
    expect(out).not.toContain("fromToken: string, amount: number");
    // …REPLY (universal) keeps its params.
    expect(out).toContain("text: string");
  });

  it("keeps the active view's scoped action at full param detail", () => {
    const out = compactActionsForIntent(
      PROMPT,
      viewScopedActionNames("wallet"),
    );
    // The wallet view scopes EVM_SWAP → its params survive compaction.
    expect(out).toContain("fromToken: string, amount: number");
    // The unrelated action still loses param detail.
    expect(out).not.toContain("foo: string");
  });

  // Mirrors the exact pipeline installPromptOptimizations runs on a planner
  // prompt: read the active view, weight its scoped actions through
  // compactActionsForIntent, then inject the awareness block. Locks the
  // integration contract the prompt-optimization wiring implements.
  it("end-to-end: active view weights its action AND injects awareness", () => {
    setActiveViewContext({
      viewId: "wallet",
      viewLabel: "Wallet",
      viewType: "gui",
      viewPath: "/wallet",
    });
    const active = getActiveViewContext();
    let prompt = compactActionsForIntent(
      PROMPT,
      viewScopedActionNames(active?.viewId),
    );
    if (active && prompt.includes("# Available Actions")) {
      prompt = applyActiveViewAwareness(prompt, active);
    }
    // Weighting: the wallet view's EVM_SWAP keeps full params…
    expect(prompt).toContain("fromToken: string, amount: number");
    // …unrelated action stays summarized…
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
