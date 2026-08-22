/**
 * Defines the host-owned interaction coordinator consumed by connector plugins.
 * Connectors render prepared deliveries and submit authenticated inbound events;
 * they never construct a second session authority or execute effects directly.
 */

import { ElizaError } from "../../errors";
import type { InteractionBlock } from "../../types/interactions";
import type { IAgentRuntime } from "../../types/runtime";
import type {
	ConnectorInteractionCapabilityProfile,
	InteractionNegotiationContext,
	NegotiatedInteractionDelivery,
} from "./profiles";
import type {
	MessageInteractionAuthorizationDecision,
	MessageInteractionBindings,
	MessageInteractionEffect,
	MessageInteractionPurpose,
	MessageInteractionResponse,
	MessageInteractionSession,
} from "./sessions";
import { decodeMessageInteractionCallback } from "./sessions";

export const MESSAGE_INTERACTION_HOST_SERVICE =
	"message_interaction_host" as const;

export interface PrepareMessageInteractionRequest {
	block: InteractionBlock;
	profile: ConnectorInteractionCapabilityProfile;
	bindings: MessageInteractionBindings;
	purpose: MessageInteractionPurpose;
	negotiationContext?: InteractionNegotiationContext;
	presetResponse?: MessageInteractionResponse;
	authorization: Omit<
		MessageInteractionAuthorizationDecision,
		"state" | "revokedAt"
	>;
	effect: MessageInteractionEffect;
	expiresAt: string;
}

/** Safe subset a connector needs to render; retained authority is omitted. */
export interface PreparedMessageInteraction {
	block: InteractionBlock;
	delivery: NegotiatedInteractionDelivery;
	/** Present only after negotiation validates a signed-hosted delivery URL. */
	hostedUrl?: string;
	callbackData: string;
	expiresAt: string;
	profileId: string;
}

/** Bindings a connector can authenticate from an inbound provider event. */
export type AuthenticatedMessageInteractionBindings = Omit<
	MessageInteractionBindings,
	"sourceMessageId"
>;

export interface MessageInteractionProviderReceipt {
	source: string;
	accountId: string;
	inboundEventId: string;
	receivedAt: string;
}

export interface MessageInteractionHostEffectResult {
	receiptId: string;
	canonicalInboundEventId: string;
	auditId: string;
	appStateResult: Readonly<Record<string, string | number | boolean | null>>;
	result: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MessageInteractionHostEffectHandler {
	execute(args: {
		idempotencyKey: string;
		effect: MessageInteractionEffect;
		response: MessageInteractionResponse;
		session: MessageInteractionSession;
		providerReceipt: MessageInteractionProviderReceipt;
	}): Promise<MessageInteractionHostEffectResult>;
}

export interface MessageInteractionHostReceipt {
	receiptId: string;
	idempotencyKey: string;
	status: "completed";
	completedAt: string;
	canonicalInboundEventId: string;
	providerReceipt: MessageInteractionProviderReceipt;
	auditId: string;
	appStateResult: Readonly<Record<string, string | number | boolean | null>>;
	result: Readonly<Record<string, string | number | boolean | null>>;
}

export type MessageInteractionHostConsumeOutcome =
	| {
			status: "completed" | "replay";
			receipt: MessageInteractionHostReceipt;
	  }
	| { status: "in_progress" }
	| { status: "denied"; code: string; message: string };

export interface ConsumeMessageInteractionRequest {
	callbackData: string;
	bindings: AuthenticatedMessageInteractionBindings;
	response?: MessageInteractionResponse;
	providerReceipt: MessageInteractionProviderReceipt;
}

export interface MessageInteractionHost {
	prepare(
		request: PrepareMessageInteractionRequest,
	): Promise<PreparedMessageInteraction>;
	consume(
		request: ConsumeMessageInteractionRequest,
	): Promise<MessageInteractionHostConsumeOutcome>;
	revoke(request: {
		reference: string;
		decisionId: string;
		now?: number;
	}): Promise<MessageInteractionSession>;
	get(reference: string): Promise<MessageInteractionSession | null>;
	registerEffectHandler(
		kind: string,
		handler: MessageInteractionHostEffectHandler,
	): () => void;
}

export interface DecodedPreparedInteractionCallback {
	callbackData: string;
	response: MessageInteractionResponse;
}

const PROVIDER_RESPONSE_SEPARATOR = "~";

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
	try {
		const padded = value.replaceAll("-", "+").replaceAll("_", "/");
		const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
		return new TextDecoder().decode(
			Uint8Array.from(binary, (character) => character.charCodeAt(0)),
		);
	} catch {
		// error-policy:J3 Provider callback data is untrusted and malformed data
		// remains explicitly invalid rather than becoming a plausible response.
		return null;
	}
}

/**
 * Add non-secret user input to an opaque callback for providers whose control
 * value is their only callback field. Authority remains exclusively in the
 * host session; the host validates this response against its retained schema.
 */
export function encodePreparedInteractionCallback(
	callbackData: string,
	response: MessageInteractionResponse,
	maxBytes: number,
): string | null {
	if (!decodeMessageInteractionCallback(callbackData)) return null;
	const entries = Object.entries(response);
	if (
		entries.length !== 1 ||
		!(["value", "acknowledged"] as string[]).includes(entries[0][0]) ||
		(typeof entries[0][1] !== "string" &&
			typeof entries[0][1] !== "number" &&
			typeof entries[0][1] !== "boolean")
	) {
		return null;
	}
	const wire = `${callbackData}${PROVIDER_RESPONSE_SEPARATOR}${encodeBase64Url(JSON.stringify(response))}`;
	return new TextEncoder().encode(wire).length <= maxBytes ? wire : null;
}

/** Parse an untrusted provider value into the opaque host reference and input. */
export function decodePreparedInteractionCallback(
	value: unknown,
): DecodedPreparedInteractionCallback | null {
	if (typeof value !== "string") return null;
	const separator = value.indexOf(PROVIDER_RESPONSE_SEPARATOR);
	if (separator < 0) return null;
	const callbackData = value.slice(0, separator);
	if (!decodeMessageInteractionCallback(callbackData)) return null;
	const decoded = decodeBase64Url(value.slice(separator + 1));
	if (!decoded) return null;
	try {
		const response = JSON.parse(decoded) as unknown;
		if (!response || typeof response !== "object" || Array.isArray(response))
			return null;
		const entries = Object.entries(response);
		if (
			entries.length !== 1 ||
			!(["value", "acknowledged"] as string[]).includes(entries[0][0]) ||
			(typeof entries[0][1] !== "string" &&
				typeof entries[0][1] !== "number" &&
				typeof entries[0][1] !== "boolean")
		)
			return null;
		return { callbackData, response: response as MessageInteractionResponse };
	} catch {
		// error-policy:J3 Provider callback data is untrusted JSON; parsing failure
		// is an explicit invalid callback and never a fabricated empty response.
		return null;
	}
}

/** Submit a provider-authenticated callback to the sole host authority. */
export async function consumePreparedInteractionCallback(
	runtime: IAgentRuntime,
	request: Omit<ConsumeMessageInteractionRequest, "callbackData" | "response"> & {
		providerCallbackData: unknown;
	},
): Promise<MessageInteractionHostConsumeOutcome> {
	const decoded = decodePreparedInteractionCallback(
		request.providerCallbackData,
	);
	if (!decoded) {
		return {
			status: "denied",
			code: "INVALID_MESSAGE_INTERACTION_PROVIDER_CALLBACK",
			message: "The provider callback is malformed or unsupported.",
		};
	}
	const host = resolveMessageInteractionHost(runtime);
	if (!host) {
		return {
			status: "denied",
			code: "MESSAGE_INTERACTION_HOST_UNAVAILABLE",
			message: "Interactive actions are temporarily unavailable; reply in text.",
		};
	}
	return host.consume({
		callbackData: decoded.callbackData,
		response: decoded.response,
		bindings: request.bindings,
		providerReceipt: request.providerReceipt,
	});
}

/** Resolve the one host authority. Absence is an explicit unavailable state. */
export function resolveMessageInteractionHost(
	runtime: IAgentRuntime,
): MessageInteractionHost | null {
	const service = runtime.getService(MESSAGE_INTERACTION_HOST_SERVICE);
	if (!service) return null;
	const candidate = service as unknown as Partial<MessageInteractionHost>;
	if (
		typeof candidate.prepare !== "function" ||
		typeof candidate.consume !== "function" ||
		typeof candidate.revoke !== "function" ||
		typeof candidate.get !== "function" ||
		typeof candidate.registerEffectHandler !== "function"
	) {
		throw new ElizaError("Registered interaction host is malformed.", {
			code: "INVALID_MESSAGE_INTERACTION_HOST_SERVICE",
		});
	}
	return candidate as MessageInteractionHost;
}
