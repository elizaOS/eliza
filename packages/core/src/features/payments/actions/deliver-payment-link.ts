/**
 * DELIVER_PAYMENT_LINK — atomic payment action.
 *
 * Looks up a stored payment request, validates that `target` is an eligible
 * delivery channel for its `paymentContext`, and dispatches through the
 * `SensitiveRequestDispatchRegistry` adapter for that target (Wave A
 * adapters are reused — no new adapters here).
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
	Memory,
	State,
} from "../../../types/index.ts";
import {
	eligibleDeliveryTargetsFor,
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	type PaymentRequestEnvelope,
	type PaymentRequestsClient,
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

interface RawDeliverParams {
	paymentRequestId?: unknown;
	target?: unknown;
	targetChannelId?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawDeliverParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as RawDeliverParams;
}

function envelopeToDispatchRequest(
	envelope: PaymentRequestEnvelope,
): DispatchSensitiveRequest {
	return {
		id: envelope.paymentRequestId,
		kind: "payment",
		expiresAt: envelope.expiresAt,
		provider: envelope.provider,
		amountCents: envelope.amountCents,
		currency: envelope.currency,
		hostedUrl: envelope.hostedUrl,
		paymentContext: envelope.paymentContext,
		reason: envelope.reason,
		status: envelope.status,
	};
}

export const deliverPaymentLinkAction: Action = {
	name: "DELIVER_PAYMENT_LINK",
	suppressPostActionContinuation: true,
	similes: ["SEND_PAYMENT_LINK", "DISPATCH_PAYMENT_LINK"],
	description:
		"Deliver an existing payment request through a chosen delivery channel (DM, owner-app inline, cloud/tunnel authenticated link, or public link).",
	parameters: [
		{
			name: "paymentRequestId",
			description: "ID returned by CREATE_PAYMENT_REQUEST.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "target",
			description: "Delivery channel to use.",
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
			description:
				"Override the channel id passed to the adapter; defaults to the current message channel.",
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
		if (
			runtime.getService(SENSITIVE_DISPATCH_REGISTRY_SERVICE) === null ||
			runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE) === null
		) {
			return false;
		}
		const params = readParams(options);
		return (
			typeof params.paymentRequestId === "string" &&
			params.paymentRequestId.length > 0 &&
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
		const client = runtime.getService(
			PAYMENT_REQUESTS_CLIENT_SERVICE,
		) as unknown as PaymentRequestsClient | null;
		const registry = runtime.getService(
			SENSITIVE_DISPATCH_REGISTRY_SERVICE,
		) as unknown as SensitiveRequestDispatchRegistry | null;
		if (!client || !registry) {
			return {
				success: false,
				text: "Payment runtime services not available",
				data: { actionName: "DELIVER_PAYMENT_LINK" },
			};
		}

		const params = readParams(options);
		const paymentRequestId =
			typeof params.paymentRequestId === "string"
				? params.paymentRequestId
				: "";
		const target =
			typeof params.target === "string"
				? (params.target as DeliveryTarget)
				: undefined;
		if (!paymentRequestId || !target || !ALL_TARGETS.has(target)) {
			return {
				success: false,
				text: "Missing or invalid parameters: paymentRequestId, target",
				data: { actionName: "DELIVER_PAYMENT_LINK" },
			};
		}

		const envelope = await client.get(paymentRequestId);
		if (!envelope) {
			logger.warn(
				`[DeliverPaymentLink] requestId=${paymentRequestId} not found`,
			);
			return {
				success: false,
				text: `Payment request ${paymentRequestId} not found.`,
				data: { actionName: "DELIVER_PAYMENT_LINK", paymentRequestId },
			};
		}

		const eligible = eligibleDeliveryTargetsFor(envelope.paymentContext.kind);
		if (!eligible.includes(target)) {
			logger.warn(
				`[DeliverPaymentLink] requestId=${paymentRequestId} ineligible target=${target}`,
			);
			return {
				success: false,
				text: `Delivery target ${target} is not eligible for payment context ${envelope.paymentContext.kind}.`,
				data: {
					actionName: "DELIVER_PAYMENT_LINK",
					paymentRequestId,
					eligibleDeliveryTargets: eligible,
				},
			};
		}

		const adapter = registry.get(target);
		if (!adapter) {
			logger.warn(
				`[DeliverPaymentLink] requestId=${paymentRequestId} no adapter for target=${target}`,
			);
			return {
				success: false,
				text: `No delivery adapter registered for target ${target}.`,
				data: { actionName: "DELIVER_PAYMENT_LINK", paymentRequestId },
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
			`[DeliverPaymentLink] requestId=${paymentRequestId} target=${target} delivered=${result.delivered}`,
		);

		const text = result.delivered
			? `Delivered payment request ${paymentRequestId} via ${target}.`
			: `Failed to deliver payment request ${paymentRequestId} via ${target}${result.error ? `: ${result.error}` : ""}.`;

		if (callback) {
			await callback({ text, action: "DELIVER_PAYMENT_LINK" });
		}

		return {
			success: result.delivered,
			text,
			data: {
				actionName: "DELIVER_PAYMENT_LINK",
				paymentRequestId,
				target,
				deliveryResult: result,
			},
		};
	},

	examples: [],
};
