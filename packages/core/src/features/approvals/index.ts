/**
 * Approvals — atomic action slice.
 *
 * Re-exports the five atomic approval actions, the plugin scaffold, and the
 * runtime contract types (`ApprovalRequestsClient`, `ApprovalCallbackBusClient`,
 * `IdentityVerificationGatekeeperClient`, envelope/result shapes, service
 * name constants).
 */

export {
	awaitApprovalAction,
	bindIdentityToSessionAction,
	deliverApprovalLinkAction,
	requestIdentityVerificationAction,
	verifyApprovalSignatureAction,
} from "./actions/index.ts";

export { approvalsPlugin, approvalsPlugin as default } from "./plugin.ts";
export type {
	ApprovalCallbackBusClient,
	ApprovalCallbackResult,
	ApprovalChallengeKind,
	ApprovalChallengePayload,
	ApprovalRequestEnvelope,
	ApprovalRequestStatus,
	ApprovalRequestsClient,
	ApprovalSignatureVerification,
	ApprovalSignerKind,
	CreateApprovalRequestInput,
	IdentityVerificationGatekeeperClient,
} from "./types.ts";
export {
	APPROVAL_CALLBACK_BUS_CLIENT_SERVICE,
	APPROVAL_CHALLENGE_KINDS,
	APPROVAL_REQUESTS_CLIENT_SERVICE,
	APPROVAL_SIGNER_KINDS,
	eligibleApprovalDeliveryTargets,
	IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
} from "./types.ts";
