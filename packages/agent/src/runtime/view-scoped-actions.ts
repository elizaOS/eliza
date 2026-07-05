/**
 * View-scoped agent actions: named domain actions a view registers that are
 * only selectable/executable while that view is the foreground surface.
 *
 * Where `view-action-affinity.ts` only *upweights* genuinely-global actions
 * while their view is foreground, this gates availability: a scoped action's
 * `validate()` returns false unless the declaring view is the active view (read
 * from the same authoritative `active-view-state` the affinity map uses), so
 * switching views flips it on/off with no restart. Plugin views register their
 * scoped actions through their plugin's `actions`, built-in shell views through
 * `builtin-views.ts`; both wrap the action with {@link defineViewScopedAction}.
 *
 * Handlers resolve a named action (e.g. `set-provider`) to a deterministic
 * sequence of agent-surface element operations (`agent-fill` / `agent-click` /
 * `agent-focus`) against the same `useAgentElement` ids the interact protocol
 * drives — {@link resolveScopedElementOps} validates every target id against the
 * active view's reported element snapshot and throws (never silently no-ops)
 * when one is missing, so there is no parallel DOM-driving path.
 */

import { ElizaError } from "@elizaos/core";
import type { Action, Validator } from "@elizaos/core";
import {
  type ActiveViewElement,
  getActiveViewContext,
} from "./active-view-state.ts";

/** True when `viewId` is the view the shell is currently showing. */
export function isViewActive(viewId: string): boolean {
  return getActiveViewContext()?.viewId === viewId;
}

/**
 * Wrap a validator so it only passes while `viewId` is the active view. When
 * the view is active the inner validator (if any) decides; when it is not, the
 * action is unavailable regardless of what the inner validator would return.
 * A scoped action with no domain precondition passes `undefined` and is gated
 * purely on the active view.
 */
export function gateValidatorToActiveView(
  viewId: string,
  inner?: Validator,
): Validator {
  return async (runtime, message, state, options) => {
    if (!isViewActive(viewId)) return false;
    if (!inner) return true;
    return inner(runtime, message, state, options);
  };
}

// viewId -> ordered set of scoped action names registered against it. Drives
// the planner full-detail set and the awareness-block listing while the view is
// active; kept separate from the executable Action so the affinity renderer can
// read names without importing the actions themselves.
const scopedActionNamesByView = new Map<string, Set<string>>();

/**
 * Gate an action to a view and record the association so the planner keeps it
 * at full parameter detail (and lists it in the active-view awareness block)
 * while the view is foreground. Returns a new `Action`; the input is not
 * mutated. Register the returned action normally (plugin `actions` / built-in
 * shell registration) — the runtime treats it like any other action, and the
 * gated `validate()` makes it available only on its view.
 */
export function defineViewScopedAction(viewId: string, action: Action): Action {
  const names = scopedActionNamesByView.get(viewId) ?? new Set<string>();
  names.add(action.name);
  scopedActionNamesByView.set(viewId, names);
  const tags = new Set(action.tags ?? []);
  tags.add(VIEW_SCOPED_ACTION_TAG);
  tags.add(`view:${viewId}`);
  return {
    ...action,
    validate: gateValidatorToActiveView(viewId, action.validate),
    tags: [...tags],
  };
}

/** Tag stamped on every action produced by {@link defineViewScopedAction}. */
export const VIEW_SCOPED_ACTION_TAG = "view-scoped" as const;

/** Scoped action names registered against `viewId` (empty when none). */
export function viewScopedActionRegistryNames(
  viewId: string | null | undefined,
): string[] {
  if (!viewId) return [];
  const names = scopedActionNamesByView.get(viewId);
  return names ? [...names] : [];
}

/** Scoped action names whose view is currently the active view. */
export function activeViewScopedActionNames(): string[] {
  return viewScopedActionRegistryNames(getActiveViewContext()?.viewId);
}

/** Drop all scoped-action registrations. Test-only reset. */
export function clearViewScopedActions(): void {
  scopedActionNamesByView.clear();
}

/**
 * One deterministic element operation a scoped-action handler resolves to,
 * addressing a `useAgentElement` id the interact protocol can drive.
 */
export type ScopedActionElementOp =
  | { readonly op: "agent-fill"; readonly elementId: string; readonly value: string }
  | { readonly op: "agent-click"; readonly elementId: string }
  | { readonly op: "agent-focus"; readonly elementId: string }
  | { readonly op: "agent-scroll-to"; readonly elementId: string };

/**
 * Validate a scoped action's element sequence against the active view's live
 * element snapshot before dispatch. Fails loudly with a typed {@link ElizaError}
 * — never a silent no-op — when the declaring view is not active or a target
 * `useAgentElement` id is absent, so a renamed/removed control surfaces to the
 * agent instead of a fabricated success. Returns the ops unchanged on success
 * so callers can dispatch them through the interact bridge.
 */
export function resolveScopedElementOps(
  viewId: string,
  ops: readonly ScopedActionElementOp[],
): readonly ScopedActionElementOp[] {
  const active = getActiveViewContext();
  if (!active || active.viewId !== viewId) {
    throw new ElizaError(
      `Cannot resolve scoped element ops for view "${viewId}": it is not the active view`,
      {
        code: "VIEW_SCOPED_ACTION_VIEW_INACTIVE",
        context: { viewId, activeViewId: active?.viewId ?? null },
      },
    );
  }
  const known = new Set<string>(
    (active.elements ?? []).map((el: ActiveViewElement) => el.id),
  );
  const missing = ops
    .map((o) => o.elementId)
    .filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new ElizaError(
      `Scoped action targets element id(s) not present in view "${viewId}": ${missing.join(", ")}`,
      {
        code: "VIEW_SCOPED_ACTION_ELEMENT_MISSING",
        context: { viewId, missing, known: [...known] },
      },
    );
  }
  return ops;
}
