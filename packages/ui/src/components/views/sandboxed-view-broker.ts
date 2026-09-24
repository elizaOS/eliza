/**
 * postMessage capability broker for `sandboxed-iframe` views (#14180). A framed
 * view runs in an opaque-origin `<iframe sandbox>` (see `sandbox-policy.ts`), so
 * it has zero ambient access to the shell — no shared DOM, storage, cookies, or
 * navigation. The only channel out is `postMessage`, and this module is the gate
 * on the parent side of it: it parses the untrusted message (J3), checks the
 * requested {@link SurfaceCapability} against the view's resolved manifest, and
 * either services the request through a host facility or returns a typed denial.
 *
 * It mirrors the deny-by-default doctrine of the same-realm agent-interact broker
 * (`view-capability-broker.ts`, #14068): anything not explicitly granted is
 * denied, an unparseable/unknown message is dropped, and a denied request yields
 * an observable typed error to the framed view — never a silent no-op that a
 * plugin could mistake for success. `navigate` and `storage` are the only
 * facilities exposed; they already exist as `SurfaceCapability` values.
 *
 * Consumed by `SandboxedViewFrame.tsx` (which binds the {@link SandboxHostFacilities}
 * to the real shell navigate/storage) and unit-tested in
 * `sandboxed-view-broker.test.ts`.
 */

import {
  type ResolvedSurfaceManifest,
  type SurfaceCapability,
  surfaceGrants,
} from "@elizaos/core";

/** Marks every frame of the sandboxed-view protocol so unrelated postMessages are ignored. */
export const SANDBOXED_VIEW_CHANNEL = "eliza:sandboxed-view" as const;

/** The capabilities a framed view may request over postMessage. */
const BROKERED_CAPABILITIES: ReadonlySet<SurfaceCapability> =
  new Set<SurfaceCapability>(["navigate", "storage"]);

/** A request a framed view sends to the shell. */
export interface SandboxedViewRequest {
  channel: typeof SANDBOXED_VIEW_CHANNEL;
  kind: "request";
  /** Correlates the response the shell posts back. */
  requestId: string;
  capability: SurfaceCapability;
  /** Capability-specific arguments, validated by the servicing facility. */
  payload?: unknown;
}

/** The reply the shell posts back to the framed view for a request. */
export interface SandboxedViewResponse {
  channel: typeof SANDBOXED_VIEW_CHANNEL;
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  /** Present iff `ok` is false — a human-readable denial/failure reason. */
  error?: string;
}

/**
 * The real shell facilities the broker calls when a capability is granted. The
 * frame component binds these to `dispatchNavigateViewEvent` and a per-view
 * namespaced storage; tests bind them to spies to assert the broker only reaches
 * a facility when the grant check passes.
 */
export interface SandboxHostFacilities {
  navigate(payload: unknown): Promise<unknown>;
  storage(payload: unknown): Promise<unknown>;
}

/**
 * Parse an untrusted `MessageEvent.data` into a {@link SandboxedViewRequest}, or
 * `null` if it is not a well-formed request for a brokered capability. This is
 * the J3 boundary: a malformed or unknown-capability message is rejected here
 * and never reaches a facility.
 */
export function parseSandboxedViewRequest(
  data: unknown,
): SandboxedViewRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.channel !== SANDBOXED_VIEW_CHANNEL) return null;
  if (msg.kind !== "request") return null;
  if (typeof msg.requestId !== "string" || msg.requestId.length === 0) {
    return null;
  }
  const capability = msg.capability;
  if (
    typeof capability !== "string" ||
    !BROKERED_CAPABILITIES.has(capability as SurfaceCapability)
  ) {
    return null;
  }
  return {
    channel: SANDBOXED_VIEW_CHANNEL,
    kind: "request",
    requestId: msg.requestId,
    capability: capability as SurfaceCapability,
    payload: msg.payload,
  };
}

/** Raised when a framed view requests a capability its manifest does not grant. */
export class SandboxCapabilityDeniedError extends Error {
  constructor(
    readonly viewId: string,
    readonly capability: SurfaceCapability,
  ) {
    super(
      `Sandboxed view "${viewId}" is not granted capability "${capability}"`,
    );
    this.name = "SandboxCapabilityDeniedError";
  }
}

/**
 * Broker one parsed request against the manifest. Returns the response frame to
 * post back to the view. A capability the manifest does not grant is denied
 * before the facility runs, so an ungranted `navigate`/`storage` can never reach
 * the shell — the denial is reported as `ok: false` with a reason, never a
 * fabricated success.
 */
export async function brokerSandboxedViewRequest(
  viewId: string,
  manifest: ResolvedSurfaceManifest,
  request: SandboxedViewRequest,
  facilities: SandboxHostFacilities,
): Promise<SandboxedViewResponse> {
  const base = {
    channel: SANDBOXED_VIEW_CHANNEL,
    kind: "response",
    requestId: request.requestId,
  } as const;

  if (!surfaceGrants(manifest, request.capability)) {
    return {
      ...base,
      ok: false,
      error: new SandboxCapabilityDeniedError(viewId, request.capability)
        .message,
    };
  }

  try {
    const facility =
      request.capability === "navigate"
        ? facilities.navigate
        : facilities.storage;
    const result = await facility(request.payload);
    return { ...base, ok: true, result };
  } catch (error) {
    // error-policy:J1 boundary translation — the framed view is a transport
    // boundary; a facility throw (bad payload, storage failure) becomes a typed
    // failure frame the view observes, never a fabricated success.
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
