/**
 * REQUEST_IDENTITY_VERIFICATION — atomic approval action.
 *
 * Persists a new approval request via the cloud-backed ApprovalRequestsClient
 * and returns the envelope (id, hosted url, challenge payload, eligible
 * delivery targets). Composes with DELIVER_APPROVAL_LINK and AWAIT_APPROVAL.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	APPROVAL_CHALLENGE_KINDS,
	APPROVAL_REQUESTS_CLIENT_SERVICE,
	APPROVAL_SIGNER_KINDS,
	type ApprovalChallengeKind,
	type ApprovalChallengePayload,
	type ApprovalRequestsClient,
	type ApprovalSignerKind,
	type CreateApprovalRequestInput,
	eligibleApprovalDeliveryTargets,
} from "../types.ts";

const VALID_CHALLENGE_KINDS: ReadonlySet<ApprovalChallengeKind> = new Set(
	APPROVAL_CHALLENGE_KINDS,
);
const VALID_SIGNER_KINDS: ReadonlySet<ApprovalSignerKind> = new Set(
	APPROVAL_SIGNER_KINDS,
);

interface RequestIdentityVerificationParams {
	challengeKind?: unknown;
	challengePayload?: unknown;
	expectedSignerIdentityId?: unknown;
	expiresInMs?: unknown;
	metadata?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): RequestIdentityVerificationParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as RequestIdentityVerificationParams;
	}
	return options as RequestIdentityVerificationParams;
}

function parseChallengePayload(raw: unknown): ApprovalChallengePayload | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const message = obj.message;
	if (typeof message !== "string" || message.trim().length === 0) return null;

	const payload: ApprovalChallengePayload = { message };
	const signerKind = obj.signerKind;
	if (typeof signerKind === "string") {
		if (!VALID_SIGNER_KINDS.has(signerKind as ApprovalSignerKind)) return null;
		payload.signerKind = signerKind as ApprovalSignerKind;
	}
	if (typeof obj.walletAddress === "string" && obj.walletAddress.length > 0) {
		payload.walletAddress = obj.walletAddress;
	}
	if (typeof obj.publicKey === "string" && obj.publicKey.length > 0) {
		payload.publicKey = obj.publicKey;
	}
	if (payload.signerKind === "wallet" && !payload.walletAddress) return null;
	if (payload.signerKind === "ed25519" && !payload.publicKey) return null;
	if (
		obj.context &&
		typeof obj.context === "object" &&
		!Array.isArray(obj.context)
	) {
		payload.context = obj.context as Record<string, unknown>;
	}
	return payload;
}

function buildInput(
	params: RequestIdentityVerificationParams,
): { input: CreateApprovalRequestInput } | { error: string } {
	const challengeKind = params.challengeKind;
	if (
		typeof challengeKind !== "string" ||
		!VALID_CHALLENGE_KINDS.has(challengeKind as ApprovalChallengeKind)
	) {
		return { error: "Invalid or missing challengeKind" };
	}
	const challengePayload = parseChallengePayload(params.challengePayload);
	if (!challengePayload) {
		return { error: "Invalid or missing challengePayload" };
	}

	const input: CreateApprovalRequestInput = {
		challengeKind: challengeKind as ApprovalChallengeKind,
		challengePayload,
	};
	if (
		typeof params.expectedSignerIdentityId === "string" &&
		params.expectedSignerIdentityId.length > 0
	) {
		input.expectedSignerIdentityId = params.expectedSignerIdentityId;
	}
	if (typeof params.expiresInMs === "number" && params.expiresInMs > 0) {
		input.expiresInMs = params.expiresInMs;
	}
	if (
		params.metadata &&
		typeof params.metadata === "object" &&
		!Array.isArray(params.metadata)
	) {
		input.metadata = params.metadata as Record<string, unknown>;
	}
	return { input };
}

export const requestIdentityVerificationAction: Action = {
	name: "REQUEST_IDENTITY_VERIFICATION",
	suppressPostActionContinuation: true,
	similes: [
		"NEW_APPROVAL_REQUEST",
		"OPEN_APPROVAL_REQUEST",
		"START_IDENTITY_VERIFICATION",
		"REQUEST_LOGIN_APPROVAL",
	],
	description:
		"Create a new approval request (login, signature, or generic) bound to an expected signer.",
	descriptionCompressed:
		"Create approval request: challengeKind, challengePayload.message + signerKind.",
	parameters: [
		{
			name: "challengeKind",
			description: "Approval challenge kind: login, signature, generic.",
			required: true,
			schema: { type: "string" as const, enum: [...APPROVAL_CHALLENGE_KINDS] },
		},
		{
			name: "challengePayload",
			description:
				"Challenge payload. Must include message; signerKind/walletAddress/publicKey when signing is expected.",
			required: true,
			schema: {
				type: "object" as const,
				properties: {
					message: { type: "string" as const },
					signerKind: {
						type: "string" as const,
						enum: [...APPROVAL_SIGNER_KINDS],
					},
					walletAddress: { type: "string" as const },
					publicKey: { type: "string" as const },
					context: { type: "object" as const },
				},
				required: ["message"],
			},
		},
		{
			name: "expectedSignerIdentityId",
			description:
				"Optional identity id the signer must match (e.g. wallet address, ed25519:<pk>).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "expiresInMs",
			description: "TTL override in milliseconds. Defaults to 600000.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "metadata",
			description: "Arbitrary JSON metadata stored alongside the request.",
			required: false,
			schema: { type: "object" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const built = buildInput(readParams(options));
		return (
			runtime.getService(APPROVAL_REQUESTS_CLIENT_SERVICE) !== null &&
			"input" in built
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const client = runtime.getService(
			APPROVAL_REQUESTS_CLIENT_SERVICE,
		) as unknown as ApprovalRequestsClient | null;
		if (!client) {
			return {
				success: false,
				text: "ApprovalRequestsClient not available",
				data: { actionName: "REQUEST_IDENTITY_VERIFICATION" },
			};
		}
		const built = buildInput(params);
		if ("error" in built) {
			logger.warn(
				`[REQUEST_IDENTITY_VERIFICATION] invalid params: ${built.error}`,
			);
			return {
				success: false,
				text: built.error,
				data: { actionName: "REQUEST_IDENTITY_VERIFICATION" },
			};
		}

		const envelope = await client.create(built.input);
		const eligibleDeliveryTargets = eligibleApprovalDeliveryTargets(
			Boolean(envelope.expectedSignerIdentityId),
		);

		logger.info(
			`[REQUEST_IDENTITY_VERIFICATION] approvalRequestId=${envelope.approvalRequestId} kind=${envelope.challengeKind}`,
		);

		const text = `Created approval request ${envelope.approvalRequestId} (${envelope.challengeKind}).`;
		if (callback) {
			await callback({ text, action: "REQUEST_IDENTITY_VERIFICATION" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "REQUEST_IDENTITY_VERIFICATION",
				approvalRequestId: envelope.approvalRequestId,
				hostedUrl: envelope.hostedUrl,
				expiresAt: envelope.expiresAt,
				challengeKind: envelope.challengeKind,
				expectedSignerIdentityId: envelope.expectedSignerIdentityId,
				eligibleDeliveryTargets,
			},
		};
	},

	examples: [],
};
