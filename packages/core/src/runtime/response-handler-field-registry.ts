/**
 * ResponseHandlerFieldRegistry — owns the registered set of field evaluators
 * and provides the composition primitives (schema, prompt, dispatch) used by
 * the Stage-1 response handler.
 *
 * See ./response-handler-field-evaluator.ts for the contract.
 */

import type { Memory } from "../types/memory";
import type { JSONSchema } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import type {
	ResponseHandlerFieldContext,
	ResponseHandlerFieldEvaluator,
	ResponseHandlerFieldHandleContext,
	ResponseHandlerFieldRunResult,
	ResponseHandlerFieldTrace,
	ResponseHandlerResult,
	ResponseHandlerSenderRole,
} from "./response-handler-field-evaluator.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Stable registration. The registry de-dupes by `name` (first-wins, matches
 * runtime.registerAction). Throws when a registration would violate strict-
 * schema rules.
 */
export class ResponseHandlerFieldRegistry {
	private evaluators = new Map<string, ResponseHandlerFieldEvaluator>();
	private cachedSchema: JSONSchema | null = null;
	private cachedSchemaSignature: string | null = null;

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
		this.cachedSchema = null;
		this.cachedSchemaSignature = null;
	}

	unregister(name: string): boolean {
		const removed = this.evaluators.delete(name);
		if (removed) {
			this.cachedSchema = null;
			this.cachedSchemaSignature = null;
		}
		return removed;
	}

	list(): ReadonlyArray<ResponseHandlerFieldEvaluator> {
		return this.sortedEvaluators();
	}

	size(): number {
		return this.evaluators.size;
	}

	// -------------------------------------------------------------------------
	// Schema composition — byte-stable across turns
	// -------------------------------------------------------------------------

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
	 * `createHandleResponseTool({ parameters: ... })`, and `buildResponseGrammar`
	 * (`./response-grammar.ts`) composes the GBNF skeleton from the same
	 * registered field set. The static `HANDLE_RESPONSE_SCHEMA` /
	 * `HANDLE_RESPONSE_DIRECT_SCHEMA` in `../actions/to-tool.ts` are the legacy
	 * W3 flat-envelope shape (different field set) kept only as the default tool
	 * `parameters` and for the back-compat trajectory parser; see the
	 * `TODO(consolidate)` block on `HANDLE_RESPONSE_SCHEMA` there for why the two
	 * have not yet been unified.
	 */
	composeSchema(): JSONSchema {
		if (this.cachedSchema) return this.cachedSchema;
		const sorted = this.sortedEvaluators();
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
		this.cachedSchema = schema;
		this.cachedSchemaSignature = JSON.stringify(schema);
		return schema;
	}

	/**
	 * Hash-like signature of the composed schema. Used by the cache plan to
	 * detect "schema changed → invalidate prompt cache" situations. Stable
	 * across boots as long as the registered set is the same.
	 */
	composeSchemaSignature(): string {
		if (!this.cachedSchemaSignature) this.composeSchema();
		return this.cachedSchemaSignature ?? "";
	}

	// -------------------------------------------------------------------------
	// Prompt composition — slices per active evaluator
	// -------------------------------------------------------------------------

	/**
	 * Compose the per-turn system-prompt slices. Each active evaluator
	 * contributes its `description` verbatim. The composition is one big
	 * markdown block of `### {name}\n{description}` sections in priority
	 * order — matching how the post-turn EvaluatorService composes its prompt
	 * at services/evaluator.ts:327-333.
	 *
	 * Returns both the rendered string and the list of active field names
	 * (for the trace).
	 */
	async composePromptSlices(ctx: ResponseHandlerFieldContext): Promise<{
		rendered: string;
		activeFieldNames: string[];
		skippedFieldNames: string[];
	}> {
		const sorted = this.sortedEvaluators();
		const sections: string[] = [];
		const active: string[] = [];
		const skipped: string[] = [];
		for (const evaluator of sorted) {
			const should = evaluator.shouldRun
				? await evaluator.shouldRun(ctx)
				: true;
			if (should) {
				active.push(evaluator.name);
				sections.push(`### ${evaluator.name}\n${evaluator.description}`);
			} else {
				skipped.push(evaluator.name);
				// Field stays declared in schema; instruct LLM to emit its empty value.
				sections.push(
					`### ${evaluator.name}\nNot applicable this turn — emit the field's empty value.`,
				);
			}
		}
		return {
			rendered: sections.join("\n\n"),
			activeFieldNames: active,
			skippedFieldNames: skipped,
		};
	}

	// -------------------------------------------------------------------------
	// Dispatch — parse + handle each field
	// -------------------------------------------------------------------------

	/**
	 * Parse the LLM's structured output and dispatch each field's slice to
	 * its handler in priority order. Handlers may preempt downstream
	 * processing (abort, ack-and-stop, ignore, direct-reply).
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
		const parsed = buildDefaultedResult(
			this.sortedEvaluators(),
			args.rawParsed,
		);

		const baseCtx: ResponseHandlerFieldContext = {
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			senderRole: args.senderRole,
			turnSignal: args.turnSignal,
		};

		for (const evaluator of this.sortedEvaluators()) {
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
					trace.parseOutcome = "skipped";
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
						trace.parseOutcome = "hard-fail";
						const messageStr =
							error instanceof Error ? error.message : String(error);
						trace.errorMessage = messageStr;
						fieldErrors[evaluator.name] = messageStr;
						traces.push(trace);
						// Hard-fail: surface for caller, but keep processing siblings.
						args.runtime.logger?.warn?.(
							{
								src: "response-handler-field-registry",
								field: evaluator.name,
								err: messageStr,
							},
							"Response-handler field parse hard-failed",
						);
						continue;
					}
				}
				trace.parsed = true;
				trace.parseOutcome = "ok";
				// Re-stamp the parsed result with the post-parse value so siblings
				// see the canonical form.
				parsed[evaluator.name] = value;

				// Run the handler.
				if (!evaluator.handle) {
					traces.push(trace);
					continue;
				}
				if (args.turnSignal.aborted) {
					// A prior preempt already fired abort. Skip remaining handlers.
					trace.handled = false;
					traces.push(trace);
					continue;
				}
				const handleCtx: ResponseHandlerFieldHandleContext<unknown> = {
					...baseCtx,
					value,
					parsed,
				};
				const effect = await evaluator.handle(handleCtx);
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
				traces.push(trace);
				if (preempt) {
					// Don't run further handlers after a preempt.
					break;
				}
			} catch (error) {
				const messageStr =
					error instanceof Error ? error.message : String(error);
				trace.errorMessage = messageStr;
				fieldErrors[evaluator.name] = messageStr;
				traces.push(trace);
				args.runtime.logger?.warn?.(
					{
						src: "response-handler-field-registry",
						field: evaluator.name,
						err: messageStr,
					},
					"Response-handler field handler failed",
				);
			}
		}

		return {
			parsed,
			traces,
			preempt,
			fieldErrors,
		};
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	private sortedEvaluators(): ReadonlyArray<ResponseHandlerFieldEvaluator> {
		return [...this.evaluators.values()].sort((a, b) => {
			const pa = a.priority ?? 100;
			const pb = b.priority ?? 100;
			if (pa !== pb) return pa - pb;
			return a.name.localeCompare(b.name);
		});
	}
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
