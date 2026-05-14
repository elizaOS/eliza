/**
 * Approvals atomic capability slice (Wave D).
 *
 * Registers the five atomic approval actions:
 *   REQUEST_IDENTITY_VERIFICATION, DELIVER_APPROVAL_LINK, AWAIT_APPROVAL,
 *   VERIFY_APPROVAL_SIGNATURE, BIND_IDENTITY_TO_SESSION.
 *
 * Composition (request + deliver + await + verify + bind) lives in the
 * planner. The cloud-backed client implementations (`ApprovalRequestsClient`,
 * `ApprovalCallbackBusClient`, `IdentityVerificationGatekeeperClient`) are
 * registered by sibling Wave D cloud packages and resolved here via
 * `runtime.getService(...)`.
 *
 * This plugin is intentionally NOT auto-enabled. The orchestrator wires it
 * into the default plugin set after parallel waves land; until then it's an
 * opt-in import for callers that need the atomic surface.
 */

import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
import {
	awaitApprovalAction,
	bindIdentityToSessionAction,
	deliverApprovalLinkAction,
	requestIdentityVerificationAction,
	verifyApprovalSignatureAction,
} from "./actions/index.ts";

export const approvalsPlugin: Plugin = {
	name: "approvals",
	description:
		"Atomic approval actions: REQUEST_IDENTITY_VERIFICATION, DELIVER_APPROVAL_LINK, AWAIT_APPROVAL, VERIFY_APPROVAL_SIGNATURE, BIND_IDENTITY_TO_SESSION.",
	actions: [
		requestIdentityVerificationAction,
		deliverApprovalLinkAction,
		awaitApprovalAction,
		verifyApprovalSignatureAction,
		bindIdentityToSessionAction,
	],
	init: async () => {
		logger.info("[ApprovalsPlugin] Initialized");
	},
};

export default approvalsPlugin;
