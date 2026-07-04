/**
 * Weights a plugin view's related actions up in the planner's tool catalogue
 * while the user is looking at that view — kept at full parameter detail so they
 * can be invoked reliably — even when the user's message contains no intent
 * keyword (e.g. "do it" while staring at the wallet).
 *
 * Complements the intent-based weighting in prompt-compaction.ts: intent looks
 * at *what the user said*, this looks at *where the user is*. Both feed the same
 * full-param action set the planner sees.
 *
 * The active view is reported by the shell via POST /api/views/:id/navigate and
 * stored here (set by views-routes) so the prompt-optimization layer can read it
 * without importing the HTTP route module. Also derives the view→action affinity
 * map, validates it for drift against registered actions/views, and renders the
 * active-view awareness block injected into planner prompts.
 */
import { getView, listViews } from "../api/views-registry.ts";

const VIEW_TYPES = ["gui", "xr", "tui"] as const;

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
  /**
   * ISO timestamp of the most recent switch INTO this view, and who drove it.
   * Carried from the navigate route so Stage-1 can acknowledge a just-happened
   * switch (#8788). Absent when the view was not freshly switched.
   */
  switchedAt?: string;
  source?: "agent" | "user";
}

/**
 * A view switch is "fresh" (worth acknowledging on the immediately-following
 * turn) for this window. Kept in lockstep with VIEW_SWITCH_FRESH_MS in
 * `views-routes.ts`.
 */
export const ACTIVE_VIEW_SWITCH_FRESH_MS = 15_000;

function isActiveViewSwitchFresh(view: ActiveViewContext): boolean {
  if (!view.switchedAt) return false;
  const at = Date.parse(view.switchedAt);
  if (Number.isNaN(at)) return false;
  return Date.now() - at <= ACTIVE_VIEW_SWITCH_FRESH_MS;
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
 * elements. Returns false when no view is active or the id differs.
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
 * Host-owned action affinity. Plugin-owned views declare their own
 * `ViewDeclaration.relatedActions`; the live view registry is the source of
 * truth for those relationships. This small fallback remains only for built-in
 * shell views without plugin declarations.
 */
const HOST_VIEW_ACTION_AFFINITY: Readonly<Record<string, readonly string[]>> = {
  "plugins-page": ["RUNTIME"],
  settings: ["RUNTIME"],
};

function normalizeRelatedActions(actions: readonly string[] | undefined) {
  return [...new Set((actions ?? []).map((a) => a.trim()).filter(Boolean))];
}

/**
 * Current view-id -> related action map derived from registered view
 * declarations plus host-owned built-in affinities.
 */
export function viewActionAffinityMap(): Record<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const [viewId, actions] of Object.entries(HOST_VIEW_ACTION_AFFINITY)) {
    map.set(viewId, [...actions]);
  }
  for (const viewType of VIEW_TYPES) {
    for (const view of listViews({
      developerMode: true,
      includeAllKinds: true,
      viewType,
    })) {
      const actions = normalizeRelatedActions(view.relatedActions);
      if (actions.length === 0) continue;
      map.set(view.id, [...new Set([...(map.get(view.id) ?? []), ...actions])]);
    }
  }
  return Object.fromEntries(map);
}

function getViewRelatedActions(viewId: string): string[] {
  for (const viewType of VIEW_TYPES) {
    const declared = normalizeRelatedActions(
      getView(viewId, { viewType })?.relatedActions,
    );
    if (declared.length > 0) return declared;
  }
  return [];
}

/**
 * Resolve the set of action names to keep at full param detail for the active
 * view. Returns an empty set when no view is active or the view has no mapped
 * actions (control still works through agent-surface capabilities).
 */
export function viewScopedActionNames(
  viewId: string | null | undefined,
): Set<string> {
  if (!viewId) return new Set();
  const declared = getViewRelatedActions(viewId);
  if (declared.length > 0) return new Set(declared);
  return new Set(HOST_VIEW_ACTION_AFFINITY[viewId] ?? []);
}

/**
 * Validate view action affinity against the runtime's registered actions, mirroring
 * validateIntentActionMap. Missing names are reported as ONE aggregated warn
 * line per boot (grouped by view) so drift is caught at startup without a
 * per-action warn flood: most view-related actions belong to optional
 * plugins (wallet, polymarket, hyperliquid, …) and a deployment that doesn't
 * load them would otherwise emit dozens of boot warnings that bury real ones.
 * Per-action detail is still available at debug level.
 */
export function validateViewActionMap(
  registeredActions: string[],
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void },
): void {
  const registered = new Set(registeredActions.map((a) => a.toUpperCase()));
  const missingByView = new Map<string, string[]>();
  for (const [viewId, actions] of Object.entries(viewActionAffinityMap())) {
    for (const action of actions) {
      if (!registered.has(action.toUpperCase())) {
        logger?.debug?.(
          `[eliza] view action affinity for "${viewId}" references "${action}" which is not a registered action`,
        );
        const list = missingByView.get(viewId);
        if (list) list.push(action);
        else missingByView.set(viewId, [action]);
      }
    }
  }
  if (missingByView.size === 0) return;
  let total = 0;
  const detail: string[] = [];
  for (const [viewId, actions] of missingByView) {
    total += actions.length;
    detail.push(`${viewId}: ${actions.join(", ")}`);
  }
  logger?.warn(
    `[eliza] view action affinity: ${total} referenced action${total === 1 ? "" : "s"} not registered (${detail.join("; ")}) — renamed/removed upstream, or provided by plugins not loaded in this config`,
  );
}

/**
 * Completeness sibling of {@link validateViewActionMap}: where that flags a
 * mapped action name that no longer exists, this flags a *registered view* that
 * has neither related actions nor any declared `ViewCapability`. It only
 * warns (the universal agent-surface still reaches every control), but surfaces
 * the affinity gap so domain actions for new views are not silently unweighted.
 * (#8798)
 *
 * @param registeredViewIds every view id the registry currently knows about.
 * @param viewsWithCapabilities view ids that declare a `ViewCapability[]`.
 */
export function validateViewCoverage(
  registeredViewIds: Iterable<string>,
  viewsWithCapabilities: Iterable<string>,
  logger?: { warn: (msg: string) => void },
): string[] {
  const mapped = new Set(Object.keys(viewActionAffinityMap()));
  const withCaps = new Set(viewsWithCapabilities);
  const uncovered: string[] = [];
  for (const viewId of registeredViewIds) {
    if (mapped.has(viewId) || withCaps.has(viewId)) continue;
    uncovered.push(viewId);
    logger?.warn(
      `[eliza] view "${viewId}" declares no relatedActions and no ViewCapability — its domain actions are not weighted while it is foreground (agent-surface element control still works)`,
    );
  }
  return uncovered;
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
  ];
  // Turn-scoped acknowledgement of a just-happened switch (#8788): only on the
  // immediately-following turn (freshness decays after 15s), so it never lingers.
  if (isActiveViewSwitchFresh(view)) {
    lines.push(
      `The user just switched into this view${view.source === "agent" ? " (you navigated here)" : ""} — briefly acknowledge the switch in your reply before doing anything else.`,
    );
  }
  lines.push(
    "You can inspect and drive everything in it through the view-interact capabilities:",
    "- list-elements — enumerate addressable controls/data (id, role, label, value, focus).",
    "- get-agent-state — read the whole view snapshot, including the focused element.",
    "- agent-click {id} / agent-fill {id,value} / agent-focus {id} / agent-scroll-to {id} — act on an element by its id.",
    "Prefer acting directly on the view over describing what the user should click.",
  );
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
 * (skips if the block is already present) and leaves the prompt unchanged when
 * no view is active. Placed just before the "# Available Actions" header so
 * view context sits next to the tool catalogue; falls back to prepending when
 * that header is absent.
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
