/**
 * Enforces each mounted view's declared agent authority before dispatch.
 * Human-only capabilities are always denied. Explicit agent capabilities may
 * invoke the view's semantic handler without granting generic DOM mutation;
 * legacy operations retain the surface-manifest grant rules. Dynamic bundles
 * and bundled native pages share this broker.
 */

import type { ResolvedSurfaceManifest, ViewCapability } from "@elizaos/core";
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
 * Declared human authority overrides every grant. Explicit agent authority
 * admits a named semantic operation; otherwise legacy reads and the generic
 * `agent-surface` grant determine admission.
 */
export function viewManifestAllowsCapability(
  manifest: ResolvedSurfaceManifest,
  capability: string,
  declarations?: readonly ViewCapability[],
): boolean {
  const declared = declarations?.filter((entry) => entry.id === capability);
  if (declared?.some((entry) => entry.authority === "human")) return false;
  if (declared?.some((entry) => entry.authority === "agent")) return true;
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
        "(agent-surface or declared agent authority is required; human-only capabilities are denied)",
    );
    this.name = "ViewCapabilityDeniedError";
  }
}

/**
 * Wrap a view handler with its capability and manifest authority. Denied
 * operations throw before either a semantic handler or a DOM operation runs.
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
  declarations?: readonly ViewCapability[],
): (capability: string, params?: Record<string, unknown>) => Promise<unknown> {
  return async (capability, params) => {
    if (!viewManifestAllowsCapability(manifest, capability, declarations)) {
      throw new ViewCapabilityDeniedError(viewId, capability);
    }
    return handler(capability, params);
  };
}
