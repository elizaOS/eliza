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
import type { Action } from "../types/components";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	pinnedDiscriminatorForPromotedChild,
	promotedSubactionDescription,
} from "./promote-subactions";

export type RequestOperationClassification =
	| "read_only"
	| "mutation_requested"
	| "unresolved";
export type RequestOperationRuntime = {
	readonly agentId: string;
	readonly actions?: readonly Action[];
};
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
			...(runtime && issuer && validIssuer(issuer, runtime, message)
				? { issuer }
				: {}),
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
export interface RequestOperationIssuer {
	readonly [issuerBrand]: true;
}
export interface BoundRequestOperationAttempt {
	readonly [attemptBrand]: true;
}
export const NOTES_REQUEST_OPERATIONS = Object.freeze([
	"create",
	"list",
	"get",
	"update",
	"patch",
	"delete",
] as const);
export type NotesRequestOperation = (typeof NOTES_REQUEST_OPERATIONS)[number];
export type NotesRequestInterpretation = {
	readonly status: "explicit" | "unavailable" | "contradictory";
	readonly operations: readonly NotesRequestOperation[];
};
type Issuer = {
	runtime: RequestOperationRuntime;
	message: Memory;
	current: () => boolean;
	agentId: string;
	messageId: string;
	roomId: string;
	entityId: string;
	requestHash: string;
	classification: RequestOperationClassification;
	committed: boolean;
	tainted: boolean;
	revision: number;
	interpretation?: NotesRequestInterpretation;
	interpretationHash?: string;
	source?: unknown;
	sourceHash?: string;
	currentSource?: () => unknown;
};
type Attempt = {
	issuer: RequestOperationIssuer;
	revision: number;
	state: State;
	message: Memory;
	resolved?: NotesRequestOperation;
	registeredOperation?: NotesRequestOperation;
	conflicted: boolean;
	registration?: RegisteredOperation;
	completionInvalidated?: "changed" | "stale";
};
type Definition = {
	name: string;
	handler: Action["handler"];
	restriction: Action["restrictRequestOperation"];
	validate: Action["validate"];
	parameters: Action["parameters"];
	contextGate: Action["contextGate"];
	roleGate: Action["roleGate"];
	hash: string;
};
type RegisteredOperation = {
	action: Action;
	family: Action;
	actionDefinition: Definition;
	familyDefinition: Definition;
};
type CanonicalDispatch = {
	child: string;
	discriminator: string;
	value: string;
};
type CompletionFact = {
	issuer: RequestOperationIssuer;
	revision: number;
	registration: RegisteredOperation;
	operation: NotesRequestOperation;
	permissionOperation: NotesRequestOperation;
	dispatch: CanonicalDispatch;
	canonicalChild: Action;
	childDefinition: Definition;
	rejected: boolean;
	requested?: boolean;
	outsideRequestRejection: boolean;
	ambiguousRejection: boolean;
};
type ResultAssociation = {
	attempt: BoundRequestOperationAttempt;
	fingerprint: string;
	shape: ReturnType<typeof completionShape>;
	completion?: CompletionFact;
	changed?: boolean;
	projectionOwner?: RequestOperationIssuer;
};
type Denial = {
	attempt: BoundRequestOperationAttempt;
	operation: NotesRequestOperation;
	classification: RequestOperationClassification;
	kind: "decision" | "error" | "result";
};
const issuerKey = Symbol.for("eliza.request-operation-issuers");
const activeIssuerKey = Symbol.for("eliza.request-operation-active-issuers");
const attemptKey = Symbol.for("eliza.request-operation-attempts");
const denialKey = Symbol.for("eliza.request-operation-denials");
const resultAttemptKey = Symbol.for("eliza.request-operation-result-attempts");
const issuers = () =>
	getAmbientSingleton(issuerKey, () => new WeakMap<object, Issuer>());
const activeIssuers = () =>
	getAmbientSingleton(
		activeIssuerKey,
		() => new WeakMap<object, WeakMap<object, RequestOperationIssuer>>(),
	);
const attempts = () =>
	getAmbientSingleton(attemptKey, () => new WeakMap<object, Attempt>());
const denials = () =>
	getAmbientSingleton(denialKey, () => new WeakMap<object, Denial>());
const resultAttempts = () =>
	getAmbientSingleton(
		resultAttemptKey,
		() => new WeakMap<object, ResultAssociation>(),
	);

/** Closed operation interpretation from the existing handled Stage1 field.
 * This is semantic completion evidence, never mutation permission. */
export function normalizeNotesRequestInterpretation(
	value: unknown,
): NotesRequestInterpretation | undefined {
	try {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			(Object.getPrototypeOf(value) !== Object.prototype &&
				Object.getPrototypeOf(value) !== null)
		)
			return;
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== 2 ||
			!keys.includes("status") ||
			!keys.includes("operations")
		)
			return;
		const status = ownData(value, "status");
		if (
			status !== "explicit" &&
			status !== "unavailable" &&
			status !== "contradictory"
		)
			return;
		const operations = plainSnapshot(ownData(value, "operations"));
		if (
			!Array.isArray(operations) ||
			operations.length > NOTES_REQUEST_OPERATIONS.length ||
			!operations.every(
				(operation): operation is NotesRequestOperation =>
					typeof operation === "string" &&
					NOTES_REQUEST_OPERATIONS.some((candidate) => candidate === operation),
			) ||
			new Set(operations).size !== operations.length ||
			(status !== "explicit" && operations.length !== 0)
		)
			return;
		return Object.freeze({
			status,
			operations: Object.freeze(
				NOTES_REQUEST_OPERATIONS.filter((operation) =>
					operations.includes(operation),
				),
			),
		});
	} catch {
		return undefined;
	}
}
function definition(action: Action): Definition {
	return Object.freeze({
		name: action.name,
		handler: action.handler,
		restriction: action.restrictRequestOperation,
		validate: action.validate,
		parameters: action.parameters,
		contextGate: action.contextGate,
		roleGate: action.roleGate,
		hash: hashStableJson({
			parameters: action.parameters,
			contexts: action.contexts,
			contextGate: action.contextGate,
			roleGate: action.roleGate,
			disclosureGate: action.disclosureGate,
			egress: action.egress,
			accountPolicy: action.accountPolicy,
			connectorAccountPolicy: action.connectorAccountPolicy,
			tags: action.tags,
			subActions: action.subActions,
			promotion: promotedSubactionDescription(action),
		}),
	});
}
function sameDefinition(action: Action, saved: Definition): boolean {
	const current = definition(action);
	return (
		current.name === saved.name &&
		current.handler === saved.handler &&
		current.restriction === saved.restriction &&
		current.validate === saved.validate &&
		current.parameters === saved.parameters &&
		current.contextGate === saved.contextGate &&
		current.roleGate === saved.roleGate &&
		current.hash === saved.hash
	);
}
function registeredOperation(
	runtime: RequestOperationRuntime,
	action: Action | undefined,
): RegisteredOperation | undefined {
	try {
		if (!action || !runtime.actions?.includes(action)) return;
		const promoted = promotedSubactionDescription(action);
		const family = promoted
			? runtime.actions.find(
					(candidate) =>
						candidate.name === promoted.parent &&
						!promotedSubactionDescription(candidate),
				)
			: action;
		if (!family) return;
		return Object.freeze({
			action,
			family,
			actionDefinition: definition(action),
			familyDefinition: definition(family),
		});
	} catch {
		return undefined;
	}
}

function currentRegistration(
	runtime: RequestOperationRuntime,
	registration: RegisteredOperation,
): boolean {
	try {
		return (
			runtime.actions?.includes(registration.action) === true &&
			runtime.actions.includes(registration.family) &&
			sameDefinition(registration.action, registration.actionDefinition) &&
			sameDefinition(registration.family, registration.familyDefinition)
		);
	} catch {
		return false;
	}
}
function canonicalDispatch(
	runtime: RequestOperationRuntime,
	registration: RegisteredOperation,
	operation: NotesRequestOperation,
): CanonicalDispatch | undefined {
	const actual = promotedSubactionDescription(registration.action);
	if (actual && actual.subaction !== operation) return;
	const children =
		runtime.actions?.filter((action) => {
			const promoted = promotedSubactionDescription(action);
			return (
				promoted?.parent === registration.family.name &&
				promoted.subaction === operation
			);
		}) ?? [];
	const child =
		children.find(
			(action) => promotedSubactionDescription(action)?.subaction === operation,
		) ?? children[0];
	return child
		? pinnedDiscriminatorForPromotedChild(
				registration.family,
				child.name,
				(name) => runtime.actions?.find((action) => action.name === name),
			)
		: undefined;
}

// Snapshot selected completion/selector metadata, not arbitrary note objects,
// model prose or result context. Own data descriptors avoid getter TOCTOU.
const completionFields = [
	"actionName",
	"op",
	"noteId",
	"requestedNoteId",
	"notesRevision",
	"expectedRevision",
	"revision",
	"target",
	"code",
	"error",
	"acceptance",
	"executionStatus",
	"executed",
	"retryable",
	"readOnlyOperation",
	"coachingFailure",
	"outcomeUnknown",
	"reconciliationRequired",
	"requiresInput",
	"missingField",
	"awaitingUserInput",
	"requiresConfirmation",
	"approvalRequired",
	"awaitingDeviceExecution",
	"parameterErrors",
	"invalidParameterNames",
	"effects",
	"effectReceipts",
	"receipt",
];
function ownData(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor))
		throw new Error("Accessor is not completion evidence");
	return descriptor.value;
}
function plainSnapshot(
	value: unknown,
	depth = 0,
	budget = { nodes: 0 },
): unknown {
	if (++budget.nodes > 2048 || depth > 12)
		throw new Error("Completion evidence limit");
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	)
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object")
		throw new Error("Invalid completion evidence");
	if (Array.isArray(value)) {
		const length = ownData(value, "length");
		if (
			typeof length !== "number" ||
			!Number.isInteger(length) ||
			length < 0 ||
			length > 256
		)
			throw new Error("Completion evidence limit");
		return Array.from({ length }, (_, index) =>
			plainSnapshot(ownData(value, String(index)), depth + 1, budget),
		);
	}
	if (
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new Error("Nonplain completion evidence");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string")
			throw new Error("Symbol is not completion evidence");
		result[key] = plainSnapshot(ownData(value, key), depth + 1, budget);
	}
	return result;
}
function completionShape(result: object): {
	success: unknown;
	errorPresent: boolean;
	failureProvenance: unknown;
	effectReceipts: unknown;
	top: Record<string, unknown>;
	data: Record<string, unknown>;
	values: Record<string, unknown>;
	nestedValues: Record<string, unknown>;
} {
	const dataValue = ownData(result, "data");
	const data =
		dataValue && typeof dataValue === "object" && !Array.isArray(dataValue)
			? dataValue
			: {};
	if (
		dataValue != null &&
		(data !== dataValue ||
			(Object.getPrototypeOf(data) !== Object.prototype &&
				Object.getPrototypeOf(data) !== null))
	)
		throw new Error("Nonplain result data");
	const valuesValue = ownData(result, "values");
	const nestedValue = ownData(data, "values");
	const values =
		valuesValue &&
		typeof valuesValue === "object" &&
		!Array.isArray(valuesValue)
			? valuesValue
			: {};
	const nestedValues =
		nestedValue &&
		typeof nestedValue === "object" &&
		!Array.isArray(nestedValue)
			? nestedValue
			: {};
	if (
		valuesValue != null &&
		(values !== valuesValue ||
			(Object.getPrototypeOf(values) !== Object.prototype &&
				Object.getPrototypeOf(values) !== null))
	)
		throw new Error("Nonplain result values");
	if (
		nestedValue != null &&
		(nestedValues !== nestedValue ||
			(Object.getPrototypeOf(nestedValues) !== Object.prototype &&
				Object.getPrototypeOf(nestedValues) !== null))
	)
		throw new Error("Nonplain nested result values");
	const fieldValue = (row: object, key: string): unknown => {
		const value = ownData(row, key);
		if (key === "receipt") return value === undefined ? undefined : true;
		if (key === "effects" || key === "effectReceipts") {
			if (value === undefined) return undefined;
			return Array.isArray(value) && ownData(value, "length") === 0 ? [] : true;
		}
		return plainSnapshot(value);
	};
	const fields = (row: object) => ({
		...Object.fromEntries(
			completionFields.map((key) => [key, fieldValue(row, key)]),
		),
		lifeDraftPresent: ownData(row, "lifeDraft") !== undefined,
	});
	return {
		success: ownData(result, "success"),
		errorPresent: ownData(result, "error") != null,
		failureProvenance: plainSnapshot(ownData(result, "failureProvenance")),
		effectReceipts: plainSnapshot(ownData(result, "effectReceipts")),
		top: {
			...Object.fromEntries(
				completionFields
					.filter((key) => key !== "error" && key !== "effectReceipts")
					.map((key) => [key, fieldValue(result, key)]),
			),
			lifeDraftPresent: ownData(result, "lifeDraft") !== undefined,
		},
		data: fields(data),
		values: fields(values),
		nestedValues: fields(nestedValues),
	};
}
function projectionFingerprint(
	shape: ReturnType<typeof completionShape>,
): string {
	const merged: Record<string, unknown> = Object.create(null);
	const conflicts: string[] = [];
	for (const key of new Set([
		...Object.keys(shape.values),
		...Object.keys(shape.nestedValues),
	])) {
		const top = shape.values[key],
			nested = shape.nestedValues[key];
		if (top === undefined) merged[key] = nested;
		else if (
			nested === undefined ||
			hashStableJson(top) === hashStableJson(nested)
		)
			merged[key] = top;
		else {
			merged[key] = [top, nested];
			conflicts.push(key);
		}
	}
	const { values: _top, nestedValues: _nested, ...common } = shape;
	return hashStableJson({
		...common,
		values: merged,
		valueConflicts: conflicts,
	});
}
function fingerprintResult(result: object): string | undefined {
	try {
		return hashStableJson(completionShape(result));
	} catch {
		return undefined;
	}
}
function unclassifiedEffects(
	shape: ReturnType<typeof completionShape>,
): boolean {
	return (
		[shape.top, shape.data, shape.values, shape.nestedValues].some(
			(row) =>
				row.receipt !== undefined ||
				(row.effects !== undefined &&
					(!Array.isArray(row.effects) || row.effects.length > 0)),
		) ||
		[shape.data, shape.values, shape.nestedValues].some(
			(row) =>
				row.effectReceipts !== undefined &&
				(!Array.isArray(row.effectReceipts) || row.effectReceipts.length > 0),
		)
	);
}
function rejectedBeforeExecution(
	shape: ReturnType<typeof completionShape>,
): boolean {
	const provenance = shape.failureProvenance as
		| { retryable?: unknown }
		| undefined;
	const unknown = [
		shape.top.outcomeUnknown,
		shape.top.reconciliationRequired,
		shape.data.outcomeUnknown,
		shape.data.reconciliationRequired,
		shape.values.outcomeUnknown,
		shape.values.reconciliationRequired,
		shape.nestedValues.outcomeUnknown,
		shape.nestedValues.reconciliationRequired,
	].some((value) => value !== undefined && value !== false);
	const evidence = [shape.top, shape.data, shape.values, shape.nestedValues];
	const contradiction = evidence.some(
		(row) =>
			(row.executed !== undefined && row.executed !== false) ||
			(row.executionStatus !== undefined &&
				row.executionStatus !== "not_started") ||
			(row.acceptance !== undefined && row.acceptance !== "rejected"),
	);
	const prerequisite = evidence.some(
		(row) =>
			row.requiresInput === true ||
			row.awaitingUserInput === true ||
			row.requiresConfirmation === true ||
			row.approvalRequired === true ||
			row.awaitingDeviceExecution === true ||
			row.lifeDraftPresent === true ||
			(typeof row.missingField === "string" &&
				row.missingField.trim().length > 0),
	);
	return (
		shape.success === false &&
		provenance?.retryable === true &&
		!unknown &&
		!prerequisite &&
		!contradiction &&
		!unclassifiedEffects(shape) &&
		shape.data.acceptance === "rejected" &&
		shape.data.executionStatus === "not_started" &&
		(shape.data.executed === undefined || shape.data.executed === false) &&
		shape.top.readOnlyOperation !== true &&
		shape.top.coachingFailure !== true &&
		shape.data.readOnlyOperation !== true &&
		shape.data.coachingFailure !== true &&
		shape.values.readOnlyOperation !== true &&
		shape.values.coachingFailure !== true &&
		shape.nestedValues.readOnlyOperation !== true &&
		shape.nestedValues.coachingFailure !== true &&
		(!Array.isArray(shape.effectReceipts) || shape.effectReceipts.length === 0)
	);
}

function validIssuer(
	token: unknown,
	runtime?: RequestOperationRuntime,
	message?: Memory,
): Issuer | undefined {
	if (!token || typeof token !== "object") return;
	const value = issuers().get(token);
	if (
		!value ||
		(runtime && value.runtime !== runtime) ||
		(message && value.message !== message)
	)
		return;
	try {
		if (
			activeIssuers().get(value.runtime)?.get(value.message) !== token ||
			!value.current() ||
			value.runtime.agentId !== value.agentId ||
			value.message.id !== value.messageId ||
			value.message.roomId !== value.roomId ||
			value.message.entityId !== value.entityId ||
			value.message.agentId !== value.agentId ||
			hashStableJson(value.message) !== value.requestHash
		)
			return;
		// This is the immutable same-call classification input, NOT a later tool's
		// provider/state/extraction view. Legitimate tool results and provider refreshes
		// do not replace it; altered original request sources still invalidate it.
		if (
			value.committed &&
			value.currentSource &&
			(hashStableJson(value.currentSource()) !== value.sourceHash ||
				hashStableJson(value.source) !== value.sourceHash)
		)
			return;
		return value;
	} catch {
		return;
	}
}
/** Host entry only: call before the same Stage-1 classification, with its live abort/owner guard.
 * Re-entry for the same actual request returns the original issuer and cannot reset its latch. */
export function beginRequestOperationIssuer(input: {
	runtime: RequestOperationRuntime;
	message: Memory;
	current: () => boolean;
}): RequestOperationIssuer | undefined {
	const { runtime, message, current } = input;
	if (
		!runtime ||
		typeof runtime !== "object" ||
		typeof current !== "function" ||
		!message.id ||
		!message.roomId ||
		!message.entityId ||
		runtime.agentId !== message.agentId
	)
		return;
	try {
		if (!current()) return;
		let rooms = activeIssuers().get(runtime);
		if (!rooms) {
			rooms = new WeakMap();
			activeIssuers().set(runtime, rooms);
		}
		const previous = rooms.get(message);
		const old = previous && issuers().get(previous);
		if (old)
			return validIssuer(previous, runtime, message) ? previous : undefined;
		const token = Object.freeze(Object.create(null)) as RequestOperationIssuer;
		issuers().set(token, {
			runtime,
			message,
			current,
			agentId: runtime.agentId,
			messageId: message.id,
			roomId: message.roomId,
			entityId: message.entityId,
			requestHash: hashStableJson(message),
			classification: "unresolved",
			committed: false,
			tainted: false,
			revision: 0,
		});
		rooms.set(message, token);
		return token;
	} catch {
		return;
	}
}
/** Getter cannot mint authority, reconstruct serialized state, or reset a restriction. */
export function getRequestOperationIssuer(
	runtime: RequestOperationRuntime,
	message: Memory,
): RequestOperationIssuer | undefined {
	const token = activeIssuers().get(runtime)?.get(message);
	return token && validIssuer(token, runtime, message) ? token : undefined;
}
/** Same-call validated field producer only, AFTER its active/parsed/handled trace checks.
 * The source/currentSource port is the owned immutable Stage-1 input, never planner JSON.
 * A contradictory second commit permanently fails closed for this issuer. */
export function commitNotesRequestRestriction(
	token: RequestOperationIssuer,
	input: {
		classification: unknown;
		source: unknown;
		currentSource: () => unknown;
		interpretation?: NotesRequestInterpretation;
	},
): boolean {
	const value = validIssuer(token);
	if (!value || typeof input.currentSource !== "function") return false;
	try {
		let classification: RequestOperationClassification =
			input.classification === "read_only" ||
			input.classification === "mutation_requested"
				? input.classification
				: "unresolved";
		let interpretation =
			input.interpretation === undefined
				? normalizeNotesRequestInterpretation({
						status: "unavailable",
						operations: [],
					})
				: normalizeNotesRequestInterpretation(input.interpretation);
		const mutations =
			interpretation?.operations.some(
				(operation) => operation !== "get" && operation !== "list",
			) === true;
		if (
			!interpretation ||
			interpretation.status === "contradictory" ||
			(interpretation.status === "explicit" &&
				((classification === "read_only" && mutations) ||
					(classification === "mutation_requested" && !mutations) ||
					(classification === "unresolved" &&
						interpretation.operations.length > 0)))
		) {
			classification = "unresolved";
			interpretation = normalizeNotesRequestInterpretation({
				status: "contradictory",
				operations: [],
			});
		}
		const interpretationHash = hashStableJson(interpretation);
		const sourceHash = hashStableJson(input.source);
		if (hashStableJson(input.currentSource()) !== sourceHash) return false;
		if (value.committed) {
			if (
				value.tainted ||
				value.classification !== classification ||
				value.sourceHash !== sourceHash ||
				value.interpretationHash !== interpretationHash
			) {
				value.tainted = true;
				value.classification = "unresolved";
				value.interpretation = normalizeNotesRequestInterpretation({
					status: "contradictory",
					operations: [],
				});
				value.revision++;
				return false;
			}
			return true;
		}
		value.classification = classification;
		value.interpretation = interpretation;
		value.interpretationHash = interpretationHash;
		value.source = input.source;
		value.sourceHash = sourceHash;
		value.currentSource = input.currentSource;
		value.committed = true;
		value.revision++;
		return true;
	} catch {
		return false;
	}
}
export function readTaskExtractionNotesRestriction(
	state: State | undefined,
	message: Memory | undefined,
	runtime?: RequestOperationRuntime,
): RequestOperationClassification {
	const binding = readBinding(state, message);
	const value =
		binding?.issuer && validIssuer(binding.issuer, runtime, message);
	return value?.committed && !value.tainted
		? value.classification
		: "unresolved";
}
/** Mint at the host execution boundary, not from a tool-call ID/arguments. */
export function beginRequestOperationAttempt(input: {
	runtime: RequestOperationRuntime;
	state: State;
	message: Memory;
	action?: Action;
}): BoundRequestOperationAttempt | undefined {
	const binding = readBinding(input.state, input.message);
	const value =
		binding?.issuer &&
		validIssuer(binding.issuer, input.runtime, input.message);
	if (!value?.committed || !binding?.issuer) return;
	const token = Object.freeze(
		Object.create(null),
	) as BoundRequestOperationAttempt;
	attempts().set(token, {
		issuer: binding.issuer,
		revision: value.revision,
		state: input.state,
		message: input.message,
		conflicted: false,
		registration:
			value.classification === "mutation_requested"
				? registeredOperation(input.runtime, input.action)
				: undefined,
	});
	return token;
}
function currentAttempt(token: unknown): Attempt | undefined {
	if (!token || typeof token !== "object") return;
	const attempt = attempts().get(token);
	const value = attempt && validIssuer(attempt.issuer);
	return attempt &&
		value &&
		!attempt.conflicted &&
		value.revision === attempt.revision
		? attempt
		: undefined;
}
export type BoundOperationDecision =
	| { readonly allowed: true; readonly addsAuthority: false }
	| {
			readonly allowed: false;
			readonly addsAuthority: false;
			readonly code:
				| "REQUEST_OPERATION_RESTRICTED"
				| "REQUEST_OPERATION_UNRESOLVED";
			readonly executionStatus: "not_started";
	  };
export function checkBoundNotesOperation(
	state: State | undefined,
	message: Memory | undefined,
	operation: NotesRequestOperation,
	token?: BoundRequestOperationAttempt,
	registeredOperation?: NotesRequestOperation,
): BoundOperationDecision {
	const recognized =
		operation === "get" ||
		operation === "list" ||
		operation === "create" ||
		operation === "update" ||
		operation === "patch" ||
		operation === "delete";
	// An observation never fixes or changes the mutation identity of this host
	// action. A compound view action may read before its one resolved mutation,
	// and a later read cannot erase a settled denied mutation.
	if (recognized && (operation === "get" || operation === "list"))
		return { allowed: true, addsAuthority: false };
	const attempt = currentAttempt(token),
		binding = readBinding(state, message);
	const same =
		attempt &&
		attempt.message === message &&
		binding?.issuer === attempt.issuer;
	if (attempt && same && recognized) {
		if (attempt.resolved && attempt.resolved !== operation)
			attempt.conflicted = true;
		else attempt.resolved = operation;
		if (!attempt.registeredOperation && registeredOperation)
			attempt.registeredOperation = registeredOperation;
	}
	const classification =
		attempt && same && !attempt.conflicted && recognized
			? readTaskExtractionNotesRestriction(state, message)
			: "unresolved";
	if (classification === "mutation_requested")
		return { allowed: true, addsAuthority: false };
	const decision: BoundOperationDecision = Object.freeze({
		allowed: false,
		addsAuthority: false,
		code:
			classification === "read_only"
				? "REQUEST_OPERATION_RESTRICTED"
				: "REQUEST_OPERATION_UNRESOLVED",
		executionStatus: "not_started",
	});
	if (attempt && same && !attempt.conflicted && recognized && token) {
		denials().set(decision, {
			attempt: token,
			operation,
			classification,
			kind: "decision",
		});
	}
	return decision;
}
function unknownOutcomeMarker(source: object): boolean {
	const row = source as {
		outcomeUnknown?: unknown;
		reconciliationRequired?: unknown;
		data?: Record<string, unknown>;
	};
	return [
		row.outcomeUnknown,
		row.reconciliationRequired,
		row.data?.outcomeUnknown,
		row.data?.reconciliationRequired,
	].some((value) => value !== undefined && value !== false);
}
function currentDenial(source: object): Denial | undefined {
	if (unknownOutcomeMarker(source)) return undefined;
	const proof = denials().get(source),
		attempt = proof && currentAttempt(proof.attempt);
	if (
		!proof ||
		!attempt ||
		attempt.resolved !== proof.operation ||
		proof.operation === "get" ||
		proof.operation === "list"
	)
		return;
	const value = validIssuer(attempt.issuer);
	return value?.classification === proof.classification && value.committed
		? proof
		: undefined;
}
function notStartedFailure(result: object, proof: Denial): boolean {
	if (unknownOutcomeMarker(result)) return false;
	const row = result as {
		success?: unknown;
		data?: Record<string, unknown>;
		effectReceipts?: unknown;
		receipt?: unknown;
		effects?: unknown;
	};
	const code =
		proof.classification === "read_only"
			? "REQUEST_OPERATION_RESTRICTED"
			: "REQUEST_OPERATION_UNRESOLVED";
	if (
		row.success !== false ||
		row.data?.code !== code ||
		row.data.executionStatus !== "not_started" ||
		row.data.executed !== false
	)
		return false;
	return (
		[
			row.effectReceipts,
			row.effects,
			row.data.effectReceipts,
			row.data.effects,
		].every(
			(value) =>
				value === undefined || (Array.isArray(value) && value.length === 0),
		) &&
		row.receipt === undefined &&
		row.data.receipt === undefined
	);
}
export class BoundRequestOperationError extends Error {
	readonly code:
		| "REQUEST_OPERATION_RESTRICTED"
		| "REQUEST_OPERATION_UNRESOLVED";
	readonly executionStatus = "not_started" as const;
	constructor(decision: Extract<BoundOperationDecision, { allowed: false }>) {
		const proof = currentDenial(decision);
		super(
			proof?.classification === "read_only"
				? "Operation denied by the current read-only request constraint."
				: "The current request operation is unresolved.",
		);
		this.name = "BoundRequestOperationError";
		this.code =
			proof?.classification === "read_only"
				? "REQUEST_OPERATION_RESTRICTED"
				: "REQUEST_OPERATION_UNRESOLVED";
		if (proof) denials().set(this, { ...proof, kind: "error" });
	}
}
/** All owned results are associated with the actual execution attempt before projection. */
export function bindRequestOperationResult(
	result: object,
	token: BoundRequestOperationAttempt,
): boolean {
	const attempt = currentAttempt(token),
		value = attempt && validIssuer(attempt.issuer);
	if (!attempt || !value || !attempt.resolved) return false;
	let shape: ReturnType<typeof completionShape>;
	try {
		shape = completionShape(result);
	} catch {
		return false;
	}
	const fingerprint = hashStableJson(shape);
	const previous = resultAttempts().get(result);
	if (previous) {
		if (previous.fingerprint !== fingerprint) previous.changed = true;
		return (
			!previous.changed &&
			previous.attempt === token &&
			previous.fingerprint === fingerprint
		);
	}
	let completion: CompletionFact | undefined;
	try {
		if (
			value.classification === "mutation_requested" &&
			attempt.resolved &&
			attempt.registeredOperation &&
			attempt.resolved !== "get" &&
			attempt.resolved !== "list" &&
			attempt.registration &&
			currentRegistration(value.runtime, attempt.registration)
		) {
			const dispatch = canonicalDispatch(
				value.runtime,
				attempt.registration,
				attempt.registeredOperation,
			);
			const canonicalChild =
				dispatch &&
				value.runtime.actions?.find((action) => action.name === dispatch.child);
			const noEffectRejection =
				rejectedBeforeExecution(shape) &&
				[shape.top, shape.data, shape.values, shape.nestedValues].every(
					(row) =>
						row.op === undefined ||
						row.op === attempt.registeredOperation ||
						row.op === attempt.resolved,
				);
			// The Notes owner resolves its registered patch action to update before
			// checking permission. An explicit edit may be fulfilled by that patch;
			// keep its raw dispatch identity for matching and freshness checks.
			const requested =
				value.interpretation?.status === "explicit"
					? value.interpretation.operations.includes(
							attempt.registeredOperation,
						) ||
						(attempt.registeredOperation === "patch" &&
							attempt.resolved === "update" &&
							value.interpretation.operations.includes("update"))
					: undefined;
			if (dispatch && canonicalChild)
				completion = Object.freeze({
					issuer: attempt.issuer,
					revision: attempt.revision,
					registration: attempt.registration,
					operation: attempt.registeredOperation,
					permissionOperation: attempt.resolved,
					dispatch: Object.freeze(dispatch),
					canonicalChild,
					childDefinition: definition(canonicalChild),
					requested,
					rejected: requested === true && noEffectRejection,
					outsideRequestRejection: requested === false && noEffectRejection,
					ambiguousRejection:
						value.interpretation?.status !== "explicit" && noEffectRejection,
				});
		}
	} catch {
		completion = undefined;
	}
	resultAttempts().set(result, {
		attempt: token,
		fingerprint,
		shape,
		completion,
	});
	return true;
}

/** Actual-source projection only: no positive attempt getter is exposed. A
 * serialized clone cannot self-brand; the owner must possess the original
 * association and preserve every completion-relevant outcome/provenance field.
 */
export function bindRequestOperationProjection(
	source: object,
	target: object,
	consumer: RequestOperationIssuer | undefined,
): boolean {
	const association = resultAttempts().get(source),
		fact = association?.completion;
	if (
		!association ||
		!fact ||
		!consumer ||
		fact.issuer !== consumer ||
		resultAttempts().has(target)
	)
		return false;
	let shape: ReturnType<typeof completionShape>;
	try {
		shape = completionShape(target);
	} catch {
		return false;
	}
	const fingerprint = hashStableJson(shape);
	if (fingerprintResult(source) !== association.fingerprint)
		association.changed = true;
	const changed =
		association.changed === true ||
		projectionFingerprint(shape) !== projectionFingerprint(association.shape);
	// A mismatched owned projection retains only an invalid historical blocker,
	// never active completion proof. This prevents failed projection from erasing
	// an already issued obligation; arbitrary unowned copies still cannot qualify.
	resultAttempts().set(target, {
		attempt: association.attempt,
		fingerprint,
		shape,
		projectionOwner: consumer,
		...(changed ? { completion: fact, changed: true } : {}),
	});
	return !changed;
}
export function copyRequestOperationResult(
	source: object,
	target: object,
): boolean {
	const association = resultAttempts().get(source),
		owned = resultAttempts().get(target);
	const fact = association?.completion;
	if (
		!association ||
		!fact ||
		!owned ||
		owned.attempt !== association.attempt ||
		owned.projectionOwner !== fact.issuer
	)
		return false;
	if (fingerprintResult(source) !== association.fingerprint)
		association.changed = true;
	if (
		association.changed ||
		owned.changed ||
		fingerprintResult(target) !== owned.fingerprint ||
		projectionFingerprint(owned.shape) !==
			projectionFingerprint(association.shape)
	)
		return false;
	resultAttempts().set(target, {
		...association,
		fingerprint: owned.fingerprint,
		shape: owned.shape,
		projectionOwner: owned.projectionOwner,
	});
	return true;
}
export type NotesMutationCompletion = {
	rejected: boolean;
	requested?: boolean;
	outsideRequestRejection: boolean;
	ambiguousRejection: boolean;
	status: "current" | "stale" | "changed";
	dispatch?: CanonicalDispatch;
};
/** Issued failures survive invalidation as blockers, never as permission or
 * authority to retry. The consumer supplies the actual host issuer capability.
 */
export function readNotesMutationCompletion(
	result: object,
	consumer: RequestOperationIssuer | undefined,
): NotesMutationCompletion | undefined {
	const association = resultAttempts().get(result),
		fact = association?.completion;
	if (!association || !fact || !consumer || fact.issuer !== consumer) return;
	const originalAttempt = attempts().get(association.attempt);
	if (fingerprintResult(result) !== association.fingerprint)
		association.changed = true;
	if (association.changed && originalAttempt)
		originalAttempt.completionInvalidated = "changed";
	if (
		association.changed ||
		originalAttempt?.completionInvalidated === "changed"
	)
		return {
			rejected: fact.rejected,
			requested: fact.requested,
			outsideRequestRejection: fact.outsideRequestRejection,
			ambiguousRejection: fact.ambiguousRejection,
			status: "changed",
		};
	if (originalAttempt?.completionInvalidated === "stale")
		return {
			rejected: fact.rejected,
			requested: fact.requested,
			outsideRequestRejection: fact.outsideRequestRejection,
			ambiguousRejection: fact.ambiguousRejection,
			status: "stale",
		};
	const attempt = currentAttempt(association.attempt),
		value = validIssuer(consumer);
	let current = false;
	try {
		current = !!(
			attempt &&
			value &&
			value.revision === fact.revision &&
			attempt.issuer === consumer &&
			attempt.resolved === fact.permissionOperation &&
			attempt.registeredOperation === fact.operation &&
			!attempt.conflicted &&
			currentRegistration(value.runtime, fact.registration) &&
			value.runtime.actions?.includes(fact.canonicalChild) === true &&
			sameDefinition(fact.canonicalChild, fact.childDefinition)
		);
	} catch {
		current = false;
	}
	if (!current && originalAttempt)
		originalAttempt.completionInvalidated = "stale";
	return {
		rejected: fact.rejected,
		requested: fact.requested,
		outsideRequestRejection: fact.outsideRequestRejection,
		ambiguousRejection: fact.ambiguousRejection,
		status: current ? "current" : "stale",
		...(current ? { dispatch: fact.dispatch } : {}),
	};
}
export function isMatchingNotesMutationCompletion(
	rejected: object,
	success: object,
	consumer: RequestOperationIssuer | undefined,
): boolean {
	const first = resultAttempts().get(rejected),
		second = resultAttempts().get(success);
	const a = first?.completion,
		b = second?.completion;
	if (
		!first ||
		!second ||
		!a?.rejected ||
		!b ||
		!consumer ||
		a.issuer !== consumer ||
		b.issuer !== consumer ||
		a.revision !== b.revision ||
		a.registration.family !== b.registration.family ||
		a.canonicalChild !== b.canonicalChild ||
		a.operation !== b.operation ||
		readNotesMutationCompletion(rejected, consumer)?.status !== "current" ||
		readNotesMutationCompletion(success, consumer)?.status !== "current"
	)
		return false;
	const shape = second.shape;
	const operation = shape.data.op;
	const evidence = [shape.top, shape.data, shape.values, shape.nestedValues];
	const prerequisite = evidence.some(
		(row) =>
			row.requiresInput === true ||
			row.awaitingUserInput === true ||
			row.requiresConfirmation === true ||
			row.approvalRequired === true ||
			row.awaitingDeviceExecution === true ||
			row.lifeDraftPresent === true ||
			(typeof row.missingField === "string" &&
				row.missingField.trim().length > 0),
	);
	if (
		shape.success !== true ||
		shape.errorPresent ||
		operation !== a.permissionOperation ||
		prerequisite ||
		unclassifiedEffects(shape) ||
		evidence.some(
			(row) =>
				(row.op !== undefined && row.op !== a.permissionOperation) ||
				row.readOnlyOperation === true ||
				row.coachingFailure === true,
		) ||
		evidence.some(
			(row) =>
				row.executionStatus === "not_started" || row.acceptance === "rejected",
		) ||
		shape.data.readOnlyOperation === true ||
		shape.data.coachingFailure === true ||
		typeof shape.data.noteId !== "string" ||
		!Array.isArray(shape.effectReceipts) ||
		[
			shape.top.outcomeUnknown,
			shape.top.reconciliationRequired,
			shape.data.outcomeUnknown,
			shape.data.reconciliationRequired,
			shape.values.outcomeUnknown,
			shape.values.reconciliationRequired,
			shape.nestedValues.outcomeUnknown,
			shape.nestedValues.reconciliationRequired,
		].some((value) => value !== undefined && value !== false)
	)
		return false;
	// The real Notes owner reports the completed operation and its normalized
	// receipt. A read-shaped success cannot fulfill a recorded mutation. Normal
	// duplicate-create noops/replays remain valid; all-turn rollback is checked
	// by the existing planner receipt gate before removing the failed step.
	if (
		shape.effectReceipts.some(
			(value) =>
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				!["applied", "noop"].includes(
					String((value as Record<string, unknown>).outcome),
				),
		)
	)
		return false;
	return shape.effectReceipts.some((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return false;
		const receipt = value as Record<string, unknown>;
		const resource = receipt.resource as
			| { kind?: unknown; id?: unknown }
			| undefined;
		const idempotency = receipt.idempotency as
			| { replayed?: unknown }
			| undefined;
		return (
			receipt.operation === `notes.note.${shape.data.op}` &&
			resource?.kind === "notes.note" &&
			resource.id === shape.data.noteId &&
			(receipt.outcome === "applied"
				? evidence.every(
						(row) => row.executed === undefined || row.executed === true,
					)
				: receipt.outcome === "noop" &&
					idempotency?.replayed === true &&
					evidence.every(
						(row) => row.executed === undefined || row.executed === false,
					))
		);
	});
}
/** Owned failure projection only. Require BOTH actual expected attempt and target ownership;
 * raw clones, success/applied/unknown results and other attempts cannot receive denial proof. */
export function transferBoundOperationDenial(
	source: object,
	target: object,
	expectedAttempt: BoundRequestOperationAttempt,
): boolean {
	const proof = currentDenial(source);
	if (
		!proof ||
		proof.attempt !== expectedAttempt ||
		resultAttempts().get(target)?.attempt !== expectedAttempt ||
		!notStartedFailure(target, proof) ||
		(proof.kind === "result" && !notStartedFailure(source, proof))
	)
		return false;
	denials().set(target, { ...proof, kind: "result" });
	return true;
}
/** Owned decision/error catches need the opaque attempt for their first failure projection.
 * Results additionally require exact failure/zero-effect shape and host attempt ownership. */
export function getBoundOperationDenialAttempt(
	result: object,
): BoundRequestOperationAttempt | undefined {
	const proof = currentDenial(result);
	if (!proof) return undefined;
	if (
		proof.kind === "result" &&
		(resultAttempts().get(result)?.attempt !== proof.attempt ||
			!notStartedFailure(result, proof))
	)
		return undefined;
	return proof.attempt;
}
/** This excludes ONE invented failed attempt, never proves original-request completion. */
export function isVerifiedOutsideRequestDenial(
	result: object,
	current: {
		messageId: string;
		roomId: string;
		entityId?: string;
		agentId?: string;
		attempt: BoundRequestOperationAttempt;
		operation: NotesRequestOperation;
	},
): boolean {
	const proof = currentDenial(result),
		attempt = proof && currentAttempt(proof.attempt);
	const value = attempt && validIssuer(attempt.issuer);
	return (
		!!proof &&
		!!value &&
		proof.kind === "result" &&
		proof.classification === "read_only" &&
		proof.attempt === current.attempt &&
		resultAttempts().get(result)?.attempt === current.attempt &&
		proof.operation === current.operation &&
		notStartedFailure(result, proof) &&
		current.messageId === value.messageId &&
		current.roomId === value.roomId &&
		(current.entityId === undefined || current.entityId === value.entityId) &&
		(current.agentId === undefined || current.agentId === value.agentId)
	);
}
/** Owner-resolved metadata from the same privately associated, current denied result. */
export function getBoundOperationDenialOperation(
	result: object,
): NotesRequestOperation | undefined {
	const proof = currentDenial(result);
	return proof?.kind === "result" &&
		resultAttempts().get(result)?.attempt === proof.attempt &&
		notStartedFailure(result, proof)
		? proof.operation
		: undefined;
}
