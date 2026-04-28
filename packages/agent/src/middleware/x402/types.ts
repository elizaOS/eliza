/**
 * Strict TypeScript types for x402 payment middleware
 * Replaces all 'any' types with proper interfaces
 */

import type { AgentRuntime, RouteRequest } from "@elizaos/core";

/**
 * Request shape for x402 (matches plugin routes + IncomingMessage headers)
 */
export type X402Request = RouteRequest & {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
};

/**
 * Express-like response object
 */
export interface X402Response {
  status(code: number): X402ResponseStatus;
  json(data: unknown): void;
  setHeader?(name: string, value: string | readonly string[]): void;
  headersSent?: boolean;
}

export interface X402ResponseStatus {
  json(data: unknown): void;
}

/**
 * EIP-712 Authorization data structure
 */
export interface EIP712Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * EIP-712 Domain structure
 */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

// Export for use in payment-wrapper
export type {
  EIP712Authorization as EIP712AuthorizationType,
  EIP712Domain as EIP712DomainType,
};

/**
 * Payment proof data (EIP-712 format)
 */
export interface EIP712PaymentProof {
  signature: string;
  authorization: EIP712Authorization;
  domain?: EIP712Domain;
  network?: string;
  scheme?: string;
  // Alternative format with v, r, s
  v?: number;
  r?: string;
  s?: string;
  // Wrapped format from gateways
  payload?: {
    signature: string;
    authorization: EIP712Authorization;
  };
}

/**
 * Solana payment proof
 */
export interface SolanaPaymentProof {
  signature: string;
  network: "SOLANA";
}

/**
 * Legacy payment proof format
 */
export interface LegacyPaymentProof {
  network: string;
  address: string;
  signature: string;
}

/**
 * Runtime interface with required methods for x402
 * Uses IAgentRuntime directly to avoid type conflicts
 */
export type X402Runtime = AgentRuntime;

/**
 * Payment verification parameters (route price + allowed presets)
 */
export interface PaymentVerificationParams {
  paymentProof?: string;
  paymentId?: string;
  route: string;
  /** Integer USD cents (same as route `x402.priceInCents`) */
  priceInCents: number;
  /** Names from `x402.paymentConfigs` (resolved), in declaration order */
  paymentConfigNames: string[];
  agentId?: string;
  runtime: X402Runtime;
  req?: X402Request;
}

/** Successful verification metadata for events / receipts */
export interface PaymentVerifiedDetails {
  paymentConfig: string;
  network: string;
  /** Smallest units of the paid asset */
  amountAtomic: string;
  symbol?: string;
  payer?: string;
  proofId?: string;
  paymentResponse?: string;
}

export type VerifyPaymentResult =
  | { ok: false }
  | { ok: true; details: PaymentVerifiedDetails };

/**
 * Payment receipt for tracking
 */
export interface PaymentReceipt {
  paymentId: string;
  route: string;
  amount: string;
  network: string;
  timestamp: number;
  signature?: string;
  verified: boolean;
}

/**
 * Facilitator verification response
 */
export interface FacilitatorVerificationResponse {
  valid?: boolean;
  verified?: boolean;
  status?: string;
  message?: string;
  /** When present, must equal the route’s `resource` URL we sent on verify */
  resource?: string;
  /** When present, must match the plugin route path */
  routePath?: string;
  /** Alias some facilitators use for path */
  route?: string;
  /** When present, must match the route’s `priceInCents` */
  priceInCents?: number;
  /** When present, must be one of the route’s allowed preset names */
  paymentConfig?: string;
  /** When present, every entry must be in the route’s allowlist */
  paymentConfigs?: string[];
}

/** Sent to the facilitator so responses can be bound to a specific purchase */
export interface FacilitatorVerifyContext {
  resource: string;
  routePath: string;
  priceInCents: number;
  paymentConfigNames: string[];
}
