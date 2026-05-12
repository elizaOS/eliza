/**
 * Payment-action types for the consolidated PAYMENT action.
 *
 * These types describe the runtime contract between the PAYMENT action
 * subactions and the cloud services that own persistence
 * (`PaymentRequestsClient`) and callback settlement (`PaymentBusClient`).
 *
 * The actions never import the cloud module directly — they resolve the
 * client implementations via `runtime.getService(name)`. Sibling Wave B
 * worktrees provide the concrete adapters; this slice only defines the shape.
 */

import type { DeliveryTarget } from "../../sensitive-requests/dispatch-registry.ts";

export type PaymentProvider = "stripe" | "oxapay" | "x402" | "wallet_native";

export type PaymentRequestStatus =
	| "pending"
	| "delivered"
	| "settled"
	| "failed"
	| "expired"
	| "canceled";

export type PaymentContextKind =
	| "any_payer"
	| "verified_payer"
	| "specific_payer";

export interface PaymentContext {
	kind: PaymentContextKind;
	scope?: "owner" | "owner_or_linked_identity";
	payerIdentityId?: string;
}

export interface PaymentRequestEnvelope {
	paymentRequestId: string;
	provider: PaymentProvider;
	amountCents: number;
	currency: string;
	paymentContext: PaymentContext;
	hostedUrl?: string;
	/** epoch ms */
	expiresAt: number;
	status: PaymentRequestStatus;
	reason?: string;
}

export interface PaymentSettlementResult {
	paymentRequestId: string;
	status: "settled" | "failed" | "expired";
	txRef?: string;
	payerIdentityId?: string;
	amountCents?: number;
	error?: string;
	/** epoch ms */
	settledAt?: number;
}

export interface CreatePaymentRequestInput {
	provider: PaymentProvider;
	amountCents: number;
	currency?: string;
	paymentContext: PaymentContext;
	reason?: string;
	expiresInMs?: number;
	callbackUrl?: string;
	metadata?: Record<string, unknown>;
}

export interface PaymentProofVerification {
	valid: boolean;
	error?: string;
	payerIdentity?: string;
}

/**
 * Cloud-backed CRUD client for payment requests. Resolved via
 * `runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE)`.
 */
export interface PaymentRequestsClient {
	create(input: CreatePaymentRequestInput): Promise<PaymentRequestEnvelope>;
	get(paymentRequestId: string): Promise<PaymentRequestEnvelope | null>;
	cancel(
		paymentRequestId: string,
		reason?: string,
	): Promise<PaymentRequestEnvelope>;
}

/**
 * Cloud-backed callback bus client. Resolved via
 * `runtime.getService(PAYMENT_BUS_CLIENT_SERVICE)`.
 */
export interface PaymentBusClient {
	waitFor(
		paymentRequestId: string,
		timeoutMs: number,
	): Promise<PaymentSettlementResult>;
	verifyProof(
		paymentRequestId: string,
		proof: unknown,
	): Promise<PaymentProofVerification>;
}

/**
 * Optional explicit settler used by PAYMENT action `settle` for non-webhook
 * providers (e.g. `wallet_native`). Resolved via
 * `runtime.getService(PAYMENT_SETTLER_SERVICE)`.
 */
export interface PaymentSettler {
	settle(input: {
		paymentRequestId: string;
		proof?: unknown;
		strategy?: string;
	}): Promise<PaymentSettlementResult>;
}

// Service name constants — used by every action's `runtime.getService(...)`
// call so the payment cloud adapters can register themselves under stable
// keys.
export const PAYMENT_REQUESTS_CLIENT_SERVICE = "PaymentRequestsClient";
export const PAYMENT_BUS_CLIENT_SERVICE = "PaymentBusClient";
export const PAYMENT_SETTLER_SERVICE = "PaymentSettler";

/**
 * Computed by PAYMENT action `create_request` from `paymentContext.kind`. Mirrors
 * the contract documented in the Wave B spec: public-link delivery is only
 * eligible for `any_payer`; everything else must use an authenticated route.
 */
export function eligibleDeliveryTargetsFor(
	kind: PaymentContextKind,
): DeliveryTarget[] {
	if (kind === "any_payer") {
		return [
			"public_link",
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		];
	}
	return [
		"dm",
		"owner_app_inline",
		"cloud_authenticated_link",
		"tunnel_authenticated_link",
	];
}
