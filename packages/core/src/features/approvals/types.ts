/**
 * Approvals atomic action types (Wave D).
 *
 * These types describe the runtime contract between the per-action approval
 * handlers (REQUEST_IDENTITY_VERIFICATION, DELIVER_APPROVAL_LINK,
 * AWAIT_APPROVAL, VERIFY_APPROVAL_SIGNATURE, BIND_IDENTITY_TO_SESSION) and the
 * cloud services that own persistence (`ApprovalRequestsClient`), callback
 * wakeups (`ApprovalCallbackBusClient`), and signature verification +
 * session-binding (`IdentityVerificationGatekeeperClient`).
 *
 * The actions never import the cloud module directly — they resolve the
 * client implementations via `runtime.getService(name)`.
 */

import type { DeliveryTarget } from "../../sensitive-requests/dispatch-registry.ts";

export type ApprovalChallengeKind = "login" | "signature" | "generic";

export const APPROVAL_CHALLENGE_KINDS: readonly ApprovalChallengeKind[] = [
	"login",
	"signature",
	"generic",
] as const;

export type ApprovalSignerKind = "wallet" | "ed25519";

export const APPROVAL_SIGNER_KINDS: readonly ApprovalSignerKind[] = [
	"wallet",
	"ed25519",
] as const;

export type ApprovalRequestStatus =
	| "pending"
	| "delivered"
	| "approved"
	| "denied"
	| "expired"
	| "canceled";

export interface ApprovalChallengePayload {
	message: string;
	signerKind?: ApprovalSignerKind;
	/** For wallet (SIWE): expected EIP-55 checksummed address. */
	walletAddress?: string;
	/** For ed25519: base64 / hex encoded public key. */
	publicKey?: string;
	context?: Record<string, unknown>;
}

export interface ApprovalRequestEnvelope {
	approvalRequestId: string;
	challengeKind: ApprovalChallengeKind;
	challengePayload: ApprovalChallengePayload;
	expectedSignerIdentityId?: string;
	hostedUrl?: string;
	/** epoch ms */
	expiresAt: number;
	status: ApprovalRequestStatus;
}

export interface ApprovalCallbackResult {
	approvalRequestId: string;
	status: "approved" | "denied" | "expired" | "canceled";
	signerIdentityId?: string;
	signatureText?: string;
	error?: string;
	/** epoch ms */
	receivedAt?: number;
}

export interface ApprovalSignatureVerification {
	valid: boolean;
	signerIdentityId?: string;
	error?: string;
}

export interface CreateApprovalRequestInput {
	challengeKind: ApprovalChallengeKind;
	challengePayload: ApprovalChallengePayload;
	expectedSignerIdentityId?: string;
	expiresInMs?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Cloud-backed CRUD client for approval requests. Resolved via
 * `runtime.getService(APPROVAL_REQUESTS_CLIENT_SERVICE)`.
 */
export interface ApprovalRequestsClient {
	create(input: CreateApprovalRequestInput): Promise<ApprovalRequestEnvelope>;
	get(approvalRequestId: string): Promise<ApprovalRequestEnvelope | null>;
	cancel(
		approvalRequestId: string,
		reason?: string,
	): Promise<ApprovalRequestEnvelope>;
}

/**
 * Cloud-backed callback bus client. Resolved via
 * `runtime.getService(APPROVAL_CALLBACK_BUS_CLIENT_SERVICE)`.
 */
export interface ApprovalCallbackBusClient {
	waitFor(
		approvalRequestId: string,
		timeoutMs: number,
	): Promise<ApprovalCallbackResult>;
}

/**
 * Cloud-backed identity-verification gatekeeper. Resolved via
 * `runtime.getService(IDENTITY_VERIFICATION_GATEKEEPER_SERVICE)`.
 */
export interface IdentityVerificationGatekeeperClient {
	verify(input: {
		approvalId: string;
		signature: string;
		expectedSignerIdentityId?: string;
	}): Promise<ApprovalSignatureVerification>;
	bindIdentityToSession(input: {
		sessionId: string;
		identityId: string;
	}): Promise<void>;
}

// Service name constants — used by every action's `runtime.getService(...)`
// call so the approvals cloud adapters can register themselves under stable
// keys.
export const APPROVAL_REQUESTS_CLIENT_SERVICE = "ApprovalRequestsClient";
export const APPROVAL_CALLBACK_BUS_CLIENT_SERVICE = "ApprovalCallbackBusClient";
export const IDENTITY_VERIFICATION_GATEKEEPER_SERVICE =
	"IdentityVerificationGatekeeper";

/**
 * Eligible delivery targets for an approval link. Approvals always require an
 * authenticated channel back to the expected signer; public_link is only
 * eligible when no expected signer is bound (generic approval).
 */
export function eligibleApprovalDeliveryTargets(
	hasExpectedSigner: boolean,
): DeliveryTarget[] {
	if (hasExpectedSigner) {
		return [
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
		"public_link",
	];
}
