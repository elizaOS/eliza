/**
 * Proves subscription enrollment metadata derives its auth and billing terms
 * from the canonical linked-provider descriptor contract.
 */

import {
  codingProviderSubscriptionAuthMode,
  codingProviderSubscriptionBillingMode,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_METADATA,
} from "./types.js";

describe("subscription provider metadata", () => {
  it("matches canonical auth and billing truth for every subscription", () => {
    for (const providerId of SUBSCRIPTION_PROVIDER_IDS) {
      expect(SUBSCRIPTION_PROVIDER_METADATA[providerId]).toMatchObject({
        providerId,
        authMode: codingProviderSubscriptionAuthMode(providerId),
        billingMode: codingProviderSubscriptionBillingMode(providerId),
      });
    }
  });
});
