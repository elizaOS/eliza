/** Keeps purchased-credit route fixtures on the real funding selector with a per-test non-subscriber repository seam. */

import { spyOn } from "bun:test";
import { subscriptionEntitlementsRepository } from "@/db/repositories/subscription-entitlements";

/** Install the repository lookup spy for one test and return its restore hook. */
export function mockNonSubscriberEntitlementLookup(): () => void {
  const entitlementLookup = spyOn(
    subscriptionEntitlementsRepository,
    "find",
  ).mockResolvedValue(undefined);

  return () => {
    entitlementLookup.mockRestore();
  };
}
