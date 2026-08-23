/** UI-only projection for one exact resource cancellation identity. */

import type { BillingSnapshotResource } from "../data/billing-snapshot";

export type ActiveComputeCancellationViewState =
  | { kind: "submitting" }
  | { kind: "accepted"; receiptId: string }
  | { kind: "provider_confirmed"; receiptId: string }
  | { kind: "conflict"; receiptId?: string }
  | { kind: "terminal_attention"; receiptId: string }
  | { kind: "ambiguous" }
  | { kind: "receipt_unavailable"; receiptId: string }
  | { kind: "rejected" };

export function billingCancellationIdentityKey(
  resource: BillingSnapshotResource,
): string {
  const control = resource.cancellationControl;
  return `${resource.resourceType}:${resource.resourceId}:${control.expectedLifecycleRevision}`;
}
