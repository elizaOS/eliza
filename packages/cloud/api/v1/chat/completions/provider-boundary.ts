/**
 * The last gateway step before a chat-completions provider call.
 *
 * The organization rate verdict was started after authentication and the
 * lease commit starts here, so both Durable Object decisions overlap and cost
 * one round trip of wall time. The provider is invoked only when both allow
 * and the caller is still connected. Every refusal is thrown before the
 * provider call; the route settles the reservation at zero for it.
 */

/** The organization rate verdict refused the request at the provider boundary. */
export class OrgRateLimitedBeforeDispatchError extends Error {
  constructor(readonly response: Response) {
    super("Organization rate limit refused provider dispatch");
    this.name = "OrgRateLimitedBeforeDispatchError";
  }
}

/** The caller disconnected before the provider was invoked; nothing is owed. */
export class ClientClosedBeforeDispatchError extends Error {
  constructor() {
    super("Client closed the request before provider dispatch");
    this.name = "ClientClosedBeforeDispatchError";
  }
}

export function joinProviderBoundary(params: {
  /** The caller's request signal. */
  signal: AbortSignal;
  /** Resolves the rate decision already in flight; a Response is the denial. */
  rateVerdict?: () => Promise<Response | null>;
  /** Commits the admission lease with dispatch, when the admission has one. */
  commit?: () => Promise<void>;
  onRateDenied?: () => void;
}): () => Promise<void> {
  return async () => {
    if (params.signal.aborted) throw new ClientClosedBeforeDispatchError();
    const [rateVerdict, commit] = await Promise.allSettled([
      params.rateVerdict?.() ?? null,
      params.commit?.(),
    ]);
    // A rate denial keeps its precedence over a balance or standing refusal.
    if (rateVerdict.status === "rejected") throw rateVerdict.reason;
    if (rateVerdict.value) {
      params.onRateDenied?.();
      throw new OrgRateLimitedBeforeDispatchError(rateVerdict.value);
    }
    if (commit.status === "rejected") throw commit.reason;
    // The commit is a network round trip; the caller may have left during it.
    if (params.signal.aborted) throw new ClientClosedBeforeDispatchError();
  };
}
