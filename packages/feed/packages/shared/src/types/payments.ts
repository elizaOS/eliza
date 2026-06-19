/**
 * Payment Type Definitions
 *
 * Complete interfaces for x402 micropayment system
 */

import type { JsonValue } from "./common";

/**
 * Payment request creation parameters
 */
export interface PaymentRequestParams {
  from: string;
  to: string;
  amount: string; // in wei
  service: string;
  metadata?: Record<string, JsonValue>;
}

/**
 * Payment request result from creation
 */
export interface PaymentRequestCreateResult {
  requestId: string;
  amount: string;
  expiresAt: number;
}

/**
 * Payment verification parameters
 */
export interface PaymentVerificationParams {
  requestId: string;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  timestamp: number;
  confirmed: boolean;
}

/**
 * Payment verification result
 */
export interface PaymentVerificationResult {
  verified: boolean;
  error?: string;
}

/**
 * Payment status information
 */
export interface PaymentStatus {
  requestId: string;
  status: "pending" | "verified" | "expired" | "failed";
  amount: string;
  from: string;
  to: string;
  createdAt: number;
  expiresAt: number;
  verifiedAt?: number;
  txHash?: string;
}

/**
 * Payment receipt information
 */
export interface PaymentReceiptInfo {
  requestId: string;
  txHash: string;
  verified: boolean;
  verifiedAt?: number;
  error?: string;
}
