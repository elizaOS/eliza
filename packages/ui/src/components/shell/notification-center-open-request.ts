/**
 * Carries notification-center intent across the shell-to-Home mount boundary.
 * A mounted Home receives requests synchronously; otherwise only the newest
 * request is retained until that destination commits and consumes it once.
 */

export type NotificationCenterOpenRequestListener = (requestId: number) => void;

let nextRequestId = 1;
let pendingRequestId: number | null = null;
const listeners = new Set<NotificationCenterOpenRequestListener>();

/** Records a new request and returns its monotonic identity. */
export function requestNotificationCenterOpen(): number {
  const requestId = nextRequestId;
  nextRequestId += 1;

  if (listeners.size === 0) {
    pendingRequestId = requestId;
    return requestId;
  }

  pendingRequestId = null;
  for (const listener of [...listeners]) listener(requestId);
  return requestId;
}

/** Takes the request retained while no Home destination was mounted. */
export function consumeNotificationCenterOpenRequest(): number | null {
  const requestId = pendingRequestId;
  pendingRequestId = null;
  return requestId;
}

/** Delivers requests that arrive while a Home destination is mounted. */
export function subscribeNotificationCenterOpenRequests(
  listener: NotificationCenterOpenRequestListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
