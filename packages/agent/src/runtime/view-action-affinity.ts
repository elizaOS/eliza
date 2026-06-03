/**
 * View-scoped action affinity.
 *
 * When the user is looking at a plugin view, the actions relevant to that view
 * should be weighted up in the planner's tool catalogue — kept at full
 * parameter detail so they can be invoked reliably — even when the user's
 * message contains no intent keyword (e.g. "do it" while staring at the wallet).
 *
 * This complements the intent-based weighting in prompt-compaction.ts: intent
 * looks at *what the user said*, this looks at *where the user is*. Both feed
 * the same full-param action set the planner sees.
 *
 * The active view is reported by the shell via POST /api/views/:id/navigate and
 * stored here (set by views-routes) so the prompt-optimization layer can read
 * it without importing the HTTP route module.
 */

/**
 * One addressable element in the active view, as reported by the shell's
 * agent-surface registry (POST /api/views/:id/elements). Mirrors the
 * list-elements snapshot shape so the planner can act on an element by id
 * (agent-click / agent-fill / agent-focus) without a list-elements round-trip.
 */
export interface ActiveViewElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  focused?: boolean;
}

/** Cap on elements rendered into the awareness block to bound prompt growth. */
export const ACTIVE_VIEW_ELEMENT_RENDER_CAP = 40;

/** Minimal description of the view the shell is currently showing. */
export interface ActiveViewContext {
  viewId: string;
  viewLabel: string;
  viewType: "gui" | "tui" | "xr";
  viewPath: string | null;
  /**
   * Live snapshot of the view's addressable elements, when the shell has
   * reported one. Absent until a report arrives (and re-cleared on navigation),
   * so the awareness block degrades gracefully to "use list-elements".
   */
  elements?: readonly ActiveViewElement[];
}

let activeView: ActiveViewContext | null = null;

export function setActiveViewContext(view: ActiveViewContext | null): void {
  activeView = view;
}

export function getActiveViewContext(): ActiveViewContext | null {
  return activeView;
}

export function clearActiveViewContext(): void {
  activeView = null;
}

/**
 * Update the element snapshot for the active view. Gated on `viewId` matching
 * the current active view so a stale or background view's report (the shell may
 * have several mounted surfaces) can never overwrite the foreground view's
 * elements. No-op — returns false — when no view is active or the id differs.
 */
export function setActiveViewElements(
  viewId: string,
  elements: readonly ActiveViewElement[],
): boolean {
  if (!activeView || activeView.viewId !== viewId) return false;
  activeView = { ...activeView, elements };
  return true;
}

/**
 * Map viewId → runtime action names that get full param detail while that view
 * is active. Names must match registered Action.name strings; verify before
 * adding. Kept deliberately conservative — only high-confidence, stable action
 * names belong here (validated against the live runtime by
 * `validateViewActionMap`). Universal element control in any view is handled by
 * the agent-surface view-interact capabilities (list-elements / agent-click /
 * agent-fill), which are not runtime actions and so do not appear here.
 *
 * Verified action names (2026-05-31):
 *   TASKS      — plugin-agent-orchestrator tasks action (coding/orchestration)
 *   PLAY_EMOTE — plugin-companion/src/actions/emote.ts
 *   RUNTIME    — packages/agent/src/actions/runtime.ts (restart/config ops)
 *
 * Verified action names + view ids (2026-06-02) — view id from each plugin's
 * ViewDeclaration, action `name:` from that plugin's (or a thematically paired
 * plugin's) action source. Actions are plugin-conditional: when the owning
 * plugin is not loaded the name is simply not registered and the weighting is a
 * no-op (no error). Sources:
 *   wallet      — view plugins/plugin-wallet-ui; actions plugins/plugin-wallet
 *                 (chains/evm/actions swap+transfer, chains generated specs)
 *   polymarket  — plugins/plugin-polymarket-app/src/actions.ts (POLYMARKET_STATUS)
 *   hyperliquid — plugins/plugin-hyperliquid-app/src/actions/perpetual-market.ts
 *   steward     — plugin-steward-app re-exports plugin-wallet's WALLET action
 *   facewear    — plugins/plugin-facewear/src/index.ts (FACEWEAR_, SMARTGLASSES_, XR_ actions)
 *   scape       — plugins/plugin-scape/src/actions (SCAPE)
 *   2004scape   — plugins/plugin-2004scape/src/actions (RS_2004, RS_2004_INVENTORY)
 */
export const VIEW_ACTION_MAP: Record<string, readonly string[]> = {
  companion: ["PLAY_EMOTE"],
  "task-coordinator": ["TASKS"],
  orchestrator: ["TASKS"],
  "trajectory-logger": ["TASKS"],
  training: ["RUNTIME"],
  "plugins-page": ["RUNTIME"],
  settings: ["RUNTIME"],
  wallet: [
    "WALLET",
    "EVM_SWAP",
    "EVM_TRANSFER",
    "SOLANA_SWAP",
    "SOLANA_TRANSFER",
    "CROSS_CHAIN_TRANSFER",
    "BIRDEYE_WALLET_PORTFOLIO",
  ],
  steward: ["WALLET"],
  polymarket: ["POLYMARKET_STATUS"],
  hyperliquid: ["PERPETUAL_MARKET"],
  facewear: [
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
  scape: ["SCAPE"],
  "2004scape": ["RS_2004", "RS_2004_INVENTORY"],
};

/**
 * Resolve the set of action names to keep at full param detail for the active
 * view. Returns an empty set when no view is active or the view has no mapped
 * actions (control still works through agent-surface capabilities).
 */
export function viewScopedActionNames(
  viewId: string | null | undefined,
): Set<string> {
  if (!viewId) return new Set();
  return new Set(VIEW_ACTION_MAP[viewId] ?? []);
}

/**
 * Validate VIEW_ACTION_MAP against the runtime's registered actions, mirroring
 * validateIntentActionMap. Logs a warning for any mapped name that no longer
 * exists so drift is caught at startup rather than silently dropped.
 */
export function validateViewActionMap(
  registeredActions: string[],
  logger?: { warn: (msg: string) => void },
): void {
  const registered = new Set(registeredActions.map((a) => a.toUpperCase()));
  for (const [viewId, actions] of Object.entries(VIEW_ACTION_MAP)) {
    for (const action of actions) {
      if (!registered.has(action.toUpperCase())) {
        logger?.warn(
          `[eliza] VIEW_ACTION_MAP["${viewId}"] references "${action}" which is not a registered action — may be renamed or removed upstream`,
        );
      }
    }
  }
}

/**
 * Render a compact "Active View" awareness block for the planner. Describes the
 * surface the user is looking at and reminds the agent it can drive every
 * element through the view-interact capabilities. Exposed for the planner /
 * context-renderer to inject; pure so it is trivially testable.
 */
export function renderActiveViewContextBlock(view: ActiveViewContext): string {
  const scoped = [...viewScopedActionNames(view.viewId)];
  const lines = [
    "# Active View",
    `The user is looking at the "${view.viewLabel}" view (id: ${view.viewId}, ${view.viewType}${view.viewPath ? `, path ${view.viewPath}` : ""}).`,
    "You can inspect and drive everything in it through the view-interact capabilities:",
    "- list-elements — enumerate addressable controls/data (id, role, label, value, focus).",
    "- get-agent-state — read the whole view snapshot, including the focused element.",
    "- agent-click {id} / agent-fill {id,value} / agent-focus {id} / agent-scroll-to {id} — act on an element by its id.",
    "Prefer acting directly on the view over describing what the user should click.",
  ];
  if (scoped.length > 0) {
    lines.push(
      `Actions most relevant while on this view (prefer these when the request fits): ${scoped.join(", ")}.`,
    );
  }
  const elements = view.elements ?? [];
  if (elements.length > 0) {
    // Focused element first, then declared order; cap to bound prompt growth.
    const ordered = [...elements].sort(
      (a, b) => Number(b.focused ?? false) - Number(a.focused ?? false),
    );
    const shown = ordered.slice(0, ACTIVE_VIEW_ELEMENT_RENDER_CAP);
    lines.push(
      "Addressable elements currently in this view (act on these by id — no list-elements call needed):",
    );
    for (const el of shown) {
      const value =
        typeof el.value === "string" && el.value.length > 0
          ? ` = ${JSON.stringify(el.value)}`
          : "";
      const focused = el.focused ? " (focused)" : "";
      lines.push(
        `- ${el.id} [${el.role}] ${JSON.stringify(el.label)}${value}${focused}`,
      );
    }
    if (elements.length > shown.length) {
      lines.push(
        `- …and ${elements.length - shown.length} more — call list-elements for the rest.`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Inject the active-view awareness block into a planner prompt. Idempotent
 * (skips if the block is already present) and a no-op when no view is active.
 * Placed just before the "# Available Actions" header so view context sits next
 * to the tool catalogue; falls back to prepending when that header is absent.
 */
export function applyActiveViewAwareness(
  prompt: string,
  view: ActiveViewContext | null | undefined,
): string {
  if (!view) return prompt;
  if (prompt.includes("# Active View")) return prompt;
  const block = renderActiveViewContextBlock(view);
  const header = "\n# Available Actions";
  const idx = prompt.indexOf(header);
  if (idx === -1) return `${block}\n\n${prompt}`;
  return `${prompt.slice(0, idx)}\n\n${block}\n${prompt.slice(idx + 1)}`;
}
