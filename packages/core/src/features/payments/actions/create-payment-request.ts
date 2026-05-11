/**
 * CREATE_PAYMENT_REQUEST — atomic payment action.
 *
 * Creates a payment request via the runtime-injected
 * `PaymentRequestsClient`. Returns the persisted envelope plus the set of
 * `DeliveryTarget`s that are eligible for the request's `paymentContext`.
 *
 * Composition (create + deliver + await) lives in the planner, not here.
 */

import { logger } from "../../../logger.ts";
import type { DeliveryTarget } from "../../../sensitive-requests/dispatch-registry.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	type CreatePaymentRequestInput,
	eligibleDeliveryTargetsFor,
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	type PaymentContext,
	type PaymentContextKind,
	type PaymentProvider,
	type PaymentRequestsClient,
} from "../types.ts";

const VALID_PROVIDERS: ReadonlySet<PaymentProvider> = new Set([
	"stripe",
	"oxapay",
	"x402",
	"wallet_native",
]);

const VALID_CONTEXT_KINDS: ReadonlySet<PaymentContextKind> = new Set([
	"any_payer",
	"verified_payer",
	"specific_payer",
]);

interface RawCreateParams {
	provider?: unknown;
	amountCents?: unknown;
	currency?: unknown;
	paymentContext?: unknown;
	reason?: unknown;
	expiresInMs?: unknown;
	callbackUrl?: unknown;
	metadata?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawCreateParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as RawCreateParams;
}

function parsePaymentContext(raw: unknown): PaymentContext | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const kind = obj.kind;
	if (
		typeof kind !== "string" ||
		!VALID_CONTEXT_KINDS.has(kind as PaymentContextKind)
	) {
		return null;
	}
	const context: PaymentContext = { kind: kind as PaymentContextKind };
	if (obj.scope === "owner" || obj.scope === "owner_or_linked_identity") {
		context.scope = obj.scope;
	}
	if (
		typeof obj.payerIdentityId === "string" &&
		obj.payerIdentityId.length > 0
	) {
		context.payerIdentityId = obj.payerIdentityId;
	}
	if (context.kind === "specific_payer" && !context.payerIdentityId) {
		return null;
	}
	return context;
}

function buildInput(
	params: RawCreateParams,
): { input: CreatePaymentRequestInput } | { error: string } {
	const provider = params.provider;
	if (
		typeof provider !== "string" ||
		!VALID_PROVIDERS.has(provider as PaymentProvider)
	) {
		return { error: "Invalid or missing provider" };
	}
	const amountCents = params.amountCents;
	if (
		typeof amountCents !== "number" ||
		!Number.isFinite(amountCents) ||
		amountCents <= 0 ||
		!Number.isInteger(amountCents)
	) {
		return { error: "amountCents must be a positive integer" };
	}
	const paymentContext = parsePaymentContext(params.paymentContext);
	if (!paymentContext) {
		return { error: "Invalid or missing paymentContext" };
	}
	const input: CreatePaymentRequestInput = {
		provider: provider as PaymentProvider,
		amountCents,
		paymentContext,
	};
	if (typeof params.currency === "string" && params.currency.length > 0) {
		input.currency = params.currency;
	}
	if (typeof params.reason === "string" && params.reason.trim().length > 0) {
		input.reason = params.reason.trim();
	}
	if (typeof params.expiresInMs === "number" && params.expiresInMs > 0) {
		input.expiresInMs = params.expiresInMs;
	}
	if (typeof params.callbackUrl === "string" && params.callbackUrl.length > 0) {
		input.callbackUrl = params.callbackUrl;
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

export const createPaymentRequestAction: Action = {
	name: "CREATE_PAYMENT_REQUEST",
	suppressPostActionContinuation: true,
	similes: ["NEW_PAYMENT_REQUEST", "OPEN_PAYMENT_REQUEST"],
	description:
		"Create a payment request via the configured payment provider and return the persisted envelope plus the eligible delivery channels for its payment context.",
	parameters: [
		{
			name: "provider",
			description:
				"Payment provider key (stripe | oxapay | x402 | wallet_native).",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["stripe", "oxapay", "x402", "wallet_native"],
			},
		},
		{
			name: "amountCents",
			description: "Amount in minor currency units (positive integer).",
			required: true,
			schema: { type: "number" as const },
		},
		{
			name: "currency",
			description: "ISO 4217 currency code; defaults to provider default.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "paymentContext",
			description:
				"Payer constraint. {kind: any_payer | verified_payer | specific_payer, scope?, payerIdentityId?}.",
			required: true,
			schema: { type: "object" as const },
		},
		{
			name: "reason",
			description: "Human-readable reason for the charge.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "expiresInMs",
			description: "Optional TTL override in milliseconds.",
			required: false,
			schema: { type: "number" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE) === null) {
			return false;
		}
		const params = readParams(options);
		const built = buildInput(params);
		return "input" in built;
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const client = runtime.getService(
			PAYMENT_REQUESTS_CLIENT_SERVICE,
		) as unknown as PaymentRequestsClient | null;
		if (!client) {
			return {
				success: false,
				text: "PaymentRequestsClient not available",
				data: { actionName: "CREATE_PAYMENT_REQUEST" },
			};
		}

		const params = readParams(options);
		const built = buildInput(params);
		if ("error" in built) {
			logger.warn(`[CreatePaymentRequest] invalid params: ${built.error}`);
			return {
				success: false,
				text: built.error,
				data: { actionName: "CREATE_PAYMENT_REQUEST" },
			};
		}

		const envelope = await client.create(built.input);
		const eligibleDeliveryTargets: DeliveryTarget[] =
			eligibleDeliveryTargetsFor(envelope.paymentContext.kind);

		logger.info(
			`[CreatePaymentRequest] requestId=${envelope.paymentRequestId} provider=${envelope.provider} amountCents=${envelope.amountCents}`,
		);

		const text = `Created payment request ${envelope.paymentRequestId} for ${envelope.amountCents} ${envelope.currency}.`;

		if (callback) {
			await callback({ text, action: "CREATE_PAYMENT_REQUEST" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "CREATE_PAYMENT_REQUEST",
				paymentRequestId: envelope.paymentRequestId,
				hostedUrl: envelope.hostedUrl,
				expiresAt: envelope.expiresAt,
				eligibleDeliveryTargets,
			},
		};
	},

	examples: [],
};
