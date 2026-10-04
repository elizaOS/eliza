/** Shared monotonic deadline for the read-only provider portion of one recovery attempt. */
import { ElizaError } from "@elizaos/core";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
export function createOrganizationUpgradeReadBudget(
  milliseconds = 20_000,
  clock: () => number = () => performance.now(),
) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 20_000)
    throw new ElizaError("Upgrade recovery read budget is invalid", {
      code: "SUBSCRIPTION_UPGRADE_RECOVERY_BUDGET_INVALID",
    });
  const start = clock();
  if (!Number.isFinite(start))
    throw new ElizaError("Upgrade recovery clock is unavailable", {
      code: "SUBSCRIPTION_UPGRADE_RECOVERY_DEADLINE",
    });
  const deadline = start + milliseconds;
  const remainingMs = () => {
    const now = clock();
    const remaining = Math.floor(deadline - now);
    if (!Number.isFinite(now) || now < start || remaining < 1)
      throw new ElizaError("Upgrade recovery provider read deadline elapsed", {
        code: "SUBSCRIPTION_UPGRADE_RECOVERY_DEADLINE",
      });
    return remaining;
  };
  return {
    remainingMs,
    requestOptions: () =>
      ({
        apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
        timeout: Math.min(10_000, remainingMs()),
        maxNetworkRetries: 0,
      }) as const,
  };
}
export type OrganizationUpgradeReadBudget = ReturnType<typeof createOrganizationUpgradeReadBudget>;
