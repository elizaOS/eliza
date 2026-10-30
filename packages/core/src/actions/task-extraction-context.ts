/** Request-bound task extraction view of the planner's reviewed originals.
 * Complete state and source events stay intact. This capability is process-local;
 * serialized/cloned provider data never grants source-selection authority. */

import { getAmbientSingleton } from "../ambient-context";
import {
	completionContextSources,
	selectHistoricalNavigation,
} from "../runtime/completion-context";
import { hashStableJson } from "../runtime/context-hash";
import type { ContextObject } from "../runtime/context-object";
import { renderContextObject, segmentBlock } from "../runtime/context-renderer";
import { compactHistoricalReceiptSegments } from "../runtime/historical-receipt-wire";
import { projectDeferredProviders } from "../runtime/provider-context";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";

export type RequestOperationClassification = "read_only" | "mutation_requested" | "unresolved";
export type RequestOperationRuntime = { readonly agentId: string };
type Binding = {
	original: ContextObject;
	projected: ContextObject;
	sourceHash: string;
	projectionHash: string;
	requestHash: string;
	stateHash: string;
	extractionProjectionAuthorized: boolean;
	issuer?: RequestOperationIssuer;
};
const key = Symbol.for("eliza.task-extraction-context");
const bindings = () =>
	getAmbientSingleton(key, () => new WeakMap<object, Binding>());
const stateFingerprint = (state: State) =>
	hashStableJson({
		text: state.text,
		recentMessages: state.values.recentMessages,
		selectedActionConversation: state.values.selectedActionConversation,
		data: state.data,
	});

/** Called only by the planner action boundary after its existing validators. */
export function bindTaskExtractionContext(
	state: State,
	message: Memory,
	original: ContextObject,
	projected: ContextObject,
	runtime?: RequestOperationRuntime,
	issuer?: RequestOperationIssuer,
): void {
	if (state.data) bindings().delete(state.data);
	if (
		!state.data ||
		!message.id ||
		!message.roomId ||
		!message.entityId ||
		original.metadata?.messageId !== message.id ||
		original.metadata?.roomId !== message.roomId
	)
		return;
	try {
		const sources = completionContextSources(original).sources;
		const sourceIds = new Set(sources.map(({ event }) => event.id));
		const included = new Set(
			projected.events
				.filter((event) => sourceIds.has(event.id))
				.map((event) => event.id),
		);
		// Exact full views bind current decision metadata without granting an
		// extraction projection; only the existing partial-history rule can do so.
		const extractionProjectionAuthorized =
			sources.length > 0 && included.size !== sources.length;
		// A producer may remove only reviewed dialogue and its unambiguously bound
		// historical evidence. Current providers, instructions and effects stay exact.
		const expected = extractionProjectionAuthorized
			? {
					...original,
					events: selectHistoricalNavigation(original, included).events.filter(
						(event) => !sourceIds.has(event.id) || included.has(event.id),
					),
				}
			: original;
		if (hashStableJson(expected) !== hashStableJson(projected)) return;
		bindings().set(state.data, {
			original,
			projected,
			sourceHash: hashStableJson(original),
			projectionHash: hashStableJson(projected),
			requestHash: hashStableJson(message),
			stateHash: stateFingerprint(state),
			extractionProjectionAuthorized,
			...(runtime && issuer && validIssuer(issuer, runtime, message) ? { issuer } : {}),
		});
	} catch {
		// Invalid optional projection cannot remove any extractor context.
	}
}

function readBinding(
	state: State | undefined,
	message: Memory | undefined,
): Binding | undefined {
	if (!state?.data || !message) return undefined;
	const binding = bindings().get(state.data);
	if (!binding) return undefined;
	try {
		if (
			binding.requestHash !== hashStableJson(message) ||
			binding.stateHash !== stateFingerprint(state) ||
			binding.sourceHash !== hashStableJson(binding.original) ||
			binding.projectionHash !== hashStableJson(binding.projected)
		)
			return undefined;
		return binding;
	} catch {
		return undefined;
	}
}

/** Current Stage-1 intent evidence from the same unmodified request capability.
 * Missing, cloned or changed bindings grant no foreground ownership authority. */
export function readTaskExtractionRequestIntents(
	state: State | undefined,
	message: Memory | undefined,
): readonly string[] | undefined {
	const binding = readBinding(state, message);
	if (!binding) return undefined;
	const events = binding.original.events.filter(
		(event) =>
			event.type === "message_handler" && event.source === "message-service",
	);
	if (events.length !== 1 || events[0].metadata?.processMessage !== "RESPOND")
		return undefined;
	const plan = events[0].metadata?.plan;
	if (!plan || typeof plan !== "object" || Array.isArray(plan))
		return undefined;
	const intents = plan.intents;
	if (
		!Array.isArray(intents) ||
		!intents.length ||
		!intents.every(
			(intent) => typeof intent === "string" && intent.trim().length > 0,
		)
	)
		return undefined;
	return [...intents] as string[];
}

/** Routing clones State.values but preserves State.data; copied JSON cannot
 * inherit this capability. Changed source/actor/request/state falls back to full. */
export function readTaskExtractionContext(
	state: State | undefined,
	message: Memory | undefined,
	expectedSystem?: string,
): { text: string; originalText: string; system?: string } | undefined {
	const binding = readBinding(state, message);
	if (!binding?.extractionProjectionAuthorized) return undefined;
	try {
		// Keep the trusted canonical prefix on the model's system surface once,
		// rather than flattening it into user context and adding it again at dispatch.
		// Originals, style directions, other instructions, providers and receipts
		// stay intact in the bound source. Only an authorized provider-owned notice
		// may defer its body below; this is not text-based dialogue deduplication.
		const system = binding.original.staticPrefix?.systemPrompt?.content;
		// A different live persona/role must retain the existing full context;
		// never replace the dispatcher's current authority with a stale prefix.
		const separateSystem =
			typeof system === "string" &&
			system.trim().length > 0 &&
			system === expectedSystem;
		const render = (context: ContextObject) =>
			renderContextObject(
				separateSystem
					? {
							...context,
							staticPrefix: {
								...context.staticPrefix,
								systemPrompt: undefined,
							},
						}
					: context,
			);
		// Reuse the planner's authorized, provider-owned deferred view. Standing
		// constraints stay in its notice; loaded/unknown providers stay complete.
		// The unchanged original remains the full pre-effect restoration source.
		const rendered = render(
			projectDeferredProviders(binding.projected).context,
		);
		return {
			text: compactHistoricalReceiptSegments(rendered.promptSegments)
				.map(segmentBlock)
				.join("\n\n"),
			originalText: render(binding.original)
				.promptSegments.map(segmentBlock)
				.join("\n\n"),
			...(separateSystem ? { system } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Original user sources from the existing request-bound selection capability.
 * Full/current-only bindings remain valid; cloned or changed state grants none. */
export function readTaskExtractionUserSources(
	state: State | undefined,
	message: Memory | undefined,
): readonly { id: string; text: string }[] | undefined {
	const binding = readBinding(state, message);
	if (!binding || !message) return undefined;
	return completionContextSources(binding.projected).sources.flatMap(
		({ event }) => {
			if (event.type !== "segment" || event.source !== "prior-dialogue")
				return [];
			const segment = event.segment;
			if (
				segment.label !== "prior_message:user" ||
				segment.id !== event.id ||
				segment.metadata?.roomId !== message.roomId ||
				segment.metadata?.entityId !== message.entityId
			)
				return [];
			const speaker = segment.metadata.speakerName;
			const prefix = typeof speaker === "string" ? `${speaker}: ` : "";
			return [
				{
					id: event.id,
					text:
						prefix && segment.content.startsWith(prefix)
							? segment.content.slice(prefix.length)
							: segment.content,
				},
			];
		},
	);
}

// Only the current host request producer owns these opaque process-local tokens.
// JSON plans, resumed objects, and an object shaped like a runtime are not issuer proof.
declare const issuerBrand: unique symbol;
declare const attemptBrand: unique symbol;
export interface RequestOperationIssuer { readonly [issuerBrand]: true }
export interface BoundRequestOperationAttempt { readonly [attemptBrand]: true }
export type NotesRequestOperation = "get" | "list" | "create" | "update" | "patch" | "delete";
type Issuer = {
	runtime: RequestOperationRuntime; message: Memory; current: () => boolean;
	agentId: string; messageId: string; roomId: string; entityId: string; requestHash: string;
	classification: RequestOperationClassification; committed: boolean; tainted: boolean; revision: number;
	source?: unknown; sourceHash?: string; currentSource?: () => unknown;
};
type Attempt = { issuer: RequestOperationIssuer; revision: number; state: State; message: Memory;
	resolved?: NotesRequestOperation; conflicted: boolean };
type Denial = { attempt: BoundRequestOperationAttempt; operation: NotesRequestOperation;
	classification: RequestOperationClassification; kind: "decision" | "error" | "result" };
const issuerKey = Symbol.for("eliza.request-operation-issuers");
const activeIssuerKey = Symbol.for("eliza.request-operation-active-issuers");
const attemptKey = Symbol.for("eliza.request-operation-attempts");
const denialKey = Symbol.for("eliza.request-operation-denials");
const resultAttemptKey = Symbol.for("eliza.request-operation-result-attempts");
const issuers = () => getAmbientSingleton(issuerKey, () => new WeakMap<object, Issuer>());
const activeIssuers = () => getAmbientSingleton(activeIssuerKey, () => new WeakMap<object, WeakMap<object, RequestOperationIssuer>>());
const attempts = () => getAmbientSingleton(attemptKey, () => new WeakMap<object, Attempt>());
const denials = () => getAmbientSingleton(denialKey, () => new WeakMap<object, Denial>());
const resultAttempts = () => getAmbientSingleton(resultAttemptKey, () => new WeakMap<object, BoundRequestOperationAttempt>());

function validIssuer(token: unknown, runtime?: RequestOperationRuntime, message?: Memory): Issuer | undefined {
	if (!token || typeof token !== "object") return;
	const value = issuers().get(token);
	if (!value || (runtime && value.runtime !== runtime) || (message && value.message !== message)) return;
	try {
		if (activeIssuers().get(value.runtime)?.get(value.message) !== token || !value.current() ||
			value.runtime.agentId !== value.agentId || value.message.id !== value.messageId ||
			value.message.roomId !== value.roomId || value.message.entityId !== value.entityId ||
			value.message.agentId !== value.agentId || hashStableJson(value.message) !== value.requestHash) return;
		// This is the immutable same-call classification input, NOT a later tool's
		// provider/state/extraction view. Legitimate tool results and provider refreshes
		// do not replace it; altered original request sources still invalidate it.
		if (value.committed && value.currentSource &&
			(hashStableJson(value.currentSource()) !== value.sourceHash || hashStableJson(value.source) !== value.sourceHash)) return;
		return value;
	} catch { return; }
}
/** Host entry only: call before the same Stage-1 classification, with its live abort/owner guard.
 * Re-entry for the same actual request returns the original issuer and cannot reset its latch. */
export function beginRequestOperationIssuer(input: {
	runtime: RequestOperationRuntime; message: Memory; current: () => boolean;
}): RequestOperationIssuer | undefined {
	const { runtime, message, current } = input;
	if (!runtime || typeof runtime !== "object" || typeof current !== "function" ||
		!message.id || !message.roomId || !message.entityId || runtime.agentId !== message.agentId) return;
	try {
		if (!current()) return;
		let rooms = activeIssuers().get(runtime);
		if (!rooms) { rooms = new WeakMap(); activeIssuers().set(runtime, rooms); }
		const previous = rooms.get(message);
		const old = previous && issuers().get(previous);
		if (old) return validIssuer(previous, runtime, message) ? previous : undefined;
		const token = Object.freeze(Object.create(null)) as RequestOperationIssuer;
		issuers().set(token, { runtime, message, current, agentId: runtime.agentId, messageId: message.id,
			roomId: message.roomId, entityId: message.entityId, requestHash: hashStableJson(message),
			classification: "unresolved", committed: false, tainted: false, revision: 0 });
		rooms.set(message, token);
		return token;
	} catch { return; }
}
/** Getter cannot mint authority, reconstruct serialized state, or reset a restriction. */
export function getRequestOperationIssuer(runtime: RequestOperationRuntime, message: Memory): RequestOperationIssuer | undefined {
	const token = activeIssuers().get(runtime)?.get(message);
	return token && validIssuer(token, runtime, message) ? token : undefined;
}
/** Same-call validated field producer only, AFTER its active/parsed/handled trace checks.
 * The source/currentSource port is the owned immutable Stage-1 input, never planner JSON.
 * A contradictory second commit permanently fails closed for this issuer. */
export function commitNotesRequestRestriction(token: RequestOperationIssuer, input: {
	classification: unknown; source: unknown; currentSource: () => unknown;
}): boolean {
	const value = validIssuer(token);
	if (!value || typeof input.currentSource !== "function") return false;
	try {
		const classification = input.classification === "read_only" || input.classification === "mutation_requested"
			? input.classification : "unresolved";
		const sourceHash = hashStableJson(input.source);
		if (hashStableJson(input.currentSource()) !== sourceHash) return false;
		if (value.committed) {
			if (value.tainted || value.classification !== classification || value.sourceHash !== sourceHash) {
				value.tainted = true; value.classification = "unresolved"; value.revision++; return false;
			}
			return true;
		}
		value.classification = classification; value.source = input.source; value.sourceHash = sourceHash;
		value.currentSource = input.currentSource; value.committed = true; value.revision++;
		return true;
	} catch { return false; }
}
export function readTaskExtractionNotesRestriction(state: State | undefined, message: Memory | undefined,
	runtime?: RequestOperationRuntime): RequestOperationClassification {
	const binding = readBinding(state, message);
	const value = binding?.issuer && validIssuer(binding.issuer, runtime, message);
	return value?.committed && !value.tainted ? value.classification : "unresolved";
}
/** Mint at the host execution boundary, not from a tool-call ID/arguments. */
export function beginRequestOperationAttempt(input: {
	runtime: RequestOperationRuntime; state: State; message: Memory;
}): BoundRequestOperationAttempt | undefined {
	const binding = readBinding(input.state, input.message);
	const value = binding?.issuer && validIssuer(binding.issuer, input.runtime, input.message);
	if (!value?.committed || !binding?.issuer) return;
	const token = Object.freeze(Object.create(null)) as BoundRequestOperationAttempt;
	attempts().set(token, { issuer: binding.issuer, revision: value.revision,
		state: input.state, message: input.message, conflicted: false });
	return token;
}
function currentAttempt(token: unknown): Attempt | undefined {
	if (!token || typeof token !== "object") return;
	const attempt = attempts().get(token);
	const value = attempt && validIssuer(attempt.issuer);
	return attempt && value && !attempt.conflicted && value.revision === attempt.revision ? attempt : undefined;
}
export type BoundOperationDecision = { readonly allowed: true; readonly addsAuthority: false } |
	{ readonly allowed: false; readonly addsAuthority: false; readonly code: "REQUEST_OPERATION_RESTRICTED" | "REQUEST_OPERATION_UNRESOLVED";
		readonly executionStatus: "not_started" };
export function checkBoundNotesOperation(state: State | undefined, message: Memory | undefined,
	operation: NotesRequestOperation, token?: BoundRequestOperationAttempt): BoundOperationDecision {
	const recognized = operation === "get" || operation === "list" || operation === "create" || operation === "update" || operation === "patch" || operation === "delete";
	// An observation never fixes or changes the mutation identity of this host
	// action. A compound view action may read before its one resolved mutation,
	// and a later read cannot erase a settled denied mutation.
	if (recognized && (operation === "get" || operation === "list")) return { allowed: true, addsAuthority: false };
	const attempt = currentAttempt(token), binding = readBinding(state, message);
	const same = attempt && attempt.message === message && binding?.issuer === attempt.issuer;
	if (attempt && same && recognized) {
		if (attempt.resolved && attempt.resolved !== operation) attempt.conflicted = true;
		else attempt.resolved = operation;
	}
	const classification = attempt && same && !attempt.conflicted && recognized
		? readTaskExtractionNotesRestriction(state, message) : "unresolved";
	if (classification === "mutation_requested") return { allowed: true, addsAuthority: false };
	const decision: BoundOperationDecision = Object.freeze({ allowed: false, addsAuthority: false,
		code: classification === "read_only" ? "REQUEST_OPERATION_RESTRICTED" : "REQUEST_OPERATION_UNRESOLVED", executionStatus: "not_started" });
	if (attempt && same && !attempt.conflicted && recognized && token) {
		denials().set(decision, { attempt: token, operation, classification, kind: "decision" });
	}
	return decision;
}
function unknownOutcomeMarker(source: object): boolean {
	const row = source as { outcomeUnknown?: unknown; reconciliationRequired?: unknown; data?: Record<string, unknown> };
	return [row.outcomeUnknown, row.reconciliationRequired, row.data?.outcomeUnknown, row.data?.reconciliationRequired]
		.some(value => value !== undefined && value !== false);
}
function currentDenial(source: object): Denial | undefined {
	if (unknownOutcomeMarker(source)) return undefined;
	const proof = denials().get(source), attempt = proof && currentAttempt(proof.attempt);
	if (!proof || !attempt || attempt.resolved !== proof.operation || proof.operation === "get" || proof.operation === "list") return;
	const value = validIssuer(attempt.issuer);
	return value?.classification === proof.classification && value.committed ? proof : undefined;
}
function notStartedFailure(result: object, proof: Denial): boolean {
	if (unknownOutcomeMarker(result)) return false;
	const row = result as { success?: unknown; data?: Record<string, unknown>; effectReceipts?: unknown; receipt?: unknown; effects?: unknown };
	const code = proof.classification === "read_only" ? "REQUEST_OPERATION_RESTRICTED" : "REQUEST_OPERATION_UNRESOLVED";
	if (row.success !== false || row.data?.code !== code || row.data.executionStatus !== "not_started" || row.data.executed !== false) return false;
	return [row.effectReceipts, row.effects, row.data.effectReceipts, row.data.effects].every(value => value === undefined || (Array.isArray(value) && value.length === 0)) &&
		row.receipt === undefined && row.data.receipt === undefined;
}
export class BoundRequestOperationError extends Error {
	readonly code: "REQUEST_OPERATION_RESTRICTED" | "REQUEST_OPERATION_UNRESOLVED";
	readonly executionStatus = "not_started" as const;
	constructor(decision: Extract<BoundOperationDecision, { allowed: false }>) {
		const proof = currentDenial(decision);
		super(proof?.classification === "read_only" ? "Operation denied by the current read-only request constraint." : "The current request operation is unresolved.");
		this.name = "BoundRequestOperationError";
		this.code = proof?.classification === "read_only" ? "REQUEST_OPERATION_RESTRICTED" : "REQUEST_OPERATION_UNRESOLVED";
		if (proof) denials().set(this, { ...proof, kind: "error" });
	}
}
/** All owned results are associated with the actual execution attempt before projection. */
export function bindRequestOperationResult(result: object, token: BoundRequestOperationAttempt): boolean {
	if (!currentAttempt(token)) return false;
	const previous = resultAttempts().get(result);
	if (previous && previous !== token) return false;
	resultAttempts().set(result, token); return true;
}
/** Owned failure projection only. Require BOTH actual expected attempt and target ownership;
 * raw clones, success/applied/unknown results and other attempts cannot receive denial proof. */
export function transferBoundOperationDenial(source: object, target: object, expectedAttempt: BoundRequestOperationAttempt): boolean {
	const proof = currentDenial(source);
	if (!proof || proof.attempt !== expectedAttempt || resultAttempts().get(target) !== expectedAttempt ||
		!notStartedFailure(target, proof) || (proof.kind === "result" && !notStartedFailure(source, proof))) return false;
	denials().set(target, { ...proof, kind: "result" }); return true;
}
/** Owned decision/error catches need the opaque attempt for their first failure projection.
 * Results additionally require exact failure/zero-effect shape and host attempt ownership. */
export function getBoundOperationDenialAttempt(result: object): BoundRequestOperationAttempt | undefined {
	const proof = currentDenial(result);
	if (!proof) return undefined;
	if (proof.kind === "result" && (resultAttempts().get(result) !== proof.attempt || !notStartedFailure(result, proof))) return undefined;
	return proof.attempt;
}
/** This excludes ONE invented failed attempt, never proves original-request completion. */
export function isVerifiedOutsideRequestDenial(result: object, current: {
	messageId: string; roomId: string; entityId?: string; agentId?: string;
	attempt: BoundRequestOperationAttempt; operation: NotesRequestOperation;
}): boolean {
	const proof = currentDenial(result), attempt = proof && currentAttempt(proof.attempt);
	const value = attempt && validIssuer(attempt.issuer);
	return !!proof && !!value && proof.kind === "result" && proof.classification === "read_only" &&
		proof.attempt === current.attempt && resultAttempts().get(result) === current.attempt &&
		proof.operation === current.operation && notStartedFailure(result, proof) &&
		current.messageId === value.messageId && current.roomId === value.roomId &&
		(current.entityId === undefined || current.entityId === value.entityId) &&
		(current.agentId === undefined || current.agentId === value.agentId);
}
/** Owner-resolved metadata from the same privately associated, current denied result. */
export function getBoundOperationDenialOperation(result: object): NotesRequestOperation | undefined {
	const proof = currentDenial(result);
	return proof?.kind === "result" && resultAttempts().get(result) === proof.attempt && notStartedFailure(result, proof) ? proof.operation : undefined;
}
