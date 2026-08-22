/**
 * Owns durable message-interaction sessions and their exactly-once execution
 * protocol. The authority binds callbacks to trusted context, while storage
 * implementations provide atomic claim/complete/revoke transitions.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ElizaError } from "../../errors";
import type {
	InteractionBlock,
	InteractionField,
	InteractionKind,
} from "../../types/interactions";
import { stableStringify } from "../../utils/deterministic";
import type {
	ConnectorInteractionCapabilityProfile,
	InteractionNegotiationContext,
} from "./profiles";
import {
	negotiateInteractionDelivery,
	normalizeConnectorInteractionCapabilityProfile,
} from "./profiles";

export const MESSAGE_INTERACTION_SESSION_VERSION = 1 as const;
export const MESSAGE_INTERACTION_CALLBACK_PREFIX = "is1:";
export const MESSAGE_INTERACTION_CALLBACK_BYTES = 36;

export type MessageInteractionPurpose =
	| "choice"
	| "form"
	| "approval"
	| "setup"
	| "auth"
	| "task"
	| "file"
	| "followup";

export type MessageInteractionFlow =
	| "native"
	| "conversational"
	| "signed-hosted"
	| "sensitive-request";

export interface MessageInteractionBindings {
	actorId: string;
	audience: { kind: string; id: string };
	agentId: string;
	connector: { source: string; accountId: string };
	roomId: string;
	sourceMessageId: string;
}

export type MessageInteractionResponseScalar = string | number | boolean;

export interface MessageInteractionAttachmentResponse {
	mediaUrl: string;
	mimeType: string;
	bytes: number;
}

export type MessageInteractionResponseValue =
	| MessageInteractionResponseScalar
	| MessageInteractionAttachmentResponse;

export type MessageInteractionResponse = Record<
	string,
	MessageInteractionResponseValue
>;

export interface MessageInteractionResponseField {
	name: string;
	type: InteractionField["type"] | "acknowledgement";
	required: boolean;
	options?: readonly string[];
	maxBytes?: number;
	mimeTypes?: readonly string[];
}

export interface MessageInteractionResponseSchema {
	fields: readonly MessageInteractionResponseField[];
	additionalFields: false;
}

export interface MessageInteractionAuthorizationDecision {
	decisionId: string;
	policyRevision: string;
	decidedAt: string;
	state: "active" | "revoked";
	revokedAt: string | null;
}

export interface MessageInteractionEffect {
	kind: string;
	/** Non-secret operation metadata. Credentials and submitted secrets are forbidden. */
	metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type MessageInteractionConsumeState =
	| { state: "pending" }
	| {
			state: "claimed";
			claimId: string;
			replayKey: string;
			responseDigest: string;
			response: MessageInteractionResponse;
			claimedAt: string;
			claimExpiresAt: string;
			attempt: number;
	  }
	| {
			state: "committed";
			claimId: string;
			replayKey: string;
			responseDigest: string;
			response: MessageInteractionResponse;
			claimedAt: string;
			committedAt: string;
			attempt: number;
	  }
	| {
			state: "completed";
			claimId: string;
			replayKey: string;
			responseDigest: string;
			response: MessageInteractionResponse;
			claimedAt: string;
			committedAt: string;
			completedAt: string;
			attempt: number;
			receipt: MessageInteractionReceipt;
	  };

export interface MessageInteractionSession {
	sessionVersion: typeof MESSAGE_INTERACTION_SESSION_VERSION;
	reference: string;
	purpose: MessageInteractionPurpose;
	blockKind: InteractionKind;
	flow: MessageInteractionFlow;
	profileId: string;
	bindings: MessageInteractionBindings;
	responseSchema: MessageInteractionResponseSchema;
	presetResponse: MessageInteractionResponse | null;
	authorization: MessageInteractionAuthorizationDecision;
	effect: MessageInteractionEffect;
	createdAt: string;
	expiresAt: string;
	consume: MessageInteractionConsumeState;
	revision: number;
}

export interface MessageInteractionReceipt {
	receiptId: string;
	idempotencyKey: string;
	status: "completed";
	completedAt: string;
	result: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MessageInteractionClaimContext
	extends MessageInteractionBindings {
	reference: string;
	replayKey: string;
	response?: MessageInteractionResponse;
	claimId: string;
	now: number;
	claimTtlMs: number;
}

export type MessageInteractionClaimResult =
	| { status: "acquired" | "resumed"; session: MessageInteractionSession }
	| { status: "in_progress"; session: MessageInteractionSession }
	| {
			status: "replay";
			session: MessageInteractionSession;
			receipt: MessageInteractionReceipt;
	  };

export interface MessageInteractionCompleteContext {
	reference: string;
	claimId: string;
	replayKey: string;
	receipt: MessageInteractionReceipt;
	now: number;
}

export interface MessageInteractionCommitContext {
	reference: string;
	claimId: string;
	replayKey: string;
	now: number;
}

/**
 * Storage transaction boundary. Implementations must make every method atomic;
 * a distributed implementation maps these operations to one row transaction.
 */
export interface MessageInteractionSessionStore {
	create(session: MessageInteractionSession): Promise<void>;
	get(reference: string): Promise<MessageInteractionSession | null>;
	claimIfCurrent(
		context: MessageInteractionClaimContext,
	): Promise<MessageInteractionClaimResult>;
	commitIfClaimed(
		context: MessageInteractionCommitContext,
	): Promise<MessageInteractionSession>;
	completeIfClaimed(
		context: MessageInteractionCompleteContext,
	): Promise<MessageInteractionSession>;
	revokeAuthorization(args: {
		reference: string;
		decisionId: string;
		now: number;
	}): Promise<MessageInteractionSession>;
	deleteExpired(before: number): Promise<number>;
}

export interface MessageInteractionEffectExecutor {
	/**
	 * Executes only after the host durably commits the replay key. A crash after
	 * commit is permanently ambiguous and is never automatically re-executed.
	 */
	execute(args: {
		idempotencyKey: string;
		effect: MessageInteractionEffect;
		response: MessageInteractionResponse;
		session: MessageInteractionSession;
	}): Promise<MessageInteractionReceipt>;
}

function fail(
	code: string,
	message: string,
	context?: Record<string, unknown>,
): never {
	throw new ElizaError(message, { code, context });
}

function requiredText(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized || new TextEncoder().encode(normalized).length > 512) {
		return fail("INVALID_MESSAGE_INTERACTION_SESSION", `${path} is invalid.`, {
			path,
		});
	}
	return normalized;
}

function validClock(value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > 8_640_000_000_000_000
	) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_CLOCK",
			"Trusted clock is invalid.",
		);
	}
	return value;
}

function parseCanonicalIso(value: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		return Number.NaN;
	}
	return parsed;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function responseDigest(response: MessageInteractionResponse): string {
	return hex(
		sha256(
			new TextEncoder().encode(
				`elizaos:message-interaction-response:v1\n${stableStringify(response)}`,
			),
		),
	);
}

function sameBindings(
	a: MessageInteractionBindings,
	b: MessageInteractionBindings,
): boolean {
	return stableStringify(a) === stableStringify(b);
}

function cloneSession(
	session: MessageInteractionSession,
): MessageInteractionSession {
	return structuredClone(session);
}

/** Create a short opaque callback reference with no embedded authority or data. */
export function createOpaqueMessageInteractionReference(
	random: (size: number) => Uint8Array = (size) => {
		const bytes = new Uint8Array(new ArrayBuffer(size));
		globalThis.crypto.getRandomValues(bytes);
		return bytes;
	},
): string {
	return hex(random(16));
}

export function encodeMessageInteractionCallback(reference: string): string {
	if (!/^[a-f0-9]{32}$/.test(reference)) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_REFERENCE",
			"Interaction reference must be a 128-bit opaque token.",
		);
	}
	return `${MESSAGE_INTERACTION_CALLBACK_PREFIX}${reference}`;
}

export function decodeMessageInteractionCallback(
	value: unknown,
): string | null {
	if (typeof value !== "string" || !/^is1:[a-f0-9]{32}$/.test(value)) {
		return null;
	}
	return value.slice(MESSAGE_INTERACTION_CALLBACK_PREFIX.length);
}

function schemaField(
	field: InteractionField,
	maxTextResponseBytes?: number,
): MessageInteractionResponseField {
	const maxBytes =
		field.type === "text" ||
		field.type === "select" ||
		field.type === "date" ||
		field.type === "time" ||
		field.type === "datetime"
			? Math.min(
					field.maxBytes ?? Number.POSITIVE_INFINITY,
					maxTextResponseBytes ?? Number.POSITIVE_INFINITY,
				)
			: field.maxBytes;
	return {
		name: field.name,
		type: field.type,
		required: field.required === true,
		...(field.options
			? { options: field.options.map((option) => option.value) }
			: {}),
		...(Number.isFinite(maxBytes) ? { maxBytes } : {}),
		...(field.mimeTypes ? { mimeTypes: [...field.mimeTypes] } : {}),
	};
}

/** Derive the exact accepted response shape from the canonical block. */
export function responseSchemaForInteraction(
	block: InteractionBlock,
	options: { maxTextResponseBytes?: number } = {},
): MessageInteractionResponseSchema {
	switch (block.kind) {
		case "choice":
			return {
				fields: [
					{
						name: "value",
						type: "text",
						required: true,
						...(options.maxTextResponseBytes
							? { maxBytes: options.maxTextResponseBytes }
							: {}),
						...(block.allowCustom
							? {}
							: { options: block.options.map((option) => option.value) }),
					},
				],
				additionalFields: false,
			};
		case "form":
			if (block.fields.some((field) => field.type === "secret")) {
				return fail(
					"INTERACTION_SENSITIVE_FLOW_REQUIRED",
					"Secret fields cannot be persisted in message interaction sessions.",
				);
			}
			return {
				fields: block.fields.map((field) =>
					schemaField(field, options.maxTextResponseBytes),
				),
				additionalFields: false,
			};
		case "followups":
			return {
				fields: [
					{
						name: "value",
						type: "text",
						required: true,
						...(options.maxTextResponseBytes
							? { maxBytes: options.maxTextResponseBytes }
							: {}),
						options: block.options.map((option) => option.payload),
					},
				],
				additionalFields: false,
			};
		case "task":
		case "secret":
			return {
				fields: [
					{ name: "acknowledged", type: "acknowledgement", required: true },
				],
				additionalFields: false,
			};
	}
}

function validateAttachment(
	value: MessageInteractionResponseValue,
	field: MessageInteractionResponseField,
): void {
	if (
		typeof value !== "object" ||
		value === null ||
		!("mediaUrl" in value) ||
		!("mimeType" in value) ||
		!("bytes" in value)
	) {
		fail(
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
			`${field.name} must be a media reference.`,
		);
	}
	const attachment = value as MessageInteractionAttachmentResponse;
	if (!/^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]+$/.test(attachment.mediaUrl)) {
		fail(
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
			`${field.name} has an invalid media capability URL.`,
		);
	}
	if (
		!Number.isSafeInteger(attachment.bytes) ||
		attachment.bytes < 0 ||
		(field.maxBytes !== undefined && attachment.bytes > field.maxBytes)
	) {
		fail(
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
			`${field.name} exceeds its byte limit.`,
		);
	}
	if (field.mimeTypes && !field.mimeTypes.includes(attachment.mimeType)) {
		fail(
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
			`${field.name} has an unsupported MIME type.`,
		);
	}
}

export function validateMessageInteractionResponse(
	value: MessageInteractionResponse,
	schema: MessageInteractionResponseSchema,
): MessageInteractionResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
			"Interaction response must be an object.",
		);
	}
	const allowed = new Map(schema.fields.map((field) => [field.name, field]));
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			return fail(
				"INVALID_MESSAGE_INTERACTION_RESPONSE",
				`Unexpected interaction response field: ${key}.`,
			);
		}
	}
	for (const field of schema.fields) {
		const responseValue = value[field.name];
		if (responseValue === undefined) {
			if (field.required)
				return fail(
					"INVALID_MESSAGE_INTERACTION_RESPONSE",
					`Missing interaction response field: ${field.name}.`,
				);
			continue;
		}
		if (field.type === "file" || field.type === "image") {
			validateAttachment(responseValue, field);
			continue;
		}
		if (field.type === "checkbox" || field.type === "acknowledgement") {
			if (typeof responseValue !== "boolean")
				return fail(
					"INVALID_MESSAGE_INTERACTION_RESPONSE",
					`${field.name} must be boolean.`,
				);
		} else if (field.type === "number") {
			if (typeof responseValue !== "number" || !Number.isFinite(responseValue))
				return fail(
					"INVALID_MESSAGE_INTERACTION_RESPONSE",
					`${field.name} must be a finite number.`,
				);
		} else if (typeof responseValue !== "string") {
			return fail(
				"INVALID_MESSAGE_INTERACTION_RESPONSE",
				`${field.name} must be text.`,
			);
		}
		if (
			typeof responseValue === "string" &&
			field.maxBytes !== undefined &&
			new TextEncoder().encode(responseValue).length > field.maxBytes
		) {
			return fail(
				"INVALID_MESSAGE_INTERACTION_RESPONSE",
				`${field.name} exceeds its UTF-8 byte limit.`,
			);
		}
		if (field.options && !field.options.includes(String(responseValue))) {
			return fail(
				"INVALID_MESSAGE_INTERACTION_RESPONSE",
				`${field.name} is not an allowed option.`,
			);
		}
	}
	return structuredClone(value);
}

function assertCurrentContext(
	session: MessageInteractionSession,
	context: MessageInteractionClaimContext,
	options: { requireActive: boolean } = { requireActive: true },
): MessageInteractionResponse {
	const suppliedBindings: MessageInteractionBindings = {
		actorId: context.actorId,
		audience: context.audience,
		agentId: context.agentId,
		connector: context.connector,
		roomId: context.roomId,
		sourceMessageId: context.sourceMessageId,
	};
	if (!sameBindings(session.bindings, suppliedBindings)) {
		return fail(
			"MESSAGE_INTERACTION_BINDING_MISMATCH",
			"Interaction callback belongs to another actor, audience, agent, account, room, or source message.",
			{ reference: session.reference },
		);
	}
	if (options.requireActive && session.authorization.state !== "active") {
		return fail(
			"MESSAGE_INTERACTION_AUTHORIZATION_REVOKED",
			"Interaction authorization was revoked after render.",
		);
	}
	if (options.requireActive && Date.parse(session.expiresAt) <= context.now) {
		return fail("MESSAGE_INTERACTION_EXPIRED", "Interaction session expired.");
	}
	const response = session.presetResponse ?? context.response;
	if (!response) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
			"Interaction response is required.",
		);
	}
	if (session.presetResponse && context.response) {
		return fail(
			"MESSAGE_INTERACTION_TAMPERED",
			"Preset callbacks cannot override their stored response.",
		);
	}
	return validateMessageInteractionResponse(response, session.responseSchema);
}

/** Pure atomic-transition helper shared by memory, file, and database stores. */
export function applyMessageInteractionClaim(
	sessionValue: MessageInteractionSession,
	context: MessageInteractionClaimContext,
): MessageInteractionClaimResult {
	const session = cloneSession(sessionValue);
	validClock(context.now);
	if (context.reference !== session.reference) {
		return fail(
			"MESSAGE_INTERACTION_REFERENCE_MISMATCH",
			"Interaction claim reference does not match the stored session.",
		);
	}
	requiredText(context.replayKey, "replayKey");
	requiredText(context.claimId, "claimId");
	if (!Number.isSafeInteger(context.claimTtlMs) || context.claimTtlMs < 1) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_CLAIM_TTL",
			"Interaction claim lease must be a positive safe integer.",
		);
	}
	if (context.claimTtlMs > 8_640_000_000_000_000 - context.now) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_CLAIM_TTL",
			"Interaction claim lease exceeds the supported clock range.",
		);
	}
	const response = assertCurrentContext(session, context, {
		requireActive:
			session.consume.state !== "committed" &&
			session.consume.state !== "completed",
	});
	const digest = responseDigest(response);
	if (session.consume.state === "completed") {
		if (
			session.consume.replayKey !== context.replayKey ||
			session.consume.responseDigest !== digest
		) {
			return fail(
				"MESSAGE_INTERACTION_ALREADY_CONSUMED",
				"Interaction was already consumed by another response.",
			);
		}
		return { status: "replay", session, receipt: session.consume.receipt };
	}
	if (session.consume.state === "committed") {
		if (
			session.consume.replayKey !== context.replayKey ||
			session.consume.responseDigest !== digest
		) {
			return fail(
				"MESSAGE_INTERACTION_ALREADY_COMMITTED",
				"Interaction already committed a different response.",
			);
		}
		return { status: "in_progress", session };
	}
	if (session.consume.state === "claimed") {
		if (
			session.consume.replayKey !== context.replayKey ||
			session.consume.responseDigest !== digest
		) {
			return fail(
				"MESSAGE_INTERACTION_ALREADY_CLAIMED",
				"Interaction is claimed by another response.",
			);
		}
		if (Date.parse(session.consume.claimExpiresAt) > context.now) {
			return { status: "in_progress", session };
		}
		session.consume = {
			...session.consume,
			state: "claimed",
			claimId: context.claimId,
			claimedAt: new Date(context.now).toISOString(),
			claimExpiresAt: new Date(context.now + context.claimTtlMs).toISOString(),
			attempt: session.consume.attempt + 1,
		};
		session.revision += 1;
		return { status: "resumed", session };
	}
	session.consume = {
		state: "claimed",
		claimId: context.claimId,
		replayKey: context.replayKey,
		responseDigest: digest,
		response,
		claimedAt: new Date(context.now).toISOString(),
		claimExpiresAt: new Date(context.now + context.claimTtlMs).toISOString(),
		attempt: 1,
	};
	session.revision += 1;
	return { status: "acquired", session };
}

export function applyMessageInteractionCompletion(
	sessionValue: MessageInteractionSession,
	context: MessageInteractionCompleteContext,
): MessageInteractionSession {
	const session = cloneSession(sessionValue);
	validClock(context.now);
	if (context.reference !== session.reference) {
		return fail(
			"MESSAGE_INTERACTION_REFERENCE_MISMATCH",
			"Interaction completion reference does not match the stored session.",
		);
	}
	requiredText(context.claimId, "claimId");
	requiredText(context.replayKey, "replayKey");
	requiredText(context.receipt.receiptId, "receipt.receiptId");
	const receiptCompletedAt = parseCanonicalIso(context.receipt.completedAt);
	if (
		!Number.isFinite(receiptCompletedAt) ||
		receiptCompletedAt > context.now
	) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_RECEIPT",
			"Effect receipt has an invalid or future completion time.",
		);
	}
	if (session.consume.state === "completed") {
		if (
			session.consume.replayKey === context.replayKey &&
			session.consume.receipt.idempotencyKey === context.receipt.idempotencyKey
		)
			return session;
		return fail(
			"MESSAGE_INTERACTION_ALREADY_CONSUMED",
			"A different effect already completed this interaction.",
		);
	}
	if (
		session.consume.state !== "committed" ||
		session.consume.claimId !== context.claimId ||
		session.consume.replayKey !== context.replayKey
	) {
		return fail(
			"MESSAGE_INTERACTION_STALE_CLAIM",
			"Interaction completion does not own the current claim.",
		);
	}
	if (
		context.receipt.idempotencyKey !== context.replayKey ||
		context.receipt.status !== "completed"
	) {
		return fail(
			"INVALID_MESSAGE_INTERACTION_RECEIPT",
			"Effect receipt does not bind the replay key.",
		);
	}
	session.consume = {
		state: "completed",
		claimId: session.consume.claimId,
		replayKey: session.consume.replayKey,
		responseDigest: session.consume.responseDigest,
		response: session.consume.response,
		claimedAt: session.consume.claimedAt,
		committedAt: session.consume.committedAt,
		completedAt: new Date(context.now).toISOString(),
		attempt: session.consume.attempt,
		receipt: structuredClone(context.receipt),
	};
	session.revision += 1;
	return session;
}

/** Durably linearize one effect before crossing the external side-effect boundary. */
export function applyMessageInteractionCommit(
	sessionValue: MessageInteractionSession,
	context: MessageInteractionCommitContext,
): MessageInteractionSession {
	const session = cloneSession(sessionValue);
	validClock(context.now);
	if (
		session.reference !== context.reference ||
		session.consume.state !== "claimed" ||
		session.consume.claimId !== context.claimId ||
		session.consume.replayKey !== context.replayKey
	) {
		return fail(
			"MESSAGE_INTERACTION_STALE_CLAIM",
			"Interaction effect commitment does not own the current claim.",
		);
	}
	if (session.authorization.state !== "active") {
		return fail(
			"MESSAGE_INTERACTION_AUTHORIZATION_REVOKED",
			"Interaction authorization was revoked before effect commitment.",
		);
	}
	session.consume = {
		state: "committed",
		claimId: session.consume.claimId,
		replayKey: session.consume.replayKey,
		responseDigest: session.consume.responseDigest,
		response: session.consume.response,
		claimedAt: session.consume.claimedAt,
		committedAt: new Date(context.now).toISOString(),
		attempt: session.consume.attempt,
	};
	session.revision += 1;
	return session;
}

export function applyMessageInteractionRevocation(
	sessionValue: MessageInteractionSession,
	decisionId: string,
	now: number,
): MessageInteractionSession {
	const session = cloneSession(sessionValue);
	if (session.authorization.decisionId !== decisionId) {
		return fail(
			"MESSAGE_INTERACTION_AUTHORIZATION_MISMATCH",
			"Authorization decision does not match this session.",
		);
	}
	if (session.authorization.state === "revoked") return session;
	if (session.consume.state === "committed") {
		return fail(
			"MESSAGE_INTERACTION_EFFECT_COMMITTED",
			"Interaction revocation is pending an already committed effect outcome.",
		);
	}
	session.authorization = {
		...session.authorization,
		state: "revoked",
		revokedAt: new Date(validClock(now)).toISOString(),
	};
	session.revision += 1;
	return session;
}

/** Process-local reference store used by deterministic tests and embedded hosts. */
export class InMemoryMessageInteractionSessionStore
	implements MessageInteractionSessionStore
{
	private readonly sessions = new Map<string, MessageInteractionSession>();
	private queue: Promise<void> = Promise.resolve();

	private async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
		let release: () => void = () => undefined;
		const previous = this.queue;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async create(session: MessageInteractionSession): Promise<void> {
		await this.atomic(() => {
			if (this.sessions.has(session.reference))
				return fail(
					"MESSAGE_INTERACTION_REFERENCE_COLLISION",
					"Interaction reference already exists.",
				);
			this.sessions.set(session.reference, cloneSession(session));
		});
	}

	async get(reference: string): Promise<MessageInteractionSession | null> {
		return this.atomic(() => {
			const session = this.sessions.get(reference);
			return session ? cloneSession(session) : null;
		});
	}

	async claimIfCurrent(
		context: MessageInteractionClaimContext,
	): Promise<MessageInteractionClaimResult> {
		return this.atomic(() => {
			const current = this.sessions.get(context.reference);
			if (!current)
				return fail(
					"MESSAGE_INTERACTION_NOT_FOUND",
					"Interaction session was not found.",
				);
			const result = applyMessageInteractionClaim(current, context);
			this.sessions.set(context.reference, cloneSession(result.session));
			return result;
		});
	}

	async completeIfClaimed(
		context: MessageInteractionCompleteContext,
	): Promise<MessageInteractionSession> {
		return this.atomic(() => {
			const current = this.sessions.get(context.reference);
			if (!current)
				return fail(
					"MESSAGE_INTERACTION_NOT_FOUND",
					"Interaction session was not found.",
				);
			const completed = applyMessageInteractionCompletion(current, context);
			this.sessions.set(context.reference, cloneSession(completed));
			return completed;
		});
	}

	async commitIfClaimed(
		context: MessageInteractionCommitContext,
	): Promise<MessageInteractionSession> {
		return this.atomic(() => {
			const current = this.sessions.get(context.reference);
			if (!current)
				return fail(
					"MESSAGE_INTERACTION_NOT_FOUND",
					"Interaction session was not found.",
				);
			const committed = applyMessageInteractionCommit(current, context);
			this.sessions.set(context.reference, cloneSession(committed));
			return committed;
		});
	}

	async revokeAuthorization(args: {
		reference: string;
		decisionId: string;
		now: number;
	}): Promise<MessageInteractionSession> {
		return this.atomic(() => {
			const current = this.sessions.get(args.reference);
			if (!current)
				return fail(
					"MESSAGE_INTERACTION_NOT_FOUND",
					"Interaction session was not found.",
				);
			const revoked = applyMessageInteractionRevocation(
				current,
				args.decisionId,
				args.now,
			);
			this.sessions.set(args.reference, cloneSession(revoked));
			return revoked;
		});
	}

	async deleteExpired(before: number): Promise<number> {
		validClock(before);
		return this.atomic(() => {
			let deleted = 0;
			for (const [reference, session] of this.sessions) {
				if (
					Date.parse(session.expiresAt) <= before &&
					session.consume.state !== "committed" &&
					session.consume.state !== "completed"
				) {
					this.sessions.delete(reference);
					deleted += 1;
				}
			}
			return deleted;
		});
	}
}

export class MessageInteractionSessionAuthority {
	constructor(
		private readonly store: MessageInteractionSessionStore,
		private readonly options: {
			clock?: () => number;
			referenceFactory?: () => string;
			claimTtlMs?: number;
		} = {},
	) {}

	private now(): number {
		return validClock(this.options.clock?.() ?? Date.now());
	}

	async create(args: {
		block: InteractionBlock;
		profile: ConnectorInteractionCapabilityProfile;
		bindings: MessageInteractionBindings;
		purpose: MessageInteractionPurpose;
		flow: MessageInteractionFlow;
		negotiationContext?: InteractionNegotiationContext;
		presetResponse?: MessageInteractionResponse;
		authorization: Omit<
			MessageInteractionAuthorizationDecision,
			"state" | "revokedAt"
		>;
		effect: MessageInteractionEffect;
		expiresAt: string;
	}): Promise<{ session: MessageInteractionSession; callbackData: string }> {
		const now = this.now();
		const profile = normalizeConnectorInteractionCapabilityProfile(
			args.profile,
		);
		if (
			profile.connector.source !== args.bindings.connector.source ||
			profile.connector.accountId !== args.bindings.connector.accountId ||
			profile.target.kind !== args.bindings.audience.kind ||
			profile.target.id !== args.bindings.audience.id
		)
			return fail(
				"MESSAGE_INTERACTION_PROFILE_BINDING_MISMATCH",
				"Capability profile belongs to another account or target.",
			);
		const expiry = parseCanonicalIso(args.expiresAt);
		if (
			!Number.isFinite(expiry) ||
			expiry <= now ||
			expiry - now > profile.blocks[args.block.kind].maxSessionTtlMs
		) {
			return fail(
				"INVALID_MESSAGE_INTERACTION_EXPIRY",
				"Interaction expiry exceeds negotiated capability.",
			);
		}
		if (args.block.kind === "secret" && args.flow !== "sensitive-request") {
			return fail(
				"INTERACTION_SENSITIVE_FLOW_REQUIRED",
				"Secret/OAuth interactions require the sensitive-request flow.",
			);
		}
		if (args.block.kind !== "secret" && args.flow === "sensitive-request") {
			return fail(
				"INVALID_MESSAGE_INTERACTION_FLOW",
				"Ordinary interactions cannot use the sensitive-request flow.",
			);
		}
		const delivery = negotiateInteractionDelivery(args.block, profile, {
			...args.negotiationContext,
			callbackBytes: MESSAGE_INTERACTION_CALLBACK_BYTES,
		});
		if (delivery.mode !== args.flow) {
			return fail(
				"INTERACTION_FLOW_NOT_NEGOTIATED",
				"Interaction flow does not match the negotiated delivery for this payload.",
				{
					requested: args.flow,
					negotiated: delivery.mode,
					limitations: delivery.limitations,
				},
			);
		}
		if (args.purpose === "auth" && args.block.kind !== "secret") {
			return fail(
				"INTERACTION_SENSITIVE_FLOW_REQUIRED",
				"Authentication input must use a dedicated sensitive request.",
			);
		}
		const reference =
			this.options.referenceFactory?.() ??
			createOpaqueMessageInteractionReference();
		encodeMessageInteractionCallback(reference);
		const schema = responseSchemaForInteraction(args.block, {
			maxTextResponseBytes: profile.limits.text.maxMessageBytes,
		});
		const presetResponse = args.presetResponse
			? validateMessageInteractionResponse(args.presetResponse, schema)
			: null;
		const session: MessageInteractionSession = {
			sessionVersion: MESSAGE_INTERACTION_SESSION_VERSION,
			reference,
			purpose: args.purpose,
			blockKind: args.block.kind,
			flow: args.flow,
			profileId: profile.profileId,
			bindings: structuredClone(args.bindings),
			responseSchema: schema,
			presetResponse,
			authorization: {
				...args.authorization,
				state: "active",
				revokedAt: null,
			},
			effect: structuredClone(args.effect),
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(expiry).toISOString(),
			consume: { state: "pending" },
			revision: 0,
		};
		const authorizationTime = parseCanonicalIso(
			session.authorization.decidedAt,
		);
		if (!Number.isFinite(authorizationTime) || authorizationTime > now) {
			return fail(
				"INVALID_MESSAGE_INTERACTION_AUTHORIZATION",
				"Authorization decision time is invalid.",
			);
		}
		for (const [path, value] of Object.entries({
			...session.bindings,
			audienceKind: session.bindings.audience.kind,
			audienceId: session.bindings.audience.id,
			connectorSource: session.bindings.connector.source,
			connectorAccountId: session.bindings.connector.accountId,
			authorizationDecisionId: session.authorization.decisionId,
			policyRevision: session.authorization.policyRevision,
			effectKind: session.effect.kind,
		}))
			if (typeof value === "string") requiredText(value, path);
		if (
			/secret|token|password|oauth.*code|api.?key/i.test(
				stableStringify(session.effect.metadata ?? {}),
			)
		) {
			return fail(
				"MESSAGE_INTERACTION_SECRET_FORBIDDEN",
				"Interaction effect metadata appears to contain secret material.",
			);
		}
		await this.store.create(session);
		return {
			session: cloneSession(session),
			callbackData: encodeMessageInteractionCallback(reference),
		};
	}

	async consume(args: {
		callbackData: string;
		bindings: MessageInteractionBindings;
		replayKey: string;
		response?: MessageInteractionResponse;
		executor: MessageInteractionEffectExecutor;
	}): Promise<MessageInteractionReceipt | { status: "in_progress" }> {
		const reference = decodeMessageInteractionCallback(args.callbackData);
		if (!reference)
			return fail(
				"INVALID_MESSAGE_INTERACTION_REFERENCE",
				"Callback is not an opaque interaction reference.",
			);
		const now = this.now();
		const replayKey = requiredText(args.replayKey, "replayKey");
		const claimId = createOpaqueMessageInteractionReference();
		const claim = await this.store.claimIfCurrent({
			...args.bindings,
			reference,
			replayKey,
			response: args.response,
			claimId,
			now,
			claimTtlMs: this.options.claimTtlMs ?? 30_000,
		});
		if (claim.status === "replay") return claim.receipt;
		if (claim.status === "in_progress") return { status: "in_progress" };
		if (claim.session.consume.state !== "claimed")
			return fail(
				"MESSAGE_INTERACTION_STORE_PROTOCOL",
				"Store returned an unclaimed session.",
			);
		const committed = await this.store.commitIfClaimed({
			reference,
			claimId: claim.session.consume.claimId,
			replayKey,
			now: this.now(),
		});
		if (committed.consume.state !== "committed")
			return fail(
				"MESSAGE_INTERACTION_STORE_PROTOCOL",
				"Store did not retain the effect commitment.",
			);
		const receipt = await args.executor.execute({
			idempotencyKey: replayKey,
			effect: committed.effect,
			response: committed.consume.response,
			session: committed,
		});
		const completed = await this.store.completeIfClaimed({
			reference,
			claimId: claim.session.consume.claimId,
			replayKey,
			receipt,
			now: this.now(),
		});
		if (completed.consume.state !== "completed")
			return fail(
				"MESSAGE_INTERACTION_STORE_PROTOCOL",
				"Store did not retain the completion receipt.",
			);
		return completed.consume.receipt;
	}
}
