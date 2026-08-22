/**
 * Tracks the plugin view currently visible to the user so the planner receives
 * its complete addressable-element snapshot and can act without an extra
 * discovery round-trip. The active view is reported by the shell via POST /api/views/:id/navigate and
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

/** Minimal description of the view the shell is currently showing. */
export interface ActiveViewContext {
  viewId: string;
  viewLabel: string;
  viewType: "gui" | "tui" | "xr";
  viewPath: string | null;
  /**
   * Live snapshot of the view's addressable elements, when the shell has
   * reported one. Absent until a report arrives. Cleared when navigating to a
   * *different* viewId; re-navigate / re-publish of the same viewId preserves
   * the prior snapshot unless the caller supplies a new `elements` array
   * (#17918 / setActiveViewContext merge).
   */
  elements?: readonly ActiveViewElement[];
  /**
   * WebSocket client id for the shell that most recently reported this active
   * view's mounted element snapshot. Mutating frontend interactions target this
   * owner so multiple shells cannot all execute one agent action.
   */
  clientId?: string;
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

/**
 * Publish the shell's current view for planner awareness.
 *
 * When the caller re-publishes the *same* `viewId` without an `elements`
 * (or `clientId`) field — the navigate route does this on every re-navigate —
 * keep the prior element snapshot so multi-turn planner prompts do not lose
 * the addressable-element block after the first interact (#17918). Navigating
 * to a different viewId still replaces the context wholesale (elements drop
 * until the shell reports a new snapshot).
 */
export function setActiveViewContext(view: ActiveViewContext | null): void {
  if (view === null) {
    activeView = null;
    return;
  }
  if (activeView && activeView.viewId === view.viewId) {
    activeView = {
      ...view,
      elements: view.elements ?? activeView.elements,
      clientId: view.clientId ?? activeView.clientId,
    };
    return;
  }
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
  clientId?: string | null,
): boolean {
  if (!activeView || activeView.viewId !== viewId) return false;
  activeView = {
    ...activeView,
    elements,
    ...(clientId ? { clientId } : {}),
  };
  return true;
}

function normalizeRelatedActions(actions: readonly string[] | undefined) {
  return [...new Set((actions ?? []).map((a) => a.trim()).filter(Boolean))];
}

/**
 * Current view-id -> related action map derived entirely from registered view
 * declarations. The live view registry — plugin views AND the built-in shell
 * views (registered from `builtin-views.ts`, which carry their own
 * `relatedActions`) — is the single source of truth. There is no host-owned
 * fallback table: a view that wants an action weighted while it is foreground
 * declares `relatedActions`; a view that wants a GATED action it exposes only
 * while active declares `scopedActions` (see view-scoped-actions.ts).
 */
export function viewActionAffinityMap(): Record<string, readonly string[]> {
  const map = new Map<string, string[]>();
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
 * view — its declared `relatedActions`. Returns an empty set when no view is
 * active or the view declares none (control still works through agent-surface
 * capabilities and, for gated named actions, the view-scoped action registry).
 */
export function viewScopedActionNames(
  viewId: string | null | undefined,
): Set<string> {
  if (!viewId) return new Set();
  return new Set(getViewRelatedActions(viewId));
}

/**
 * Named view-scoped agent actions (`ViewDeclaration.scopedActions`) a view
 * exposes, as `{ name, description }`. These are gated actions — the host only
 * exposes them to the planner while this view is active (see
 * view-scoped-actions.ts) — so the awareness block names them for the planner.
 * Read from the registry entry (which carries the declaration) rather than the
 * action registry to avoid an import cycle with the registration module.
 */
export function viewScopedNamedActions(
  viewId: string | null | undefined,
): { name: string; description: string }[] {
  if (!viewId) return [];
  for (const viewType of VIEW_TYPES) {
    const scoped = getView(viewId, { viewType })?.scopedActions;
    if (scoped && scoped.length > 0) {
      return scoped.map((a) => ({ name: a.name, description: a.description }));
    }
  }
  return [];
}

/**
 * Validate view action affinity against the runtime's registered actions,
 * mirroring validateIntentActionMap. A view may declare alternative actions
 * supplied by optional plugins, so partial misses remain debug diagnostics.
 * Warn only when none of a view's declared actions exist; those fully broken
 * mappings are aggregated into one line per boot.
 */
export function validateViewActionMap(
  registeredActions: string[],
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void },
): void {
  const registered = new Set(registeredActions.map((a) => a.toUpperCase()));
  const missingByView = new Map<string, string[]>();
  for (const [viewId, actions] of Object.entries(viewActionAffinityMap())) {
    const missing = actions.filter(
      (action) => !registered.has(action.toUpperCase()),
    );
    for (const action of missing) {
      logger?.debug?.(
        `[eliza] view action affinity for "${viewId}" references "${action}" which is not a registered action`,
      );
    }
    if (missing.length === actions.length) {
      missingByView.set(viewId, missing);
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
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void },
): string[] {
  const mapped = new Set(Object.keys(viewActionAffinityMap()));
  const withCaps = new Set(viewsWithCapabilities);
  const uncovered: string[] = [];
  for (const viewId of registeredViewIds) {
    if (mapped.has(viewId) || withCaps.has(viewId)) continue;
    uncovered.push(viewId);
    logger?.debug?.(
      `[eliza] view "${viewId}" declares no relatedActions and no ViewCapability — its domain actions are not weighted while it is foreground (agent-surface element control still works)`,
    );
  }
  if (uncovered.length > 0) {
    logger?.warn(
      `[eliza] view coverage: ${uncovered.length} view${uncovered.length === 1 ? "" : "s"} declare no relatedActions or ViewCapability (${uncovered.join(", ")}) — domain actions are not foreground-weighted`,
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
  const named = viewScopedNamedActions(view.viewId);
  if (named.length > 0) {
    lines.push(
      "Named actions this view exposes only while it is active (invoke by name — they drive its controls for you):",
    );
    for (const action of named) {
      lines.push(`- ${action.name}: ${action.description}`);
    }
  }
  const elements = view.elements ?? [];
  if (elements.length > 0) {
    // Focused element first, then declared order.
    const ordered = [...elements].sort(
      (a, b) => Number(b.focused ?? false) - Number(a.focused ?? false),
    );
    const shown = ordered;
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
  }
  return lines.join("\n");
}

/**
 * Remove a previously injected Active View block (header through the line
 * before the next top-level `# ` section or end). Used so re-injection can
 * replace a stale incomplete block that still has the header but lost the
 * addressable-element list (#17918).
 */
export function stripActiveViewAwarenessBlock(prompt: string): string {
  const header = "# Active View";
  const start = prompt.indexOf(header);
  if (start === -1) return prompt;
  // Walk forward line-by-line until the next markdown section header or EOS.
  let end = start + header.length;
  while (end < prompt.length) {
    const nextNl = prompt.indexOf("\n", end);
    if (nextNl === -1) {
      end = prompt.length;
      break;
    }
    const lineStart = nextNl + 1;
    if (
      prompt.startsWith("# ", lineStart) &&
      !prompt.startsWith("# Active View", lineStart)
    ) {
      end = nextNl;
      break;
    }
    end = lineStart;
    // consume rest of this line on next iteration via indexOf from end
    const lineEnd = prompt.indexOf("\n", lineStart);
    end = lineEnd === -1 ? prompt.length : lineEnd;
  }
  // Drop a single leading newline before the block when present.
  let from = start;
  if (from > 0 && prompt[from - 1] === "\n") from -= 1;
  return `${prompt.slice(0, from)}${prompt.slice(end)}`;
}

/**
 * Inject the active-view awareness block into a planner prompt. Always
 * re-injects a fresh block from the current view snapshot (stripping any
 * prior block first) so multi-turn compaction cannot leave a header without
 * the element list (#17918). Placed just before the "# Available Actions"
 * header when present; otherwise prepended.
 */
export function applyActiveViewAwareness(
  prompt: string,
  view: ActiveViewContext | null | undefined,
): string {
  if (!view) return prompt;
  const cleaned = stripActiveViewAwarenessBlock(prompt);
  const block = renderActiveViewContextBlock(view);
  const header = "\n# Available Actions";
  const idx = cleaned.indexOf(header);
  if (idx === -1) {
    const body = cleaned.trimStart();
    return body.length === 0 ? block : `${block}\n\n${body}`;
  }
  return `${cleaned.slice(0, idx)}\n\n${block}\n${cleaned.slice(idx + 1)}`;
}
