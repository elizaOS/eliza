/** Reply correlation belongs to one runtime, HTTP host, and authenticated client. */
import { randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type RoleGateRole,
  satisfiesRoleGate,
} from "@elizaos/core";
import {
  onNativeViewDisconnect,
  sendNativeViewFrame,
} from "./native-view-renderer.ts";
import {
  PendingRequestMap,
  type ViewInteractResult,
} from "./pending-request-map.ts";
import { assertRuntimeViewEntry } from "./view-installations.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";

export interface ViewInteractionBinding {
  requestId: string;
  viewId: string;
  viewType: string;
  installationId: string;
}

export type RendererViewInteractResult = ViewInteractResult &
  Partial<ViewInteractionBinding> & { claimId?: string };

/**
 * How long a granted navigation claim may stay unsettled before the host
 * retires it as not delivered. A claim is granted before the renderer learns
 * its claimId, so a claim response lost to a renderer deadline leaves a claim
 * nobody can settle; without a lease it would hold the renderer's navigation
 * slot (VIEW_NAVIGATION_BUSY) until the 120 s preparation timeout.
 *
 * The renderer bounds every claimed navigation: its claim request has a 5 s
 * deadline, then it posts the result (or a negative cleanup with a 1.5 s
 * deadline) at once; an agent-delivered switch posts its result within 5 s of
 * the view commit. 10 s covers the longest of those windows with margin for a
 * loaded device while bounding a lost claim to a twelfth of the old stall.
 */
export const NAVIGATION_CLAIM_LEASE_MS = 10_000;

/**
 * How long a new navigation preparation waits for a claimed navigation of the
 * same renderer and owner to settle (or its lease to expire) before reporting
 * VIEW_NAVIGATION_BUSY. Kept under the agent action's 5 s preparation deadline
 * so the caller receives the typed busy refusal rather than an abort.
 */
export const NAVIGATION_BUSY_WAIT_MS = 4_000;

interface PendingCaller {
  clientId: string;
  entry: ViewRegistryEntry;
  claimId?: string;
  ownerId?: string;
  navigation?: boolean;
  /** Settles (never rejects) once this waiter has resolved, failed or expired. */
  settled: Promise<void>;
  lease?: ReturnType<typeof setTimeout>;
}

export class ViewInteractionHost {
  private closed = false;
  private readonly pending = new PendingRequestMap();
  private readonly callers = new Map<string, PendingCaller>();

  private readonly stopSignal: AbortSignal | undefined;
  private readonly onRuntimeStop = () => this.close();

  constructor(readonly runtime: IAgentRuntime) {
    this.stopSignal = runtime.getStopSignal?.();
    if (this.stopSignal?.aborted) this.close();
    else
      this.stopSignal?.addEventListener("abort", this.onRuntimeStop, {
        once: true,
      });
  }

  waitFor(
    requestId: string,
    clientId: string,
    entry: ViewRegistryEntry,
    timeoutMs: number,
    binding: { ownerId?: string; navigation?: boolean } = {},
  ): Promise<ViewInteractResult> {
    if (this.closed)
      throw new ElizaError("View host is closed", { code: "VIEW_HOST_CLOSED" });
    assertRuntimeViewEntry(this.runtime, entry);
    if (this.callers.has(requestId))
      throw new ElizaError(
        "A renderer request with this ID is already pending",
        {
          code: "VIEW_REQUEST_PENDING",
        },
      );
    if (binding.navigation) {
      const priorNavigations = [...this.callers].filter(
        ([, prior]) =>
          prior.navigation &&
          prior.clientId === clientId &&
          prior.ownerId === binding.ownerId,
      );
      // A claim has already authorized renderer execution. Reject another
      // preparation until it settles rather than revoke its acknowledgment or
      // allow two claimed destinations to commit out of order.
      if (priorNavigations.some(([, prior]) => prior.claimId))
        throw new ElizaError("A navigation is already being applied", {
          code: "VIEW_NAVIGATION_BUSY",
        });
      for (const [id] of priorNavigations)
        this.cancel(
          id,
          new ElizaError("Navigation was superseded", {
            code: "VIEW_NAVIGATION_SUPERSEDED",
          }),
        );
    }
    let markSettled = () => {};
    const caller: PendingCaller = {
      clientId,
      entry,
      ...binding,
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    };
    this.callers.set(requestId, caller);
    const detach = onNativeViewDisconnect(this.runtime, clientId, () =>
      this.cancel(
        requestId,
        new Error("Native renderer disconnected; outcome unknown"),
      ),
    );
    return this.pending.waitFor(requestId, timeoutMs).finally(() => {
      detach();
      clearTimeout(caller.lease);
      if (this.callers.get(requestId) === caller)
        this.callers.delete(requestId);
      markSettled();
    });
  }

  /**
   * Wait, at most `maxWaitMs`, until this renderer and owner hold no claimed
   * navigation. A claimed navigation ends by its result, cancellation, or its
   * claim lease, so this never waits on a lost claim for longer than the lease.
   * The caller still goes through waitFor, which refuses a claim that remains.
   */
  async navigationIdle(
    clientId: string,
    ownerId: string | undefined,
    maxWaitMs: number,
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const claimed = [...this.callers.values()].filter(
        (prior) =>
          prior.navigation &&
          prior.claimId &&
          prior.clientId === clientId &&
          prior.ownerId === ownerId,
      );
      const remaining = deadline - Date.now();
      if (this.closed || claimed.length === 0 || remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(claimed.map((prior) => prior.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /** One renderer may execute a delivered request, even across duplicate sockets. */
  claim(
    clientId: string,
    binding: ViewInteractionBinding,
    roles: RoleGateRole[],
    ownerId?: string,
  ): string | null {
    const caller = this.matchCaller(clientId, binding);
    if (
      !caller ||
      (caller.ownerId !== undefined && caller.ownerId !== ownerId) ||
      caller.claimId ||
      !satisfiesRoleGate(roles, caller.entry.roleGate)
    )
      return null;
    const claimId = randomUUID();
    caller.claimId = claimId;
    if (caller.navigation) {
      // The claim response can be lost after it is granted. Retire such a claim
      // as not delivered, never as delivered: the view state commits only on an
      // exact positive result, and a late result for it is no longer accepted.
      caller.lease = setTimeout(() => {
        if (
          this.callers.get(binding.requestId) !== caller ||
          caller.claimId !== claimId
        )
          return;
        this.cancel(
          binding.requestId,
          new ElizaError(
            "Navigation claim expired before the renderer settled it",
            {
              code: "VIEW_NAVIGATION_CLAIM_EXPIRED",
              context: {
                requestId: binding.requestId,
                leaseMs: NAVIGATION_CLAIM_LEASE_MS,
              },
              severity: "ephemeral",
            },
          ),
        );
      }, NAVIGATION_CLAIM_LEASE_MS);
      caller.lease.unref?.();
    }
    return claimId;
  }

  private matchCaller(
    clientId: string,
    binding: Partial<ViewInteractionBinding>,
  ) {
    const caller = binding.requestId
      ? this.callers.get(binding.requestId)
      : undefined;
    if (
      this.closed ||
      !caller ||
      caller.clientId !== clientId ||
      caller.entry.id !== binding.viewId ||
      caller.entry.viewType !== binding.viewType ||
      caller.entry.installationId !== binding.installationId
    )
      return null;
    try {
      assertRuntimeViewEntry(this.runtime, caller.entry);
    } catch (error) {
      // error-policy:J4 retired installations cannot claim work or settle replies.
      // The outcome remains unknown until cancellation or timeout; never replay.
      if (
        error instanceof ElizaError &&
        (error.code === "VIEW_INSTALLATION_INVALID" ||
          error.code === "VIEW_REGISTRY_CLOSED")
      )
        return null;
      throw error;
    }
    return caller;
  }

  resolve(
    clientId: string,
    result: RendererViewInteractResult,
    ownerId?: string,
  ): boolean {
    const caller = this.matchCaller(clientId, result);
    if (
      !caller?.claimId ||
      caller.claimId !== result.claimId ||
      (caller.ownerId !== undefined && caller.ownerId !== ownerId)
    )
      return false;
    if (caller.navigation) {
      const value = result.result;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !("switched" in value) ||
        value.switched !== result.success ||
        result.error !== undefined
      )
        return false;
    }
    this.pending.resolve(result.requestId, {
      requestId: result.requestId,
      success: result.success,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    return true;
  }

  cancel(requestId: string, reason: Error): void {
    clearTimeout(this.callers.get(requestId)?.lease);
    this.callers.delete(requestId);
    this.pending.reject(requestId, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSignal?.removeEventListener("abort", this.onRuntimeStop);
    for (const caller of this.callers.values()) clearTimeout(caller.lease);
    this.callers.clear();
    this.pending.rejectAll(
      new ElizaError("View host closed before the outcome was received", {
        code: "VIEW_HOST_CLOSED",
      }),
    );
  }
}

const hosts = new WeakMap<object, Map<IAgentRuntime, ViewInteractionHost>>();
const closedHosts = new WeakSet<object>();

/** The host key is its in-process server state, never a supplied ID. */
export function viewInteractionHost(
  runtime: IAgentRuntime,
  hostKey: object,
): ViewInteractionHost {
  if (closedHosts.has(hostKey) || runtime.getStopSignal?.().aborted)
    throw new ElizaError("View host is closed", { code: "VIEW_HOST_CLOSED" });
  let runtimes = hosts.get(hostKey);
  if (!runtimes) {
    runtimes = new Map();
    hosts.set(hostKey, runtimes);
  }
  let host = runtimes.get(runtime);
  if (!host) {
    host = new ViewInteractionHost(runtime);
    runtimes.set(runtime, host);
  }
  return host;
}

export function closeViewInteractionHost(hostKey: object): void {
  closedHosts.add(hostKey);
  for (const host of hosts.get(hostKey)?.values() ?? []) host.close();
  hosts.delete(hostKey);
  broadcasters.delete(hostKey);
}

const broadcasters = new WeakMap<
  object,
  {
    broadcast: ((payload: object) => void) | null;
    targeted: ((clientId: string, payload: object) => number) | null;
  }
>();
const requestHosts = new WeakMap<object, object>();

export function bindViewRequestHost(request: object, hostKey: object): void {
  requestHosts.set(request, hostKey);
}
export function getViewRequestBroadcast(
  request: object,
): ((payload: object) => void) | null {
  return getViewsBroadcastWs(requestHosts.get(request));
}
export function setViewsBroadcastWs(
  hostKey: object,
  broadcast: ((payload: object) => void) | null,
  targeted?: ((clientId: string, payload: object) => number) | null,
): void {
  if (closedHosts.has(hostKey)) return;
  broadcasters.set(hostKey, { broadcast, targeted: targeted ?? null });
}
export function getViewsBroadcastWs(
  hostKey: object | undefined,
): ((payload: object) => void) | null {
  return hostKey && !closedHosts.has(hostKey)
    ? (broadcasters.get(hostKey)?.broadcast ?? null)
    : null;
}
export function getViewsBroadcastWsToClientId(
  hostKey: object | undefined,
): ((clientId: string, payload: object) => number) | null {
  if (!hostKey || closedHosts.has(hostKey)) return null;
  const ws = broadcasters.get(hostKey)?.targeted;
  return (clientId, payload) => {
    // Native clients use this same host's runtime and the same claim/result map.
    // Never broadcast a targeted command onto the general event bus.
    for (const runtime of hosts.get(hostKey)?.keys() ?? []) {
      const sent = sendNativeViewFrame(runtime, hostKey, clientId, payload);
      if (sent) return sent;
    }
    return ws?.(clientId, payload) ?? 0;
  };
}
