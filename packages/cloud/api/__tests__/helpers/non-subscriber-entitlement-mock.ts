/** Keeps focused route tests on purchased-credit billing without querying subscription state. */

import { mock } from "bun:test";
import * as entitlementRepositoryActual from "@/db/repositories/subscription-entitlements";

/** Install the non-subscriber entitlement seam and return its module restore hook. */
export function mockNonSubscriberEntitlementLookup(): () => void {
  mock.module("@/db/repositories/subscription-entitlements", () => ({
    ...entitlementRepositoryActual,
    subscriptionEntitlementsRepository: new Proxy(
      entitlementRepositoryActual.subscriptionEntitlementsRepository,
      {
        get: (target, property, receiver) =>
          property === "find"
            ? async () => undefined
            : Reflect.get(target, property, receiver),
      },
    ),
  }));

  return () => {
    mock.module(
      "@/db/repositories/subscription-entitlements",
      () => entitlementRepositoryActual,
    );
  };
}
