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
