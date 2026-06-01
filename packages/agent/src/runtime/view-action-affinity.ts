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

/** Minimal description of the view the shell is currently showing. */
export interface ActiveViewContext {
  viewId: string;
  viewLabel: string;
  viewType: "gui" | "tui" | "xr";
  viewPath: string | null;
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
 */
export const VIEW_ACTION_MAP: Record<string, readonly string[]> = {
  companion: ["PLAY_EMOTE"],
  "task-coordinator": ["TASKS"],
  orchestrator: ["TASKS"],
  "trajectory-logger": ["TASKS"],
  training: ["RUNTIME"],
  "plugins-page": ["RUNTIME"],
  settings: ["RUNTIME"],
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
  return [
    "# Active View",
    `The user is looking at the "${view.viewLabel}" view (id: ${view.viewId}, ${view.viewType}${view.viewPath ? `, path ${view.viewPath}` : ""}).`,
    "You can inspect and drive everything in it through the view-interact capabilities:",
    "- list-elements — enumerate addressable controls/data (id, role, label, value, focus).",
    "- get-agent-state — read the whole view snapshot, including the focused element.",
    "- agent-click {id} / agent-fill {id,value} / agent-focus {id} / agent-scroll-to {id} — act on an element by its id.",
    "Prefer acting directly on the view over describing what the user should click.",
  ].join("\n");
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
