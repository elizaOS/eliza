/** Reply correlation belongs to one runtime, HTTP host, and authenticated client. */
import { randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type RoleGateRole,
  satisfiesRoleGate,
} from "@elizaos/core";
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

export class ViewInteractionHost {
  private closed = false;
  private readonly pending = new PendingRequestMap();
  private readonly callers = new Map<
    string,
    { clientId: string; entry: ViewRegistryEntry; claimId?: string }
  >();

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
  ): Promise<ViewInteractResult> {
    if (this.closed)
      throw new ElizaError("View host is closed", { code: "VIEW_HOST_CLOSED" });
    assertRuntimeViewEntry(this.runtime, entry);
    const caller = { clientId, entry };
    this.callers.set(requestId, caller);
    return this.pending.waitFor(requestId, timeoutMs).finally(() => {
      if (this.callers.get(requestId) === caller)
        this.callers.delete(requestId);
    });
  }

  /** One renderer may execute a delivered request, even across duplicate sockets. */
  claim(
    clientId: string,
    binding: ViewInteractionBinding,
    roles: RoleGateRole[],
  ): string | null {
    const caller = this.matchCaller(clientId, binding);
    if (
      !caller ||
      caller.claimId ||
      !satisfiesRoleGate(roles, caller.entry.roleGate)
    )
      return null;
    caller.claimId = randomUUID();
    return caller.claimId;
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

  resolve(clientId: string, result: RendererViewInteractResult): void {
    const caller = this.matchCaller(clientId, result);
    if (!caller?.claimId || caller.claimId !== result.claimId) return;
    this.pending.resolve(result.requestId, {
      requestId: result.requestId,
      success: result.success,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

  cancel(requestId: string, reason: Error): void {
    this.callers.delete(requestId);
    this.pending.reject(requestId, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSignal?.removeEventListener("abort", this.onRuntimeStop);
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
  return hostKey && !closedHosts.has(hostKey)
    ? (broadcasters.get(hostKey)?.targeted ?? null)
    : null;
}
