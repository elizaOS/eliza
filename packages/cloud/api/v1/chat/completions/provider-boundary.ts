/**
 * The last gateway step before a chat-completions provider call.
 *
 * Paid requests require a durable dispatch acknowledgement before the provider.
 * Cancellation is checked on both sides of that acknowledgement; a refusal
 * prevents provider invocation and settles the reservation at zero.
 */

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
  /** Commits the admission with dispatch, when the admission has such a step. */
  commit?: () => Promise<void>;
}): () => Promise<void> {
  return async () => {
    if (params.signal.aborted) throw new ClientClosedBeforeDispatchError();
    await params.commit?.();
    // The commit can be a network round trip; the caller may have left during it.
    if (params.signal.aborted) throw new ClientClosedBeforeDispatchError();
  };
}
