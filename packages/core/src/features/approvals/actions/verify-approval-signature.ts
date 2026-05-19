/**
 * VERIFY_APPROVAL_SIGNATURE — atomic approval action.
 *
 * Validates a submitted signature against the persisted challenge for an
 * approval request via the IdentityVerificationGatekeeper. Returns the
 * recovered signer identity on success; otherwise an error string.
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
	IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
	type IdentityVerificationGatekeeperClient,
} from "../types.ts";

interface VerifyApprovalSignatureParams {
	approvalRequestId?: unknown;
	signature?: unknown;
	expectedSignerIdentityId?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): VerifyApprovalSignatureParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as VerifyApprovalSignatureParams;
	}
	return options as VerifyApprovalSignatureParams;
}

export const verifyApprovalSignatureAction: Action = {
	name: "VERIFY_APPROVAL_SIGNATURE",
	suppressPostActionContinuation: true,
	similes: ["VERIFY_APPROVAL_PROOF", "CHECK_APPROVAL_SIGNATURE"],
	description:
		"Verify a submitted signature against the challenge for an approval request.",
	descriptionCompressed: "Verify approval signature.",
	parameters: [
		{
			name: "approvalRequestId",
			description: "ID of the approval request being verified.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "signature",
			description: "Signature text submitted by the signer.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "expectedSignerIdentityId",
			description:
				"Optional override for the expected signer identity (otherwise read from the request).",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const params = readParams(options);
		return (
			runtime.getService(IDENTITY_VERIFICATION_GATEKEEPER_SERVICE) !== null &&
			typeof params.approvalRequestId === "string" &&
			params.approvalRequestId.length > 0 &&
			typeof params.signature === "string" &&
			params.signature.length > 0
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
		const gatekeeper = runtime.getService(
			IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
		) as unknown as IdentityVerificationGatekeeperClient | null;
		if (!gatekeeper) {
			return {
				success: false,
				text: "IdentityVerificationGatekeeper not available",
				data: { actionName: "VERIFY_APPROVAL_SIGNATURE" },
			};
		}
		const approvalRequestId =
			typeof params.approvalRequestId === "string"
				? params.approvalRequestId
				: "";
		const signature =
			typeof params.signature === "string" ? params.signature : "";
		if (!approvalRequestId || !signature) {
			return {
				success: false,
				text: "Missing required parameters: approvalRequestId, signature",
				data: { actionName: "VERIFY_APPROVAL_SIGNATURE" },
			};
		}

		const expectedSignerIdentityId =
			typeof params.expectedSignerIdentityId === "string" &&
			params.expectedSignerIdentityId.length > 0
				? params.expectedSignerIdentityId
				: undefined;

		const verification = await gatekeeper.verify({
			approvalId: approvalRequestId,
			signature,
			expectedSignerIdentityId,
		});

		logger.info(
			`[VERIFY_APPROVAL_SIGNATURE] approvalRequestId=${approvalRequestId} valid=${verification.valid}`,
		);

		const text = verification.valid
			? `Signature for approval ${approvalRequestId} is valid.`
			: `Signature for approval ${approvalRequestId} is invalid${verification.error ? `: ${verification.error}` : ""}.`;
		if (callback) {
			await callback({ text, action: "VERIFY_APPROVAL_SIGNATURE" });
		}

		return {
			success: verification.valid,
			text,
			data: {
				actionName: "VERIFY_APPROVAL_SIGNATURE",
				approvalRequestId,
				valid: verification.valid,
				signerIdentityId: verification.signerIdentityId,
				error: verification.error,
			},
		};
	},

	examples: [],
};
