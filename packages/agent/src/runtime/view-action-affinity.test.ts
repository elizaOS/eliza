/**
 * Covers view-action affinity: the derived view→action map, the active-view
 * context/element snapshot lifecycle, the awareness block rendered into planner
 * prompts and the drift/coverage validators. Deterministic — synthetic plugin views registered in the
 * live views-registry, plus a source-static git-grep drift guard over
 * plugins/ and packages/agent/src.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeRuntimeViewRegistry,
  getView,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import {
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

let runtime: AgentRuntime;
let scope: { hostKey: object; clientId: string };

beforeEach(async () => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "Affinity" }),
    enableAutonomy: false,
  });
  scope = { hostKey: {}, clientId: "shell-1" };
  await registerPluginViews(runtime, {
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
      { id: "steward", label: "Steward", relatedActions: ["WALLET"] },
      {
        id: "calendar",
        label: "Calendar",
        relatedActions: ["CALENDAR"],
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
      { id: "finances", label: "Finances", relatedActions: ["OWNER_FINANCES"] },
      {
        id: "lifeops",
        label: "LifeOps",
        relatedActions: ["PERSONAL_ASSISTANT"],
      },
    ],
  });
});

afterEach(() => {
  clearActiveViewContext(runtime, scope);
  closeRuntimeViewRegistry(runtime);
});

describe("view-action-affinity", () => {
  it("stores and clears the active view", () => {
    expect(getActiveViewContext(runtime, scope)).toBeNull();
    setActiveViewContext(
      runtime,
      {
        viewId: "wallet",
        viewLabel: "Wallet",
        viewType: "gui",
        viewPath: "/wallet",
      },
      scope,
    );
    expect(getActiveViewContext(runtime, scope)?.viewId).toBe("wallet");
    clearActiveViewContext(runtime, scope);
    expect(getActiveViewContext(runtime, scope)).toBeNull();
  });

  it("preserves element snapshot on same-viewId re-publish without elements (#17918)", () => {
    const elements = [
      {
        id: "ledger-title",
        role: "textbox",
        label: "Ledger title",
        value: "Untitled",
        focused: true,
      },
      { id: "save-ledger", role: "button", label: "Save ledger" },
    ] as const;
    setActiveViewContext(
      runtime,
      {
        viewId: "scenario-active-ledger",
        viewLabel: "Scenario Active Ledger",
        viewType: "gui",
        viewPath: "/scenario/active-ledger",
        elements,
        clientId: "shell-1",
      },
      scope,
    );
    // Navigate route re-publishes the same view with no elements field.
    setActiveViewContext(
      runtime,
      {
        viewId: "scenario-active-ledger",
        viewLabel: "Scenario Active Ledger",
        viewType: "gui",
        viewPath: "/scenario/active-ledger",
        switchedAt: new Date().toISOString(),
        source: "user",
      },
      scope,
    );
    const ctx = getActiveViewContext(runtime, scope);
    expect(ctx?.viewId).toBe("scenario-active-ledger");
    expect(ctx?.elements).toEqual(elements);
    expect(ctx?.clientId).toBe("shell-1");
    // Explicit elements on same viewId still replace the snapshot.
    setActiveViewContext(
      runtime,
      {
        viewId: "scenario-active-ledger",
        viewLabel: "Scenario Active Ledger",
        viewType: "gui",
        viewPath: "/scenario/active-ledger",
        elements: [{ id: "only", role: "button", label: "Only" }],
      },
      scope,
    );
    expect(getActiveViewContext(runtime, scope)?.elements).toEqual([
      { id: "only", role: "button", label: "Only" },
    ]);
    // Different viewId drops the prior snapshot.
    setActiveViewContext(
      runtime,
      {
        viewId: "wallet",
        viewLabel: "Wallet",
        viewType: "gui",
        viewPath: "/wallet",
      },
      scope,
    );
    expect(getActiveViewContext(runtime, scope)?.elements).toBeUndefined();
  });

  it("resolves scoped action names from the map", () => {
    expect(viewScopedActionNames(runtime, "training")).toEqual(
      new Set(["RUNTIME"]),
    );
    expect(viewScopedActionNames(runtime, "orchestrator")).toEqual(
      new Set(["TASKS"]),
    );
    expect(viewScopedActionNames(runtime, "a-view-with-no-actions").size).toBe(
      0,
    );
    expect(viewScopedActionNames(runtime, null).size).toBe(0);
    expect(viewScopedActionNames(runtime, undefined).size).toBe(0);
  });

  it("covers the major plugin views (expanded map)", () => {
    // Wallet and trading surfaces boost their plugin actions.
    expect(viewScopedActionNames(runtime, "wallet").has("EVM_SWAP")).toBe(true);
    expect(
      viewScopedActionNames(runtime, "wallet").has("SOLANA_TRANSFER"),
    ).toBe(true);
    expect(viewScopedActionNames(runtime, "steward").has("WALLET")).toBe(true);
  });

  it("emphasizes each LifeOps/utility view's own domain actions", () => {
    expect(viewScopedActionNames(runtime, "calendar").has("CALENDAR")).toBe(
      true,
    );
    expect(viewScopedActionNames(runtime, "health").has("OWNER_HEALTH")).toBe(
      true,
    );
    expect(viewScopedActionNames(runtime, "todos").has("OWNER_TODOS")).toBe(
      true,
    );
    expect(viewScopedActionNames(runtime, "goals").has("OWNER_GOALS")).toBe(
      true,
    );
    expect(
      viewScopedActionNames(runtime, "finances").has("OWNER_FINANCES"),
    ).toBe(true);
    expect(
      viewScopedActionNames(runtime, "lifeops").has("PERSONAL_ASSISTANT"),
    ).toBe(true);
  });

  it("flags drift when a mapped action is not registered", () => {
    const warnings: string[] = [];
    validateViewActionMap(runtime, ["REPLY", "TASKS"], {
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
    validateViewActionMap(runtime, [], {
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
    const totalMapped = Object.values(viewActionAffinityMap(runtime)).reduce(
      (n, a) => n + a.length,
      0,
    );
    expect(debugs).toHaveLength(totalMapped);
    expect(debugs.some((d) => d.includes('affinity for "wallet"'))).toBe(true);
  });

  it("aggregated warn works when the logger has no debug method", () => {
    const warnings: string[] = [];
    validateViewActionMap(runtime, [], { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  it("does not warn when every mapped action is registered", () => {
    const allMapped = new Set<string>();
    for (const actions of Object.values(viewActionAffinityMap(runtime))) {
      for (const a of actions) allMapped.add(a);
    }
    const warnings: string[] = [];
    validateViewActionMap(runtime, [...allMapped], {
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(0);
  });

  it("keeps missing optional alternatives at debug when a view remains actionable", () => {
    const allMapped = new Set<string>();
    for (const actions of Object.values(viewActionAffinityMap(runtime))) {
      for (const action of actions) allMapped.add(action);
    }
    allMapped.delete("OWNER_SCREENTIME");
    const warnings: string[] = [];
    const debugs: string[] = [];

    validateViewActionMap(runtime, [...allMapped], {
      warn: (message) => warnings.push(message),
      debug: (message) => debugs.push(message),
    });

    expect(warnings).toHaveLength(0);
    expect(debugs.some((message) => message.includes("OWNER_SCREENTIME"))).toBe(
      true,
    );
  });

  // ── #8798: view-coverage completeness ─────────────────────────────────────

  it("built-in plugins-page/settings keep RUNTIME affinity via their declarations (#13589 stub migration)", () => {
    // The 2-entry HOST_VIEW_ACTION_AFFINITY stub ({plugins-page,settings}→RUNTIME)
    // was deleted; both built-in views declare relatedActions: ["RUNTIME"] in
    // builtin-views.ts, so once registered the derived map (and the scoped-name
    // resolver the planner reads) must still yield RUNTIME — no behavior change.
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "Builtin affinity" }),
      enableAutonomy: false,
    });
    registerBuiltinViews(runtime);
    const map = viewActionAffinityMap(runtime);
    expect(map["plugins-page"]).toContain("RUNTIME");
    expect(map.settings).toContain("RUNTIME");
    expect(viewScopedActionNames(runtime, "plugins-page").has("RUNTIME")).toBe(
      true,
    );
    expect(viewScopedActionNames(runtime, "settings").has("RUNTIME")).toBe(
      true,
    );
  });

  it("validateViewCoverage warns for a registered view with no affinity and no capabilities", () => {
    const warnings: string[] = [];
    const uncovered = validateViewCoverage(
      runtime,
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
    const block = renderActiveViewContextBlock(runtime, {
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

  it("renders action hints only for the foreground modality", async () => {
    const installation = await registerPluginViews(runtime, {
      name: "@test/modality-hints",
      description: "Distinct modality operations",
      views: (["gui", "tui"] as const).map((viewType) => ({
        id: "modal-hints",
        label: "Modality hints",
        viewType,
        relatedActions: [`${viewType.toUpperCase()}_RELATED`],
        scopedActions: [
          {
            name: `${viewType.toUpperCase()}_NAMED`,
            description: `${viewType} operation`,
            steps: [{ kind: "agent-click" as const, target: "save" }],
          },
        ],
      })),
    });
    try {
      const block = renderActiveViewContextBlock(runtime, {
        viewId: "modal-hints",
        viewLabel: "Modality hints",
        viewType: "tui",
        viewPath: "/modal-hints",
      });
      expect(block).toContain("TUI_RELATED");
      expect(block).toContain("TUI_NAMED");
      expect(block).not.toContain("GUI_RELATED");
      expect(block).not.toContain("GUI_NAMED");
      const missing = renderActiveViewContextBlock(runtime, {
        viewId: "modal-hints",
        viewLabel: "Modality hints",
        viewType: "xr",
        viewPath: null,
      });
      expect(missing).not.toContain("GUI_RELATED");
      expect(missing).not.toContain("GUI_NAMED");
    } finally {
      unregisterPluginViews(runtime, installation);
    }
  });

  it("surfaces a view's named scopedActions in the awareness block (#13589)", async () => {
    // A view that declares scopedActions (gated named actions) → the awareness
    // block names them so the planner knows what it can invoke while here.
    const SCOPED_PLUGIN = "@test/view-scoped-named";
    // Unique view id — the beforeEach fixture already owns "wallet", and the
    // registry's conflict guard keeps the first registration for a shared id.
    const installation = await registerPluginViews(runtime, {
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
      expect(viewScopedNamedActions(runtime, "scoped-wallet")).toEqual([
        {
          name: "VIEW_WALLET_SWAP_TOKENS",
          description: "Swap tokens using the wallet view controls",
        },
      ]);
      const block = renderActiveViewContextBlock(runtime, {
        viewId: "scoped-wallet",
        viewLabel: "Scoped Wallet",
        viewType: "gui",
        viewPath: "/scoped-wallet",
      });
      expect(block).toContain("Named actions this view exposes only while");
      expect(block).toContain("VIEW_WALLET_SWAP_TOKENS: Swap tokens");
    } finally {
      unregisterPluginViews(runtime, installation);
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
    const fresh = renderActiveViewContextBlock(runtime, {
      ...base,
      switchedAt: new Date().toISOString(),
      source: "agent",
    });
    expect(fresh).toContain("just switched into this view");
    expect(fresh).toContain("(you navigated here)");

    // Fresh user-initiated switch → acknowledged, without the "you navigated" note.
    const userFresh = renderActiveViewContextBlock(runtime, {
      ...base,
      switchedAt: new Date().toISOString(),
      source: "user",
    });
    expect(userFresh).toContain("just switched into this view");
    expect(userFresh).not.toContain("(you navigated here)");

    // Stale switch (older than the freshness window) → no acknowledgement.
    const stale = renderActiveViewContextBlock(runtime, {
      ...base,
      switchedAt: new Date(Date.now() - 20_000).toISOString(),
      source: "agent",
    });
    expect(stale).not.toContain("just switched into this view");

    // No switchedAt (sitting on the view) → no acknowledgement.
    expect(renderActiveViewContextBlock(runtime, base)).not.toContain(
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
    setActiveViewContext(
      runtime,
      { ...VIEW, installationId: getView(runtime, "wallet")!.installationId },
      scope,
    );
    // A background/stale view's report is dropped.
    expect(
      setActiveViewElements(
        runtime,
        getView(runtime, "orchestrator")!,
        [{ id: "x", role: "button", label: "X" }],
        scope,
      ),
    ).toBe(false);
    expect(getActiveViewContext(runtime, scope)?.elements).toBeUndefined();
    // The active view's report sticks.
    expect(
      setActiveViewElements(
        runtime,
        getView(runtime, "wallet")!,
        [{ id: "send", role: "button", label: "Send" }],
        scope,
      ),
    ).toBe(true);
    expect(getActiveViewContext(runtime, scope)?.elements).toHaveLength(1);
  });

  it("no-ops when no view is active", () => {
    expect(
      setActiveViewElements(
        runtime,
        getView(runtime, "wallet")!,
        [{ id: "send", role: "button", label: "Send" }],
        scope,
      ),
    ).toBe(false);
  });

  it("renders elements into the awareness block, focused-first, by id", () => {
    const block = renderActiveViewContextBlock(runtime, {
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

  it("does not describe hidden registered controls as currently visible", () => {
    const block = renderActiveViewContextBlock(runtime, {
      ...VIEW,
      elements: [
        {
          id: "hidden",
          role: "button",
          label: "Hidden navigation",
          visible: false,
        },
        {
          id: "shown",
          role: "button",
          label: "Visible control",
          visible: true,
        },
      ],
    });
    expect(block).not.toContain("Hidden navigation");
    expect(block).toContain("Visible control");
  });

  it("renders every active-view element", () => {
    const many = Array.from({ length: 45 }, (_unused, i) => ({
      id: `el-${i}`,
      role: "button",
      label: `E${i}`,
    }));
    const block = renderActiveViewContextBlock(runtime, {
      ...VIEW,
      elements: many,
    });
    expect(block).toContain(`- el-${many.length - 1} [button]`);
    expect(block).not.toContain("more — call list-elements");
  });

  it("omits the elements section when none are reported", () => {
    const block = renderActiveViewContextBlock(runtime, VIEW);
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
      ...new Set(
        Object.values(viewActionAffinityMap(runtime)).flatMap((a) => [...a]),
      ),
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
          // as plugin-knowledge does). The leading `name:`/`=` keeps this from
          // matching the relatedActions arrays themselves (`["X"]`).
          `(name:|=) "(${escaped.join("|")})"`,
          "--",
          "plugins",
          "packages/agent/src",
          // Core registers actions too (documents feature → DOCUMENT, the
          // personality feature → CHARACTER/PERSONALITY), and builtin views
          // may declare affinity to them (#14369).
          "packages/core/src",
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
        `no \`name: "${name}"\` found under plugins/, packages/agent/src, or packages/core/src`,
      ).toBe(true);
    }
    // Spawns a `git grep` over plugins/ + packages/agent/src + packages/core/src;
    // the added core scope (#14369) pushes the subprocess + module-load cost past
    // the 5s default on a cold checkout. Give it room so the drift guard is not
    // a flaky wall-clock gate.
  }, 30000);
});

describe("applyActiveViewAwareness", () => {
  const PROMPT = "intro text\n\n# Available Actions\n- REPLY: respond\n";

  it("injects the awareness block just before # Available Actions", () => {
    const out = applyActiveViewAwareness(runtime, PROMPT, AWARE_VIEW);
    expect(out).toContain("# Active View");
    expect(out.indexOf("# Active View")).toBeLessThan(
      out.indexOf("# Available Actions"),
    );
    // Original content is preserved.
    expect(out).toContain("- REPLY: respond");
    expect(out).toContain("intro text");
  });

  it("is a no-op when no view is active", () => {
    expect(applyActiveViewAwareness(runtime, PROMPT, null)).toBe(PROMPT);
  });

  it("is idempotent (fresh block replaces any prior block)", () => {
    const once = applyActiveViewAwareness(runtime, PROMPT, AWARE_VIEW);
    const twice = applyActiveViewAwareness(runtime, once, AWARE_VIEW);
    // Strip+reinject is content-stable for the same view snapshot.
    expect(twice.replace(/\n+/g, "\n")).toBe(once.replace(/\n+/g, "\n"));
    expect(twice.match(/# Active View/g)?.length).toBe(1);
  });

  it("replaces an incomplete Active View header with a full element snapshot (#17918)", () => {
    const withElements = {
      ...AWARE_VIEW,
      elements: [{ id: "save-ledger", role: "button", label: "Save ledger" }],
    };
    const incomplete =
      "intro text\n\n# Active View\nThe user is looking at a view with no elements section.\n\n# Available Actions\n- REPLY: respond\n";
    const out = applyActiveViewAwareness(runtime, incomplete, withElements);
    expect(out).toContain("# Active View");
    expect(out).toContain("Addressable elements currently in this view");
    expect(out).toContain("save-ledger [button]");
    // Only one Active View header remains.
    expect(out.match(/# Active View/g)?.length).toBe(1);
    expect(out).toContain("# Available Actions");
  });

  it("prepends when there is no actions header", () => {
    const out = applyActiveViewAwareness(runtime, "just a prompt", AWARE_VIEW);
    expect(out.startsWith("# Active View")).toBe(true);
    expect(out).toContain("just a prompt");
  });
});
