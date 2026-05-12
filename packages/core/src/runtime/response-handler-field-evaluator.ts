/**
 * ResponseHandlerFieldEvaluator — registration pattern for the Stage-1 response
 * handler's structured output.
 *
 * The Stage-1 LLM call (`ModelType.RESPONSE_HANDLER`) populates a single flat
 * JSON object via the HANDLE_RESPONSE tool. Each top-level property of that
 * object is owned by a registered `ResponseHandlerFieldEvaluator`. The runtime:
 *
 *   1. Collects all registered evaluators (core + plugins).
 *   2. Filters by `shouldRun(ctx)` — per-turn activation gate.
 *   3. Composes ONE JSON schema (all active evaluators contribute one slice).
 *   4. Composes ONE prompt (each active evaluator contributes one slice).
 *   5. Calls the LLM once.
 *   6. Dispatches each parsed field value to its owning evaluator's
 *      `handle(value, ctx)` in priority order. Handlers mutate the
 *      MessageHandlerResult and may emit side effects (abort, retrieval,
 *      memory writes, etc).
 *
 * Schema stability for caching:
 *
 * - The composed schema is BYTE-STABLE across turns provided the registered
 *   set is stable. Plugin load is the only time the schema changes.
 * - `shouldRun` does NOT add or remove fields from the schema — it controls
 *   whether the field's prompt slice is included (so the LLM is instructed
 *   to populate it) and whether the field's handler runs after parse.
 *   The field stays declared in the schema (typed as the field's `schema` |
 *   the empty default), so the schema bytes are identical every turn.
 *
 * Required-by-default:
 *
 * - All fields are REQUIRED. The LLM must populate every field. For N/A
 *   the LLM emits the field's declared empty value (empty array, empty
 *   string, "IGNORE", etc.). This eliminates the "did the model skip this
 *   field?" failure mode and maps cleanly to OpenAI strict mode and
 *   Anthropic tool-use schema validation.
 *
 * Pipeline handler semantics:
 *
 * - Handlers run in priority order. Earlier handlers can short-circuit the
 *   rest by calling `ctx.preempt(reason)` — this is how abort works: the
 *   threadOps handler calls `runtime.abortTurn` and preempts, suppressing
 *   the subsequent route-to-planner step.
 * - Handlers receive the FULL parsed object plus their own field's value.
 *   They can read sibling values but should not mutate them — mutations
 *   go through the messageHandler result object.
 */

import type { Memory } from "../types/memory";
import type { JSONSchema } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

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
 * The flat, all-required result of one Stage-1 LLM call. Replaces the legacy
 * nested `{ processMessage, plan: {...}, thought, extract: {...} }` shape.
 *
 * Field ownership:
 *   shouldRespond        - core
 *   contexts             - core
 *   intents              - core
 *   candidateActionNames - core
 *   replyText            - core
 *   facts                - core (memory pipeline)
 *   relationships        - core (memory pipeline)
 *   addressedTo          - core (memory pipeline)
 *   threadOps            - app-lifeops (includes abort)
 *   <plugin fields>      - registered by plugins
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

// ---------------------------------------------------------------------------
// Context passed to evaluators
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-field result emitted by handlers
// ---------------------------------------------------------------------------

/**
 * What a handler can affect:
 *
 * - `mutateResult(result)` — patch the running ResponseHandlerResult.
 *   Use sparingly; prefer letting downstream consumers read the parsed
 *   value directly.
 * - `preempt: {reason}` — stop processing remaining handlers and route to
 *   a terminal outcome. Used by abort (skip planner, skip reply send) and
 *   by IGNORE/STOP equivalents.
 * - `debug` — strings recorded into the trace for observability.
 */
export interface ResponseHandlerFieldEffect {
	mutateResult?: (result: ResponseHandlerResult) => void;
	preempt?: {
		/**
		 * What to do instead of the default route-to-planner / send-reply flow.
		 *
		 *   - "ack-and-stop": agent emits a short ack reply and stops (used by
		 *     abort, where the abort handler has already shut down in-flight work).
		 *   - "ignore": agent emits nothing.
		 *   - "direct-reply": agent uses the current `replyText` as the final reply.
		 */
		mode: "ack-and-stop" | "ignore" | "direct-reply";
		reason: string;
	};
	debug?: string[];
}

// ---------------------------------------------------------------------------
// The evaluator contract
// ---------------------------------------------------------------------------

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

	/**
	 * Execution order. Lower runs first. Defaults to 100. Conventions:
	 *
	 *   0-19   - core routing fields (shouldRespond, contexts)
	 *   20-49  - plugin-contributed action surfaces (threadOps, calendar, etc.)
	 *   50-79  - retrieval hints (candidateActionNames)
	 *   80-99  - extract/memory pipeline (facts, relationships, addressedTo)
	 */
	priority?: number;

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
	 *   included in the system prompt; the LLM is instructed to populate
	 *   the field. The field's handler runs after parse.
	 * - When `false`: the prompt slice is omitted (no instruction to
	 *   populate); after parse, the handler is skipped. The field stays
	 *   declared in the schema for cache stability — the LLM emits the
	 *   declared empty value.
	 *
	 * Must be cheap. Avoid LLM calls or heavy I/O. Database lookups acceptable
	 * if cached.
	 */
	shouldRun?(ctx: ResponseHandlerFieldContext): boolean | Promise<boolean>;

	/**
	 * Parse / validate the LLM's value for this field. Default: identity.
	 *
	 * Two failure modes (lifted from BAML's @check vs @assert):
	 *
	 * - Return `null` — soft fail. The field is treated as empty; the
	 *   evaluator's handler is skipped. Logged for observability. Other
	 *   fields still process.
	 * - Throw — hard fail. The whole Stage-1 call surfaces an error to the
	 *   caller. Use this for invariants you absolutely cannot proceed past
	 *   (e.g., schema parse succeeded but the value references a forbidden
	 *   resource).
	 */
	parse?(value: unknown, ctx: ResponseHandlerFieldContext): TValue | null;

	/**
	 * Run the field's effect. Called once per turn (if `shouldRun` was
	 * truthy and `parse` did not soft-fail) with the parsed value for this
	 * field and a read-only view of all sibling fields.
	 *
	 * Return a `ResponseHandlerFieldEffect` to mutate the result or preempt
	 * the downstream routing. Return `undefined` for no-op.
	 */
	handle?(
		ctx: ResponseHandlerFieldHandleContext<TValue>,
	):
		| ResponseHandlerFieldEffect
		| undefined
		| Promise<ResponseHandlerFieldEffect | undefined>;
}

// ---------------------------------------------------------------------------
// Run trace — recorded per turn for observability and InterruptBench
// assertions.
// ---------------------------------------------------------------------------

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
