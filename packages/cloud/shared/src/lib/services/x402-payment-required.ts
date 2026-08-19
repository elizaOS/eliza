/**
 * Constructs x402 v2 payment-required envelopes while retaining the legacy
 * resource fields used by dual-version payment clients.
 */

export interface X402ResourceFields {
  resource: string;
  description: string;
  mimeType: string;
}

export function buildX402PaymentRequired<TRequirements extends X402ResourceFields, TExtensions>(
  requirements: TRequirements,
  extensions?: TExtensions,
) {
  return {
    x402Version: 2 as const,
    error: "payment_required" as const,
    resource: {
      url: requirements.resource,
      description: requirements.description,
      mimeType: requirements.mimeType,
    },
    accepts: [requirements],
    ...(extensions !== undefined && { extensions }),
  };
}
