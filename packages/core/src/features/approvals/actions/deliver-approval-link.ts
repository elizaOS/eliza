/**
 * DELIVER_APPROVAL_LINK — atomic approval action.
 *
 * Routes the hosted approval URL for an existing approval request to a
 * chosen channel via SensitiveRequestDispatchRegistry. The link target is
 * derived from the previously-created approval envelope.
 */

import { logger } from "../../../logger.ts";
import type {
	DeliveryResult,
	DeliveryTarget,
	DispatchSensitiveRequest,
	SensitiveRequestDispatchRegistry,
} from "../../../sensitive-requests/dispatch-registry.ts";
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
	APPROVAL_REQUESTS_CLIENT_SERVICE,
	type ApprovalRequestEnvelope,
	type ApprovalRequestsClient,
	eligibleApprovalDeliveryTargets,
} from "../types.ts";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";

const ALL_TARGETS: ReadonlySet<DeliveryTarget> = new Set<DeliveryTarget>([
	"dm",
	"owner_app_inline",
	"cloud_authenticated_link",
	"tunnel_authenticated_link",
	"public_link",
	"instruct_dm_only",
]);

interface DeliverApprovalLinkParams {
	approvalRequestId?: unknown;
	target?: unknown;
	targetChannelId?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): DeliverApprovalLinkParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as DeliverApprovalLinkParams;
	}
	return options as DeliverApprovalLinkParams;
}

function envelopeToDispatchRequest(
	envelope: ApprovalRequestEnvelope,
): DispatchSensitiveRequest {
	return {
		id: envelope.approvalRequestId,
		kind: "approval",
		expiresAt: envelope.expiresAt,
		challengeKind: envelope.challengeKind,
		hostedUrl: envelope.hostedUrl,
		expectedSignerIdentityId: envelope.expectedSignerIdentityId,
		status: envelope.status,
	};
}

export const deliverApprovalLinkAction: Action = {
	name: "DELIVER_APPROVAL_LINK",
	suppressPostActionContinuation: true,
	similes: ["SEND_APPROVAL_LINK", "DISPATCH_APPROVAL_LINK"],
	description:
		"Deliver an existing approval request's hosted link via a chosen channel.",
	descriptionCompressed: "Deliver approval link via dispatch registry.",
	parameters: [
		{
			name: "approvalRequestId",
			description: "ID of an existing approval request.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "target",
			description: "Delivery target channel.",
			required: true,
			schema: {
				type: "string" as const,
				enum: [
					"dm",
					"owner_app_inline",
					"cloud_authenticated_link",
					"tunnel_authenticated_link",
					"public_link",
					"instruct_dm_only",
				],
			},
		},
		{
			name: "targetChannelId",
			description: "Override channel id passed to the delivery adapter.",
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
			runtime.getService(SENSITIVE_DISPATCH_REGISTRY_SERVICE) !== null &&
			runtime.getService(APPROVAL_REQUESTS_CLIENT_SERVICE) !== null &&
			typeof params.approvalRequestId === "string" &&
			params.approvalRequestId.length > 0 &&
			typeof params.target === "string" &&
			ALL_TARGETS.has(params.target as DeliveryTarget)
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const client = runtime.getService(
			APPROVAL_REQUESTS_CLIENT_SERVICE,
		) as unknown as ApprovalRequestsClient | null;
		const registry = runtime.getService(
			SENSITIVE_DISPATCH_REGISTRY_SERVICE,
		) as unknown as SensitiveRequestDispatchRegistry | null;
		if (!client || !registry) {
			return {
				success: false,
				text: "Approval runtime services not available",
				data: { actionName: "DELIVER_APPROVAL_LINK" },
			};
		}
		const approvalRequestId =
			typeof params.approvalRequestId === "string"
				? params.approvalRequestId
				: "";
		const target =
			typeof params.target === "string"
				? (params.target as DeliveryTarget)
				: undefined;
		if (!approvalRequestId || !target || !ALL_TARGETS.has(target)) {
			return {
				success: false,
				text: "Missing or invalid parameters: approvalRequestId, target",
				data: { actionName: "DELIVER_APPROVAL_LINK" },
			};
		}

		const envelope = await client.get(approvalRequestId);
		if (!envelope) {
			logger.warn(
				`[DELIVER_APPROVAL_LINK] approvalRequestId=${approvalRequestId} not found`,
			);
			return {
				success: false,
				text: `Approval request ${approvalRequestId} not found.`,
				data: { actionName: "DELIVER_APPROVAL_LINK", approvalRequestId },
			};
		}

		const eligible = eligibleApprovalDeliveryTargets(
			Boolean(envelope.expectedSignerIdentityId),
		);
		if (!eligible.includes(target)) {
			logger.warn(
				`[DELIVER_APPROVAL_LINK] approvalRequestId=${approvalRequestId} ineligible target=${target}`,
			);
			return {
				success: false,
				text: `Delivery target ${target} is not eligible for this approval request.`,
				data: {
					actionName: "DELIVER_APPROVAL_LINK",
					approvalRequestId,
					eligibleDeliveryTargets: eligible,
				},
			};
		}

		const adapter = registry.get(target);
		if (!adapter) {
			logger.warn(
				`[DELIVER_APPROVAL_LINK] approvalRequestId=${approvalRequestId} no adapter for target=${target}`,
			);
			return {
				success: false,
				text: `No delivery adapter registered for target ${target}.`,
				data: { actionName: "DELIVER_APPROVAL_LINK", approvalRequestId },
			};
		}

		const channelId =
			typeof params.targetChannelId === "string" &&
			params.targetChannelId.length > 0
				? params.targetChannelId
				: typeof message.roomId === "string"
					? message.roomId
					: undefined;

		const result: DeliveryResult = await adapter.deliver({
			request: envelopeToDispatchRequest(envelope),
			channelId,
			runtime,
		});

		logger.info(
			`[DELIVER_APPROVAL_LINK] approvalRequestId=${approvalRequestId} target=${target} delivered=${result.delivered}`,
		);

		const text = result.delivered
			? `Delivered approval link ${approvalRequestId} via ${target}.`
			: `Failed to deliver approval link ${approvalRequestId} via ${target}${result.error ? `: ${result.error}` : ""}.`;
		if (callback) {
			await callback({ text, action: "DELIVER_APPROVAL_LINK" });
		}

		return {
			success: result.delivered,
			text,
			data: {
				actionName: "DELIVER_APPROVAL_LINK",
				approvalRequestId,
				target,
				deliveryResult: result,
			},
		};
	},

	examples: [],
};
