import type { JsonObject } from "./proto.js";

/**
 * Payment configuration definition for x402-enabled routes.
 */
export interface PaymentConfigDefinition {
  network: string;
  assetNamespace: string;
  assetReference: string;
  paymentAddress: string;
  symbol: string;
  chainId?: string;
}

/**
 * x402 configuration for a paid route.
 */
export interface X402Config {
  priceInCents: number;
  paymentConfigs?: string[];
}

/**
 * x402 "accepts" entry describing payment terms.
 */
export interface X402Accepts {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: JsonObject;
  extra?: JsonObject;
}

/**
 * x402 payment-required response payload.
 */
export interface X402Response {
  x402Version: number;
  error?: string;
  accepts?: X402Accepts[];
  payer?: string;
}
