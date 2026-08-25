/**
 * Retains notification-center intent across native boot and shell navigation.
 * Delivery is observational; only the visible notification center may
 * acknowledge the newest monotonic request after it has actually opened.
 */

export type NotificationCenterOpenRequestListener = (requestId: number) => void;

let nextRequestId = 1;
let pendingRequestId: number | null = null;
const listeners = new Set<NotificationCenterOpenRequestListener>();

/** Records a new request and returns its monotonic identity. */
export function requestNotificationCenterOpen(): number {
  const requestId = nextRequestId;
  nextRequestId += 1;
  pendingRequestId = requestId;
  for (const listener of [...listeners]) listener(requestId);
  return requestId;
}

/** Reads the newest request without transferring destination ownership. */
export function peekNotificationCenterOpenRequest(): number | null {
  return pendingRequestId;
}

/** Clears a request only when the visible destination still owns it. */
export function acknowledgeNotificationCenterOpenRequest(
  requestId: number,
): boolean {
  if (pendingRequestId !== requestId) return false;
  pendingRequestId = null;
  return true;
}

/** Delivers requests that arrive while a destination is mounted. */
export function subscribeNotificationCenterOpenRequests(
  listener: NotificationCenterOpenRequestListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
