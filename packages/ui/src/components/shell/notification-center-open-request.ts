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
  // Delivery is only an observation. The visible Home owns acknowledgement;
  // an inert/offscreen Home may still be mounted beside the Launcher and must
  // not make the request disappear before navigation commits.
  pendingRequestId = requestId;
  for (const listener of [...listeners]) listener(requestId);
  return requestId;
}

/** Reads the newest request without transferring destination ownership. */
export function peekNotificationCenterOpenRequest(): number | null {
  return pendingRequestId;
}

/** Clears a request only when the acknowledging visible Home still owns it. */
export function acknowledgeNotificationCenterOpenRequest(
  requestId: number,
): boolean {
  if (pendingRequestId !== requestId) return false;
  pendingRequestId = null;
  return true;
}

/** Delivers requests that arrive while a Home destination is mounted. */
export function subscribeNotificationCenterOpenRequests(
  listener: NotificationCenterOpenRequestListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
