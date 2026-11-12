/**
 * The last gateway step before a chat-completions provider call.
 *
 * Organization-funded requests were already admitted from their cached auth
 * entry, so nothing is awaited here for them. App-funded requests still commit
 * their admission with dispatch. The provider is invoked only while the caller
 * is still connected; a refusal is thrown before the provider call and the
 * route settles the reservation at zero for it.
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
