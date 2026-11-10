import type { ReplyEffectStatus } from "../types/components";
import type { Memory } from "../types/memory";
import type { JSONSchema } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { TurnAbortedError } from "./turn-aborted-error";

/**
 * Field evaluators own the schema, prompt contribution, and handler for each structured
 * response field. All fields remain required for stable schema bytes; shouldRun controls
 * prompt and handler activation, with empty defaults for inactive fields. Every active field
 * is parsed first; handlers then run in priority order, mutate the shared result, and may
 * abort further processing. Sibling parsed values remain read-only.
 */

/**
 * Sender-role classification piped through Stage 1. Re-exported here as a
 * narrow type so this module does not depend on agent/role internals.
 */
export type ResponseHandlerSenderRole =
	| "OWNER"
	| "ADMIN"
	| "USER"
	| "GUEST"
	| "SYSTEM"
	| "SELF";

/**
 * The flat, all-required result of one Stage-1 LLM call.
 *
 * Field ownership:
 * shouldRespond - core
 * contexts - core
 * intents - core
 * candidateActionNames - core
 * replyText - core
 * facts - core (memory pipeline)
 * relationships - core (memory pipeline)
 * addressedTo - core (memory pipeline)
 * threadOps - app-lifeops (includes abort)
 * <plugin fields> - registered by plugins
 *
 * The type is open at the top level (other plugins can contribute arbitrary
 * additional fields) but is keyed by `string` so all paths through the
 * pipeline treat unknown fields safely.
 */
export interface ResponseHandlerResult {
	shouldRespond: "RESPOND" | "IGNORE" | "STOP";
	contexts: string[];
	intents: string[];
	candidateActionNames: string[];
	replyText: string;
	replyEffectStatus?: ReplyEffectStatus;
	facts: string[];
	relationships: Array<{
		subject: string;
		predicate: string;
		object: string;
	}>;
	addressedTo: string[];
	// Plugin-contributed fields. Schema enforced per-field.
	[extra: string]: unknown;
}

/**
 * Context passed to `shouldRun` and `handle`. Read-only view of the runtime
 * state plus the parsed result so far. Handlers mutate via the returned
 * `ResponseHandlerFieldEffect`, not by writing to `ctx`.
 */
export interface ResponseHandlerFieldContext {
	readonly runtime: IAgentRuntime;
	readonly message: Memory;
	readonly state: State;
	readonly senderRole: ResponseHandlerSenderRole;
	/**
	 * Turn-scoped AbortSignal. Field handlers should respect it — once a
	 * sibling handler preempts (e.g., abort), this signal fires and any
	 * still-running handler should exit cleanly.
	 */
	readonly turnSignal: AbortSignal;
}

/**
 * Extended context only available during `handle`. Includes the parsed value
 * for THIS field plus the full parsed object for sibling-reads.
 */
export interface ResponseHandlerFieldHandleContext<TValue>
	extends ResponseHandlerFieldContext {
	readonly value: TValue;
	readonly parsed: Readonly<ResponseHandlerResult>;
}

/**
 * What a handler can affect:
 *
 * - `mutateResult(result)` — patch the running ResponseHandlerResult.
 * Use sparingly; prefer letting downstream consumers read the parsed
 * value directly.
 * - `preempt: {reason}` — stop processing remaining handlers and route to
 * a terminal outcome. Used by abort (skip planner, skip reply send) and
 * by IGNORE/STOP equivalents.
 * - `debug` — strings recorded into the trace for observability.
 */
export interface ResponseHandlerFieldEffect {
	mutateResult?: (result: ResponseHandlerResult) => void;
	preempt?: {
		/**
		 * What to do instead of the default route-to-planner / send-reply flow.
		 *
		 * - "ack-and-stop": agent emits a short ack reply and stops (used by
		 * abort, where the abort handler has already shut down in-flight work).
		 * - "ignore": agent emits nothing.
		 * - "direct-reply": agent uses the current `replyText` as the final reply.
		 */
		mode: "ack-and-stop" | "ignore" | "direct-reply";
		reason: string;
	};
	debug?: string[];
}

/**
 * A ResponseHandlerFieldEvaluator owns one top-level property of the
 * Stage-1 LLM's structured output. See the file header for the registration
 * lifecycle.
 *
 * @typeParam TValue - the parsed type for this field (matches `schema`)
 */
export interface ResponseHandlerFieldEvaluator<TValue = unknown> {
	/**
	 * The JSON property name. Becomes a top-level key on
	 * `ResponseHandlerResult` and a field name in the composed schema.
	 * Must be unique across all registered evaluators.
	 */
	name: string;

	/**
	 * Human-readable description AND the natural-language prompt slice. This
	 * string is included verbatim in the system prompt to tell the LLM what
	 * this field is for and when to populate it. Should be 1-4 short
	 * sentences. Per the user directive: "the context names and the full
	 * descriptions must be in the prompt."
	 */
	description: string;

	/** Short description for stored metadata; prompt rendering uses description. */
	descriptionCompressed?: string;

	/**
	 * Execution order. Lower runs first. Defaults to 100. Conventions:
	 *
	 * 0-19 - core routing fields (shouldRespond, contexts) and plugin
	 * routing fields that declare `directReplyValue` (threadOps, calendar,
	 * etc.), generated before the reply
	 * 20 - replyText
	 * 20-49 - other plugin-contributed action surfaces
	 * 50-79 - retrieval hints
	 * 80-99 - extract/memory pipeline (facts, relationships, addressedTo)
	 */
	priority?: number;

	/**
	 * The values of this field that keep the turn a direct answer. Declaring
	 * it promises that, whenever it returns true for the model's raw value,
	 * this field's parse and handle neither reroute the turn (contexts,
	 * intents, action candidates, planner, preempt) nor change `replyText`.
	 * A host that streams `replyText` while it is generated may then start
	 * the stream once this field was written before it (priority below
	 * `replyText`'s) with such a value. A field without it, or written after
	 * `replyText`, holds that stream: its value is not known in time.
	 */
	directReplyValue?: (value: unknown) => boolean;

	/**
	 * JSON schema fragment for THIS field. Must declare a deterministic
	 * "empty" value (empty array, empty string, "IGNORE", etc.) so the LLM
	 * can emit it when the field is N/A. Schema must support OpenAI strict
	 * mode: no required-but-undefined, no `additionalProperties: true`
	 * unless intentional.
	 *
	 * Parameter `description` strings within the schema ARE shown to the LLM
	 * (they are part of the strict schema sent to OpenAI / Anthropic). Use
	 * them to document subfields.
	 */
	schema: JSONSchema;

	/**
	 * Per-turn activation gate.
	 *
	 * - When `true` (default if omitted): the evaluator's prompt slice is
	 * included in the system prompt; the LLM is instructed to populate
	 * the field. The field's handler runs after parse.
	 * - When `false`: the prompt slice is omitted (no instruction to
	 * populate); after parse, the handler is skipped. The field stays
	 * declared in the schema for cache stability — the LLM emits the
	 * declared empty value.
	 *
	 * Must be cheap. Avoid LLM calls or heavy I/O. Database lookups acceptable
	 * if cached.
	 */
	shouldRun?(ctx: ResponseHandlerFieldContext): boolean | Promise<boolean>;

	/** Request-scoped facts for this field, rendered outside the stable prompt/schema.
	 * Runs only for active fields. Must not execute effects or invoke a model.
	 */
	getContext?(ctx: ResponseHandlerFieldContext): string | Promise<string>;

	/**
	 * Parse / validate the LLM's value for this field. Default: identity.
	 *
	 * Two failure modes (lifted from BAML's @check vs @assert):
	 *
	 * - Return `null` — soft fail. The field is treated as empty; the
	 * evaluator's handler is skipped. Logged for observability. Other
	 * fields still process.
	 * - Throw — hard fail. The whole Stage-1 call surfaces an error to the
	 * caller. Use this for invariants you absolutely cannot proceed past
	 * (e.g., schema parse succeeded but the value references a forbidden
	 * resource).
	 */
	parse?(value: unknown, ctx: ResponseHandlerFieldContext): TValue | null;

	/**
	 * Run the field's effect. Called once per turn (if `shouldRun` was
	 * truthy and `parse` did not soft-fail) with the parsed value for this
	 * field and a read-only view of all sibling fields.
	 *
	 * Return a `ResponseHandlerFieldEffect` to mutate the result or preempt
	 * the downstream routing. Return `undefined` to leave routing unchanged.
	 */
	handle?(
		ctx: ResponseHandlerFieldHandleContext<TValue>,
	):
		| ResponseHandlerFieldEffect
		| undefined
		| Promise<ResponseHandlerFieldEffect | undefined>;
}

export interface ResponseHandlerFieldTrace {
	fieldName: string;
	active: boolean;
	parsed: boolean;
	parseOutcome: "ok" | "soft-fail" | "hard-fail" | "skipped";
	handled: boolean;
	preempted: boolean;
	preemptMode?: "ack-and-stop" | "ignore" | "direct-reply";
	preemptReason?: string;
	debug?: string[];
	errorMessage?: string;
}

export interface ResponseHandlerFieldRunResult {
	parsed: ResponseHandlerResult;
	traces: ResponseHandlerFieldTrace[];
	preempt?: {
		mode: "ack-and-stop" | "ignore" | "direct-reply";
		reason: string;
	};
	// Aggregated soft/hard failures, indexed by field name. Useful for the
	// benchmark harness and for logging.
	fieldErrors: Record<string, string>;
}

/**
 * Owns the registered set of field evaluators and provides the composition
 * primitives (schema, prompt, dispatch) used by the Stage-1 response handler.
 * The registry de-dupes by `name` (first-wins, matches runtime.registerAction)
 * and throws when a registration would violate strict-schema rules.
 */
export class ResponseHandlerFieldRegistry {
	private evaluators = new Map<string, ResponseHandlerFieldEvaluator>();
	private cachedSchema: JSONSchema | null = null;
	private cachedSchemaSignature: string | null = null;
	private cachedSorted: ReadonlyArray<ResponseHandlerFieldEvaluator> | null =
		null;

	register(evaluator: ResponseHandlerFieldEvaluator): void {
		if (!evaluator.name || typeof evaluator.name !== "string") {
			throw new Error(
				"ResponseHandlerFieldEvaluator must have a non-empty name",
			);
		}
		if (!evaluator.description || typeof evaluator.description !== "string") {
			throw new Error(
				`ResponseHandlerFieldEvaluator '${evaluator.name}' must have a non-empty description (used verbatim in the system prompt)`,
			);
		}
		if (!evaluator.schema || typeof evaluator.schema !== "object") {
			throw new Error(
				`ResponseHandlerFieldEvaluator '${evaluator.name}' must declare a JSONSchema`,
			);
		}
		if (this.evaluators.has(evaluator.name)) {
			return; // First registration wins, matches Action de-dup behavior
		}
		this.evaluators.set(evaluator.name, evaluator);
		this.invalidateCaches();
	}

	unregister(name: string): boolean {
		const removed = this.evaluators.delete(name);
		if (removed) this.invalidateCaches();
		return removed;
	}

	private invalidateCaches(): void {
		this.cachedSchema = null;
		this.cachedSchemaSignature = null;
		this.cachedSorted = null;
	}

	list(
		options: ResponseHandlerFieldSelectionOptions = {},
	): ReadonlyArray<ResponseHandlerFieldEvaluator> {
		return this.sortedEvaluators(options);
	}

	size(): number {
		return this.evaluators.size;
	}

	/**
	 * Build the composed HANDLE_RESPONSE schema. Cached across calls; the
	 * cache invalidates only when registrations change. The schema is the
	 * same bytes every turn, which is what keeps Anthropic / OpenAI prompt
	 * caches warm.
	 *
	 * All fields are REQUIRED (per the user directive). The LLM emits the
	 * declared empty value for fields that don't apply this turn.
	 *
	 * Canonical-source note: this is the schema the Stage-1 LLM actually
	 * receives in production — `services/message.ts` passes it to
	 * `createHandleResponseTool({ parameters:... })`, and `buildResponseGrammar`
	 * (`./response-grammar.ts`) composes the GBNF skeleton from the same
	 * registered field set. The static `HANDLE_RESPONSE_SCHEMA` in
	 * `../actions/to-tool.ts` mirrors the builtin shape for older callers that
	 * build the tool without passing an explicit registry-composed schema.
	 */
	composeSchema(
		options: ResponseHandlerFieldSelectionOptions = {},
	): JSONSchema {
		const selectionKey = fieldSelectionKey(options);
		if (!selectionKey && this.cachedSchema) return this.cachedSchema;
		const sorted = this.sortedEvaluators(options);
		const properties: Record<string, JSONSchema> = {};
		const required: string[] = [];
		for (const evaluator of sorted) {
			properties[evaluator.name] = evaluator.schema;
			required.push(evaluator.name);
		}
		const schema: JSONSchema = {
			type: "object",
			additionalProperties: false,
			properties,
			required,
		};
		if (selectionKey) return schema;
		this.cachedSchema = schema;
		this.cachedSchemaSignature = JSON.stringify(schema);
		return schema;
	}

	/**
	 * Hash-like signature of the composed schema. Used by the cache plan to
	 * detect "schema changed → invalidate prompt cache" situations. Stable
	 * across boots as long as the registered set is the same.
	 */
	composeSchemaSignature(
		options: ResponseHandlerFieldSelectionOptions = {},
	): string {
		const selectionKey = fieldSelectionKey(options);
		if (selectionKey) return JSON.stringify(this.composeSchema(options));
		if (!this.cachedSchemaSignature) this.composeSchema();
		return this.cachedSchemaSignature ?? "";
	}

	/**
	 * Compose the per-turn system-prompt slices. Each active evaluator
	 * contributes its complete `description` verbatim. The composition is one big
	 * markdown block of `### {name}\n{description}` sections in priority
	 * order — matching how the post-turn EvaluatorService composes its prompt
	 * at services/evaluator.ts:327-333.
	 *
	 * Request-scoped field facts are returned separately as context; callers
	 * must render them in dynamic input, not the stable instructions or schema.
	 * Also returns active field names for the trace.
	 */
	async composePromptSlices(
		ctx: ResponseHandlerFieldContext,
		options: ResponseHandlerFieldSelectionOptions = {},
	): Promise<{
		rendered: string;
		context: string;
		activeFieldNames: string[];
		skippedFieldNames: string[];
	}> {
		const sorted = this.sortedEvaluators(options);
		const sections: string[] = [];
		const context: string[] = [];
		const active: string[] = [];
		const skipped: string[] = [];
		for (const evaluator of sorted) {
			const should = evaluator.shouldRun
				? await evaluator.shouldRun(ctx)
				: true;
			if (should) {
				active.push(evaluator.name);
				sections.push(`### ${evaluator.name}\n${evaluator.description}`);
				const facts = await evaluator.getContext?.(ctx);
				if (facts?.trim()) context.push(`### ${evaluator.name}\n${facts}`);
			} else {
				skipped.push(evaluator.name);
				// Field stays declared in schema; instruct LLM to emit its empty value.
				sections.push(
					`### ${evaluator.name}\nN/A this turn; emit empty value.`,
				);
			}
		}
		return {
			rendered: sections.join("\n\n"),
			context: context.join("\n\n"),
			activeFieldNames: active,
			skippedFieldNames: skipped,
		};
	}

	/**
	 * Parse the LLM's structured output, then dispatch each field's slice to
	 * its handler in priority order. Every active field is parsed before any
	 * handler runs, so a handler sees all siblings in canonical form and a
	 * later field's parse never overwrites its mutation: a field generated
	 * before `replyText` can still replace the reply. Handlers may preempt
	 * downstream processing (abort, ack-and-stop, ignore, direct-reply).
	 *
	 * Active set is recomputed here (we don't trust the prompt-slice run to
	 * tell us — the prompt is rendered into stable cache and may be reused
	 * across turns where shouldRun returned different values).
	 */
	async dispatch(args: {
		rawParsed: Record<string, unknown>;
		runtime: IAgentRuntime;
		message: Memory;
		state: State;
		senderRole: ResponseHandlerSenderRole;
		turnSignal: AbortSignal;
	}): Promise<ResponseHandlerFieldRunResult> {
		const traces: ResponseHandlerFieldTrace[] = [];
		const fieldErrors: Record<string, string> = {};
		let preempt:
			| { mode: "ack-and-stop" | "ignore" | "direct-reply"; reason: string }
			| undefined;

		// Build a fully-defaulted result first. Any field the LLM omitted
		// (shouldn't happen with strict mode, but defensively) gets its empty
		// value. Plugin fields fall through with `null` if no parse was set.
		const evaluators = this.sortedEvaluators();
		const parsed = buildDefaultedResult(evaluators, args.rawParsed);

		const baseCtx: ResponseHandlerFieldContext = {
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			senderRole: args.senderRole,
			turnSignal: args.turnSignal,
		};

		const handlers: Array<{
			evaluator: ResponseHandlerFieldEvaluator;
			trace: ResponseHandlerFieldTrace;
			value: unknown;
		}> = [];
		for (const evaluator of evaluators) {
			const trace: ResponseHandlerFieldTrace = {
				fieldName: evaluator.name,
				active: true,
				parsed: false,
				parseOutcome: "skipped",
				handled: false,
				preempted: false,
			};
			try {
				const should = evaluator.shouldRun
					? await evaluator.shouldRun(baseCtx)
					: true;
				if (!should) {
					trace.active = false;
					traces.push(trace);
					continue;
				}

				// Parse this field's slice.
				const raw = args.rawParsed[evaluator.name];
				let value: unknown = raw;
				if (evaluator.parse) {
					try {
						const parsedValue = evaluator.parse(raw, baseCtx);
						if (parsedValue === null) {
							trace.parseOutcome = "soft-fail";
							traces.push(trace);
							fieldErrors[evaluator.name] = "parse returned null (soft fail)";
							continue;
						}
						value = parsedValue;
					} catch (error) {
						// A cancelled turn is not a field failure: stop here
						// and let the turn end as cancelled.
						if (error instanceof TurnAbortedError) throw error;
						// error-policy:J1 Field parsing appends an explicit
						// hard-fail trace while independent fields continue.
						trace.parseOutcome = "hard-fail";
						const messageStr =
							error instanceof Error ? error.message : String(error);
						trace.errorMessage = messageStr;
						fieldErrors[evaluator.name] = messageStr;
						traces.push(trace);
						// Hard-fail: surface for caller, but keep processing siblings.
						args.runtime.logger.warn(
							{
								src: "response-handler-field-registry",
								field: evaluator.name,
								err: messageStr,
							},
							"Response-handler field parse hard-failed",
						);
						args.runtime.reportError(
							"ResponseHandlerFieldRegistry.parse",
							error,
							{ evaluator: evaluator.name },
						);
						continue;
					}
				}
				trace.parsed = true;
				trace.parseOutcome = "ok";
				// Re-stamp the parsed result with the post-parse value so siblings
				// see the canonical form.
				parsed[evaluator.name] = value;
				traces.push(trace);
				if (evaluator.handle) handlers.push({ evaluator, trace, value });
			} catch (error) {
				// A cancelled turn is not a field failure: stop here and let
				// the turn end as cancelled.
				if (error instanceof TurnAbortedError) throw error;
				// error-policy:J1 Field activation appends an explicit failure
				// trace while independent fields continue.
				const messageStr =
					error instanceof Error ? error.message : String(error);
				trace.errorMessage = messageStr;
				fieldErrors[evaluator.name] = messageStr;
				traces.push(trace);
				args.runtime.logger.warn(
					{
						src: "response-handler-field-registry",
						field: evaluator.name,
						err: messageStr,
					},
					"Response-handler field shouldRun failed",
				);
				args.runtime.reportError(
					"ResponseHandlerFieldRegistry.shouldRun",
					error,
					{ evaluator: evaluator.name },
				);
			}
		}

		for (const { evaluator, trace, value } of handlers) {
			try {
				if (args.turnSignal.aborted) {
					// A prior preempt already fired abort. Skip remaining handlers.
					continue;
				}
				const handleCtx: ResponseHandlerFieldHandleContext<unknown> = {
					...baseCtx,
					value,
					parsed,
				};
				const effect = await evaluator.handle?.(handleCtx);
				trace.handled = true;
				if (effect?.debug?.length) {
					trace.debug = effect.debug.slice();
				}
				if (effect?.mutateResult) {
					effect.mutateResult(parsed);
				}
				if (effect?.preempt) {
					trace.preempted = true;
					trace.preemptMode = effect.preempt.mode;
					trace.preemptReason = effect.preempt.reason;
					preempt = effect.preempt;
				}
				if (preempt) {
					// Don't run further handlers after a preempt.
					break;
				}
			} catch (error) {
				// A cancelled turn is not a field failure: stop here and let
				// the turn end as cancelled.
				if (error instanceof TurnAbortedError) throw error;
				// error-policy:J1 Field handling appends an explicit failure trace
				// while independent fields continue.
				const messageStr =
					error instanceof Error ? error.message : String(error);
				trace.errorMessage = messageStr;
				fieldErrors[evaluator.name] = messageStr;
				args.runtime.logger.warn(
					{
						src: "response-handler-field-registry",
						field: evaluator.name,
						err: messageStr,
					},
					"Response-handler field handler failed",
				);
				args.runtime.reportError("ResponseHandlerFieldRegistry.handle", error, {
					evaluator: evaluator.name,
				});
			}
		}

		return {
			parsed,
			traces,
			preempt,
			fieldErrors,
		};
	}

	private sortedEvaluators(
		options: ResponseHandlerFieldSelectionOptions = {},
	): ReadonlyArray<ResponseHandlerFieldEvaluator> {
		const includeNames = normalizeFieldSelection(options);
		if (!includeNames) {
			this.cachedSorted ??= [...this.evaluators.values()].sort(
				compareEvaluators,
			);
			return this.cachedSorted;
		}
		return [...this.evaluators.values()]
			.filter((evaluator) => includeNames.has(evaluator.name))
			.sort(compareEvaluators);
	}
}

function compareEvaluators(
	a: ResponseHandlerFieldEvaluator,
	b: ResponseHandlerFieldEvaluator,
): number {
	const pa = a.priority ?? 100;
	const pb = b.priority ?? 100;
	if (pa !== pb) return pa - pb;
	return a.name.localeCompare(b.name);
}

export interface ResponseHandlerFieldSelectionOptions {
	includeFieldNames?: ReadonlySet<string> | readonly string[];
}

function normalizeFieldSelection(
	options: ResponseHandlerFieldSelectionOptions,
): ReadonlySet<string> | null {
	const include = options.includeFieldNames;
	if (!include) return null;
	return new Set([...include].filter(Boolean));
}

function fieldSelectionKey(
	options: ResponseHandlerFieldSelectionOptions,
): string {
	const include = normalizeFieldSelection(options);
	return include ? [...include].sort().join("\0") : "";
}

/**
 * Build a fully-defaulted ResponseHandlerResult from the raw LLM output.
 * Strict-mode schemas SHOULD guarantee all fields are present, but defend
 * against malformed output by filling missing values from the field's
 * schema-declared empty value.
 */
function buildDefaultedResult(
	evaluators: ReadonlyArray<ResponseHandlerFieldEvaluator>,
	raw: Record<string, unknown>,
): ResponseHandlerResult {
	const result = { ...raw } as Record<string, unknown>;
	for (const evaluator of evaluators) {
		if (result[evaluator.name] === undefined) {
			result[evaluator.name] = defaultValueForSchema(evaluator.schema);
		}
	}
	return result as ResponseHandlerResult;
}

function defaultValueForSchema(schema: JSONSchema): unknown {
	if (!schema || typeof schema !== "object") return null;
	const type = (schema as { type?: unknown }).type;
	if (Array.isArray(type)) {
		// Pick the first non-null type; fall back to null.
		const first = type.find((t) => t !== "null") as string | undefined;
		return defaultValueForType(first ?? "null");
	}
	if (typeof type === "string") return defaultValueForType(type);
	return null;
}

function defaultValueForType(type: string): unknown {
	switch (type) {
		case "string":
			return "";
		case "array":
			return [];
		case "object":
			return {};
		case "boolean":
			return false;
		case "integer":
		case "number":
			return 0;
		default:
			return null;
	}
}
