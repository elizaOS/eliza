/**
 * Strict TypeScript types for x402 payment middleware
 * Replaces all 'any' types with proper interfaces
 */

import type { IAgentRuntime } from '@elizaos/core';

/**
 * Express-like request object
 */
export interface X402Request {
    path: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string | string[] | undefined>;
    body?: unknown;
    params: Record<string, string>;
}

/**
 * Express-like response object
 */
export interface X402Response {
    status(code: number): X402ResponseStatus;
    json(data: unknown): void;
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
export type { EIP712Authorization as EIP712AuthorizationType };
export type { EIP712Domain as EIP712DomainType };

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
    network: 'SOLANA';
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
export type X402Runtime = IAgentRuntime;

/**
 * Payment verification parameters
 */
export interface PaymentVerificationParams {
    paymentProof?: string;
    paymentId?: string;
    route: string;
    expectedAmount: string;
    runtime: X402Runtime;
    req?: X402Request;
}

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
}

