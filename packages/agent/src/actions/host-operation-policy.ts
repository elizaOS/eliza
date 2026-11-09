/**
 * Host operation policy: a product host (for example a phone that ships its
 * own Settings screen and owns inference) sets
 * `ELIZA_HOST_OPERATION_POLICY=product` so chat actions refuse the writes
 * that host manages itself. Unset means the default agent behaviour.
 */

export type HostOperationPolicy = "product";

/** Read on every call so a host or test can change it without a restart. */
export function hostOperationPolicy(): HostOperationPolicy | undefined {
  const raw = process.env.ELIZA_HOST_OPERATION_POLICY?.trim().toLowerCase();
  return raw === "product" ? "product" : undefined;
}

/** The host owns provider, backend and account choices; chat must not change them. */
export function isHostManagedInference(): boolean {
  return hostOperationPolicy() === "product";
}
