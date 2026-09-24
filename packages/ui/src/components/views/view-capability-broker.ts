/**
 * Capability broker for dynamically-loaded plugin views (#13452). A view bundle
 * runs in the host realm and the agent can drive it through the view-interact
 * channel (`get-state`, `agent-fill`, `click-element`, …). Without a boundary,
 * every loaded view would expose the full mutating surface to the agent — a
 * plugin view could be driven to click/fill/focus its own DOM even when its
 * author never opted into agent control.
 *
 * The broker gates that surface on the view's resolved {@link
 * ResolvedSurfaceManifest}: a view only gets the mutating agent-surface
 * capabilities when its manifest grants `agent-surface`. Read-only introspection
 * (`get-text`, `get-state`, `list-elements`, `describe-element`, focus/agent
 * state reads) is always allowed — the agent can always *inspect* a mounted view
 * to reason about it — but write operations (fill/click/focus/scroll, forced
 * refresh) require the explicit grant. `DynamicViewLoader` wraps its interact
 * handler with {@link brokerViewInteract} so the gate sits on the one path every
 * capability call flows through.
 *
 * Consumed by `DynamicViewLoader.tsx`. The classification is grep-able and
 * unit-tested in `view-capability-broker.test.ts`.
 */

import type { ResolvedSurfaceManifest } from "@elizaos/core";
import { surfaceGrants } from "@elizaos/core";

/**
 * Interact capabilities that only READ view state. Always permitted — inspecting
 * a mounted view is never a privileged operation, so the agent can reason about
 * any view regardless of its grants.
 */
const READ_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
  // Standard read capabilities.
  "get-text",
  "get-state",
  // Agent-surface read capabilities.
  "list-elements",
  "describe-element",
  "get-focus",
  "get-agent-state",
]);

/**
 * Interact capabilities that MUTATE the view (fill/click/focus/scroll a field,
 * force a refresh/remount, toggle a highlight). Permitted only when the view's
 * manifest grants `agent-surface`. Anything not in {@link READ_ONLY_CAPABILITIES}
 * is treated as mutating by default — a new capability is denied-by-default until
 * it is explicitly classified read-only, so the gate fails closed.
 */
export function isReadOnlyViewCapability(capability: string): boolean {
  return READ_ONLY_CAPABILITIES.has(capability);
}

/**
 * Whether the manifest permits a given interact capability. Read-only
 * capabilities are always allowed; every mutating capability requires the
 * `agent-surface` grant.
 */
export function viewManifestAllowsCapability(
  manifest: ResolvedSurfaceManifest,
  capability: string,
): boolean {
  if (isReadOnlyViewCapability(capability)) return true;
  return surfaceGrants(manifest, "agent-surface");
}

/** Raised when a view is driven with a capability its manifest does not grant. */
export class ViewCapabilityDeniedError extends Error {
  constructor(
    readonly viewId: string,
    readonly capability: string,
  ) {
    super(
      `View "${viewId}" is not granted capability "${capability}" ` +
        "(its surface manifest does not grant `agent-surface`)",
    );
    this.name = "ViewCapabilityDeniedError";
  }
}

/**
 * Wrap a view's interact handler with the manifest gate. The returned handler
 * throws {@link ViewCapabilityDeniedError} for any mutating capability the
 * manifest does not grant, and otherwise delegates to the underlying handler.
 *
 * The thrown error surfaces to the agent through the view-interact result path
 * (the planner sees the failure and can react) — it never fabricates a
 * success/no-op, so a denied write is observably denied, not silently dropped.
 */
export function brokerViewInteract(
  viewId: string,
  manifest: ResolvedSurfaceManifest,
  handler: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>,
): (capability: string, params?: Record<string, unknown>) => Promise<unknown> {
  return async (capability, params) => {
    if (!viewManifestAllowsCapability(manifest, capability)) {
      throw new ViewCapabilityDeniedError(viewId, capability);
    }
    return handler(capability, params);
  };
}
