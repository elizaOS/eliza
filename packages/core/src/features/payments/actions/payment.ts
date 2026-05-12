/**
 * PAYMENT — consolidated payment action.
 *
 * Routes all payment operations through a single structural discriminator:
 * `action=create_request|deliver_link|verify_payload|settle|await_callback|cancel_request`.
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
	type CreatePaymentRequestInput,
	eligibleDeliveryTargetsFor,
	PAYMENT_BUS_CLIENT_SERVICE,
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	PAYMENT_SETTLER_SERVICE,
	type PaymentBusClient,
	type PaymentContext,
	type PaymentContextKind,
	type PaymentProvider,
	type PaymentRequestEnvelope,
	type PaymentRequestsClient,
	type PaymentSettler,
} from "../types.ts";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

const ALL_TARGETS: ReadonlySet<DeliveryTarget> = new Set<DeliveryTarget>([
	"dm",
	"owner_app_inline",
	"cloud_authenticated_link",
	"tunnel_authenticated_link",
	"public_link",
	"instruct_dm_only",
]);

const PAYMENT_ACTION_ALIASES = {
	create_request: "create_request",
	create_payment_request: "create_request",
	deliver_link: "deliver_link",
	deliver_payment_link: "deliver_link",
	verify_payload: "verify_payload",
	verify_payment_payload: "verify_payload",
	settle: "settle",
	settle_payment: "settle",
	await_callback: "await_callback",
	await_payment_callback: "await_callback",
	cancel_request: "cancel_request",
	cancel_payment_request: "cancel_request",
} as const;

type PaymentAction =
	| "create_request"
	| "deliver_link"
	| "verify_payload"
	| "settle"
	| "await_callback"
	| "cancel_request";

interface PaymentParams {
	action?: unknown;
	provider?: unknown;
	amountCents?: unknown;
	currency?: unknown;
	paymentContext?: unknown;
	reason?: unknown;
	expiresInMs?: unknown;
	callbackUrl?: unknown;
	metadata?: unknown;
	paymentRequestId?: unknown;
	target?: unknown;
	targetChannelId?: unknown;
	proof?: unknown;
	strategy?: unknown;
	timeoutMs?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): PaymentParams {
	if (!options || typeof options !== "object") {
		return {};
	}
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as PaymentParams;
	}
	return options as PaymentParams;
}

function normalizePaymentAction(raw: unknown): PaymentAction | null {
	if (typeof raw !== "string") return null;
	const key = raw.trim().toLowerCase();
	return (
		PAYMENT_ACTION_ALIASES[key as keyof typeof PAYMENT_ACTION_ALIASES] ?? null
	);
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

function buildCreateInput(
	params: PaymentParams,
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

function dataFor(action: PaymentAction, data: Record<string, unknown> = {}) {
	return { actionName: "PAYMENT", paymentAction: action, ...data };
}

async function maybeCallback(
	callback: HandlerCallback | undefined,
	text: string,
) {
	if (callback) {
		await callback({ text, action: "PAYMENT" });
	}
}

async function handleCreateRequest(
	runtime: IAgentRuntime,
	params: PaymentParams,
	callback?: HandlerCallback,
) {
	const action: PaymentAction = "create_request";
	const client = runtime.getService(
		PAYMENT_REQUESTS_CLIENT_SERVICE,
	) as unknown as PaymentRequestsClient | null;
	if (!client) {
		return {
			success: false,
			text: "PaymentRequestsClient not available",
			data: dataFor(action),
		};
	}

	const built = buildCreateInput(params);
	if ("error" in built) {
		logger.warn(`[Payment:create_request] invalid params: ${built.error}`);
		return {
			success: false,
			text: built.error,
			data: dataFor(action),
		};
	}

	const envelope = await client.create(built.input);
	const eligibleDeliveryTargets: DeliveryTarget[] = eligibleDeliveryTargetsFor(
		envelope.paymentContext.kind,
	);

	logger.info(
		`[Payment:create_request] requestId=${envelope.paymentRequestId} provider=${envelope.provider} amountCents=${envelope.amountCents}`,
	);

	const text = `Created payment request ${envelope.paymentRequestId} for ${envelope.amountCents} ${envelope.currency}.`;
	await maybeCallback(callback, text);

	return {
		success: true,
		text,
		data: dataFor(action, {
			paymentRequestId: envelope.paymentRequestId,
			hostedUrl: envelope.hostedUrl,
			expiresAt: envelope.expiresAt,
			eligibleDeliveryTargets,
		}),
	};
}

async function handleDeliverLink(
	runtime: IAgentRuntime,
	message: Memory,
	params: PaymentParams,
	callback?: HandlerCallback,
) {
	const action: PaymentAction = "deliver_link";
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
			data: dataFor(action),
		};
	}

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
			data: dataFor(action),
		};
	}

	const envelope = await client.get(paymentRequestId);
	if (!envelope) {
		logger.warn(`[Payment:deliver_link] requestId=${paymentRequestId} not found`);
		return {
			success: false,
			text: `Payment request ${paymentRequestId} not found.`,
			data: dataFor(action, { paymentRequestId }),
		};
	}

	const eligible = eligibleDeliveryTargetsFor(envelope.paymentContext.kind);
	if (!eligible.includes(target)) {
		logger.warn(
			`[Payment:deliver_link] requestId=${paymentRequestId} ineligible target=${target}`,
		);
		return {
			success: false,
			text: `Delivery target ${target} is not eligible for payment context ${envelope.paymentContext.kind}.`,
			data: dataFor(action, {
				paymentRequestId,
				eligibleDeliveryTargets: eligible,
			}),
		};
	}

	const adapter = registry.get(target);
	if (!adapter) {
		logger.warn(
			`[Payment:deliver_link] requestId=${paymentRequestId} no adapter for target=${target}`,
		);
		return {
			success: false,
			text: `No delivery adapter registered for target ${target}.`,
			data: dataFor(action, { paymentRequestId }),
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
		`[Payment:deliver_link] requestId=${paymentRequestId} target=${target} delivered=${result.delivered}`,
	);

	const text = result.delivered
		? `Delivered payment request ${paymentRequestId} via ${target}.`
		: `Failed to deliver payment request ${paymentRequestId} via ${target}${result.error ? `: ${result.error}` : ""}.`;
	await maybeCallback(callback, text);

	return {
		success: result.delivered,
		text,
		data: dataFor(action, {
			paymentRequestId,
			target,
			deliveryResult: result,
		}),
	};
}

async function handleVerifyPayload(
	runtime: IAgentRuntime,
	params: PaymentParams,
	callback?: HandlerCallback,
) {
	const action: PaymentAction = "verify_payload";
	const bus = runtime.getService(
		PAYMENT_BUS_CLIENT_SERVICE,
	) as unknown as PaymentBusClient | null;
	if (!bus) {
		return {
			success: false,
			text: "PaymentBusClient not available",
			data: dataFor(action),
		};
	}

	const paymentRequestId =
		typeof params.paymentRequestId === "string"
			? params.paymentRequestId
			: "";
	if (!paymentRequestId || params.proof === undefined) {
		return {
			success: false,
			text: "Missing required parameters: paymentRequestId, proof",
			data: dataFor(action),
		};
	}

	const verification = await bus.verifyProof(paymentRequestId, params.proof);

	logger.info(
		`[Payment:verify_payload] requestId=${paymentRequestId} valid=${verification.valid}`,
	);

	const text = verification.valid
		? `Payment proof for ${paymentRequestId} is valid.`
		: `Payment proof for ${paymentRequestId} is invalid${verification.error ? `: ${verification.error}` : ""}.`;
	await maybeCallback(callback, text);

	return {
		success: verification.valid,
		text,
		data: dataFor(action, {
			paymentRequestId,
			valid: verification.valid,
			error: verification.error,
			payerIdentity: verification.payerIdentity,
		}),
	};
}

async function handleSettle(
	runtime: IAgentRuntime,
	params: PaymentParams,
	callback?: HandlerCallback,
) {
	const action: PaymentAction = "settle";
	const settler = runtime.getService(
		PAYMENT_SETTLER_SERVICE,
	) as unknown as PaymentSettler | null;
	if (!settler) {
		return {
			success: false,
			text: "PaymentSettler not available",
			data: dataFor(action),
		};
	}

	const paymentRequestId =
		typeof params.paymentRequestId === "string"
			? params.paymentRequestId
			: "";
	if (!paymentRequestId) {
		return {
			success: false,
			text: "Missing required parameter: paymentRequestId",
			data: dataFor(action),
		};
	}

	const settlement = await settler.settle({
		paymentRequestId,
		proof: params.proof,
		strategy: typeof params.strategy === "string" ? params.strategy : undefined,
	});

	logger.info(
		`[Payment:settle] requestId=${paymentRequestId} status=${settlement.status}`,
	);

	const text =
		settlement.status === "settled"
			? `Payment ${paymentRequestId} settled${settlement.txRef ? ` (tx ${settlement.txRef})` : ""}.`
			: `Payment ${paymentRequestId} settle attempt ended with status ${settlement.status}${settlement.error ? `: ${settlement.error}` : ""}.`;
	await maybeCallback(callback, text);

	return {
		success: settlement.status === "settled",
		text,
		data: dataFor(action, { settlement }),
	};
}

async function handleAwaitCallback(
	runtime: IAgentRuntime,
	params: PaymentParams,
	callback?: HandlerCallback,
) {
	const action: PaymentAction = "await_callback";
	const bus = runtime.getService(
		PAYMENT_BUS_CLIENT_SERVICE,
	) as unknown as PaymentBusClient | null;
	if (!bus) {
		return {
			success: false,
			text: "PaymentBusClient not available",
			data: dataFor(action),
		};
	}

	const paymentRequestId =
		typeof params.paymentRequestId === "string"
			? params.paymentRequestId
			: "";
	if (!paymentRequestId) {
		return {
			success: false,
			text: "Missing required parameter: paymentRequestId",
			data: dataFor(action),
		};
	}

	const timeoutMs =
		typeof params.timeoutMs === "number" &&
		Number.isFinite(params.timeoutMs) &&
		params.timeoutMs > 0
			? params.timeoutMs
			: DEFAULT_TIMEOUT_MS;

	const settlement = await bus.waitFor(paymentRequestId, timeoutMs);

	logger.info(
		`[Payment:await_callback] requestId=${paymentRequestId} status=${settlement.status}`,
	);

	const sanitized = {
		paymentRequestId: settlement.paymentRequestId,
		status: settlement.status,
		txRef: settlement.txRef,
		payerIdentityId: settlement.payerIdentityId,
		amountCents: settlement.amountCents,
		error: settlement.error,
		settledAt: settlement.settledAt,
	};

	const text =
		settlement.status === "settled"
			? `Payment ${paymentRequestId} settled.`
			: `Payment ${paymentRequestId} ended in status ${settlement.status}${settlement.error ? `: ${settlement.error}` : ""}.`;
	await maybeCallback(callback, text);

	return {
		success: settlement.status === "settled",
		text,
		data: dataFor(action, { settlement: sanitized }),
	};
}

async function handleCancelRequest(
	runtime: IAgentRuntime,
	params: PaymentParams,
	callback?: HandlerCallback,
) {
	const action: PaymentAction = "cancel_request";
	const client = runtime.getService(
		PAYMENT_REQUESTS_CLIENT_SERVICE,
	) as unknown as PaymentRequestsClient | null;
	if (!client) {
		return {
			success: false,
			text: "PaymentRequestsClient not available",
			data: dataFor(action),
		};
	}

	const paymentRequestId =
		typeof params.paymentRequestId === "string"
			? params.paymentRequestId
			: "";
	if (!paymentRequestId) {
		return {
			success: false,
			text: "Missing required parameter: paymentRequestId",
			data: dataFor(action),
		};
	}

	const reason =
		typeof params.reason === "string" && params.reason.trim().length > 0
			? params.reason.trim()
			: undefined;

	const envelope = await client.cancel(paymentRequestId, reason);

	logger.info(
		`[Payment:cancel_request] requestId=${paymentRequestId} status=${envelope.status}`,
	);

	const text = `Payment request ${paymentRequestId} is now ${envelope.status}.`;
	await maybeCallback(callback, text);

	return {
		success: envelope.status === "canceled",
		text,
		data: dataFor(action, { envelope }),
	};
}

function validateParams(runtime: IAgentRuntime, params: PaymentParams): boolean {
	const action = normalizePaymentAction(params.action);
	if (!action) return false;
	switch (action) {
		case "create_request":
			return (
				runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE) !== null &&
				"input" in buildCreateInput(params)
			);
		case "deliver_link":
			return (
				runtime.getService(SENSITIVE_DISPATCH_REGISTRY_SERVICE) !== null &&
				runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE) !== null &&
				typeof params.paymentRequestId === "string" &&
				params.paymentRequestId.length > 0 &&
				typeof params.target === "string" &&
				ALL_TARGETS.has(params.target as DeliveryTarget)
			);
		case "verify_payload":
			return (
				runtime.getService(PAYMENT_BUS_CLIENT_SERVICE) !== null &&
				typeof params.paymentRequestId === "string" &&
				params.paymentRequestId.length > 0 &&
				params.proof !== undefined
			);
		case "settle":
			return (
				runtime.getService(PAYMENT_SETTLER_SERVICE) !== null &&
				typeof params.paymentRequestId === "string" &&
				params.paymentRequestId.length > 0
			);
		case "await_callback":
			return (
				runtime.getService(PAYMENT_BUS_CLIENT_SERVICE) !== null &&
				typeof params.paymentRequestId === "string" &&
				params.paymentRequestId.length > 0
			);
		case "cancel_request":
			return (
				runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE) !== null &&
				typeof params.paymentRequestId === "string" &&
				params.paymentRequestId.length > 0
			);
	}
}

export const paymentAction: Action = {
	name: "PAYMENT",
	suppressPostActionContinuation: true,
	similes: [
		"CREATE_PAYMENT_REQUEST",
		"NEW_PAYMENT_REQUEST",
		"OPEN_PAYMENT_REQUEST",
		"DELIVER_PAYMENT_LINK",
		"SEND_PAYMENT_LINK",
		"DISPATCH_PAYMENT_LINK",
		"VERIFY_PAYMENT_PAYLOAD",
		"VERIFY_PAYMENT_PROOF",
		"CHECK_PAYMENT_PROOF",
		"SETTLE_PAYMENT",
		"FINALIZE_PAYMENT",
		"CONFIRM_PAYMENT",
		"AWAIT_PAYMENT_CALLBACK",
		"WAIT_FOR_PAYMENT",
		"AWAIT_PAYMENT_SETTLEMENT",
		"CANCEL_PAYMENT_REQUEST",
		"VOID_PAYMENT_REQUEST",
		"ABORT_PAYMENT_REQUEST",
	],
	description:
		"Payment operations. Set action to create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request.",
	descriptionCompressed:
		"Payment ops: create_request, deliver_link, verify_payload, settle, await_callback, cancel_request.",
	parameters: [
		{
			name: "action",
			description:
				"Payment operation to run: create_request, deliver_link, verify_payload, settle, await_callback, or cancel_request.",
			required: true,
			schema: {
				type: "string" as const,
				enum: [
					"create_request",
					"deliver_link",
					"verify_payload",
					"settle",
					"await_callback",
					"cancel_request",
				],
			},
		},
		{
			name: "provider",
			description:
				"For create_request: payment provider key (stripe | oxapay | x402 | wallet_native).",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["stripe", "oxapay", "x402", "wallet_native"],
			},
		},
		{
			name: "amountCents",
			description: "For create_request: amount in minor currency units.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "currency",
			description: "For create_request: ISO 4217 currency code.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "paymentContext",
			description:
				"For create_request: payer constraint object with kind any_payer, verified_payer, or specific_payer.",
			required: false,
			schema: { type: "object" as const },
		},
		{
			name: "reason",
			description:
				"For create_request or cancel_request: human-readable payment or cancellation reason.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "expiresInMs",
			description: "For create_request: optional TTL override in milliseconds.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "paymentRequestId",
			description:
				"For deliver_link, verify_payload, settle, await_callback, or cancel_request: payment request ID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "target",
			description: "For deliver_link: delivery channel to use.",
			required: false,
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
				"For deliver_link: override channel id passed to the delivery adapter.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "proof",
			description: "For verify_payload or settle: provider-specific proof payload.",
			required: false,
			schema: { type: "object" as const },
		},
		{
			name: "strategy",
			description: "For settle: optional settler strategy hint.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "timeoutMs",
			description:
				"For await_callback: wait timeout in milliseconds. Defaults to 600000.",
			required: false,
			schema: { type: "number" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => validateParams(runtime, readParams(options)),

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const action = normalizePaymentAction(params.action);
		if (!action) {
			return {
				success: false,
				text: "PAYMENT requires action in {create_request, deliver_link, verify_payload, settle, await_callback, cancel_request}.",
				data: { actionName: "PAYMENT" },
			};
		}

		switch (action) {
			case "create_request":
				return handleCreateRequest(runtime, params, callback);
			case "deliver_link":
				return handleDeliverLink(runtime, message, params, callback);
			case "verify_payload":
				return handleVerifyPayload(runtime, params, callback);
			case "settle":
				return handleSettle(runtime, params, callback);
			case "await_callback":
				return handleAwaitCallback(runtime, params, callback);
			case "cancel_request":
				return handleCancelRequest(runtime, params, callback);
		}
	},

	examples: [],
};
