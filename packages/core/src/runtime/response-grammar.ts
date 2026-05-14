/**
 * Per-turn grammar / response-skeleton generation for the Stage-1 response
 * handler and the Stage-2 planner.
 *
 * Eliza-1 is the local voice target: we get to shape the response envelope, the
 * action/evaluator registration, and the decode loop to match. This module is
 * the *producer* side — it walks the registered actions, the registered
 * Stage-1 field evaluators, and the available context ids and emits a
 * {@link ResponseSkeleton} (engine-neutral structure-forcing description) plus,
 * where the skeleton can't express a constraint (the `contexts` array is an
 * array whose *elements* are drawn from a fixed enum), an explicit GBNF
 * `grammar` string. The local llama-server engine (W4,
 * `packages/app-core/src/services/local-inference/structured-output.ts`)
 * consumes either: `grammar` wins, else it compiles the skeleton to a lazy
 * GBNF. Cloud adapters ignore both — `responseSchema` / `tools` carry the
 * equivalent (unforced) contract for them, so there is no fallback branch here.
 *
 * Source of truth:
 *   `ResponseHandlerFieldRegistry.composeSchema()`
 *   (`./response-handler-field-registry.ts`) is canonical. Production Stage 1
 *   sends that composed schema as the HANDLE_RESPONSE tool's `parameters`, and
 *   when registered field evaluators are supplied here `buildResponseGrammar`
 *   emits the *same* field-registry envelope in priority order — schema, prompt
 *   slices, and GBNF skeleton all derive from one registered set. The legacy
 *   fixed W3 envelope (`STAGE1_ENVELOPE_KEYS` below, mirroring
 *   `HANDLE_RESPONSE_SCHEMA` in `../actions/to-tool.ts`) remains only as a
 *   compatibility fallback for tests or older callers that do not pass field
 *   evaluators. See the `TODO(consolidate)` block on `HANDLE_RESPONSE_SCHEMA`.
 *
 * Caching: `buildResponseGrammar` is pure given the runtime registries
 * snapshot. The result is byte-stable across turns when the registries haven't
 * changed, so callers may cache on the returned `responseSkeleton.id` (which is
 * derived from the field-registry signature + the context-id set + the channel
 * flag + the action set). A small process-wide cache is kept here keyed on that
 * id.
 */

import {
	type JsonSchema,
	normalizeActionJsonSchema,
} from "../actions/action-schema.js";
import type { Action } from "../types/components.js";
import type {
	JSONSchema,
	ResponseSkeleton,
	ResponseSkeletonSpan,
} from "../types/model.js";

// ---------------------------------------------------------------------------
// Stage-1 envelope (FALLBACK ONLY): fixed key order matching the legacy W3
// `HANDLE_RESPONSE_SCHEMA` in `../actions/to-tool.ts`. Used only when no Stage-1
// field evaluators are registered (tests / older callers). Production always
// has the builtin evaluators registered, so the field-registry path below wins.
// ---------------------------------------------------------------------------

/** `shouldRespond` enum values, in the order the model should try them. */
const SHOULD_RESPOND_VALUES = ["RESPOND", "IGNORE", "STOP"] as const;

/**
 * Channel types that drop the explicit `shouldRespond` flag (DM / API / SELF).
 * Voice is intentionally excluded: turn-taking can be IGNORE when VAD/STT says
 * the user is mid-utterance or the next speaker is not the agent.
 */
const DIRECT_CHANNEL_TYPES: ReadonlySet<string> = new Set([
	"DM",
	"API",
	"SELF",
]);

/**
 * Fixed top-level keys of the W3 flat envelope, in emit order. `shouldRespond`
 * is prepended only on the non-direct path.
 */
const STAGE1_ENVELOPE_KEYS = [
	"thought",
	"replyText",
	"contexts",
	"contextSlices",
	"candidateActions",
	"parentActionHints",
	"requiresTool",
	"extract",
] as const;

/** Which envelope keys are string-valued (free-string spans). */
const STAGE1_STRING_KEYS: ReadonlySet<string> = new Set([
	"thought",
	"replyText",
]);
/** Which envelope keys are array-of-string (free-json arrays). */
const STAGE1_STRING_ARRAY_KEYS: ReadonlySet<string> = new Set([
	"contextSlices",
	"candidateActions",
	"parentActionHints",
]);
/** Which envelope keys are boolean (free-json — `true` / `false`). */
const STAGE1_BOOLEAN_KEYS: ReadonlySet<string> = new Set(["requiresTool"]);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A registered Stage-1 field evaluator, narrowed to the bits this module needs
 * (name / priority / schema). The full contract lives in
 * `runtime/response-handler-field-evaluator.ts`; we keep the dependency
 * structural so this module doesn't drag the registry's transitive imports
 * into the browser bundle.
 */
export interface ResponseHandlerFieldShape {
	name: string;
	priority?: number;
	schema: JSONSchema;
}

/**
 * Minimal runtime view `buildResponseGrammar` needs. Accepting this rather than
 * the full `IAgentRuntime` keeps the function testable in isolation.
 */
export interface ResponseGrammarRuntimeView {
	/** Registered actions (the planner's action universe). */
	actions: ReadonlyArray<
		Pick<Action, "name" | "parameters" | "allowAdditionalParameters">
	>;
	/**
	 * Registered Stage-1 field evaluators. Pass
	 * `runtime.responseHandlerFieldRegistry.list()` here. May be omitted /
	 * empty when no plugin registered any.
	 */
	responseHandlerFields?: ReadonlyArray<ResponseHandlerFieldShape>;
	/**
	 * The composed-schema signature of the field registry — used to key the
	 * compiled-grammar cache. Pass
	 * `runtime.responseHandlerFieldRegistry.composeSchemaSignature()`. Optional;
	 * when omitted a signature is derived from `responseHandlerFields`.
	 */
	responseHandlerFieldSignature?: string;
}

export interface BuildResponseGrammarOptions {
	/**
	 * Context ids the model may engage this turn (the `contexts` array's
	 * element enum). Pass `runtime.contexts.listAvailable(roles).map(d => d.id)`.
	 * `simple` and `general` are always merged in if absent so the model can
	 * always route to the direct path / planning-against-general.
	 */
	contexts: ReadonlyArray<string>;
	/**
	 * The inbound message's channel type (`ChannelType.*` string). On
	 * DM/API/SELF drop the `shouldRespond` span. Voice channels keep it because
	 * semantic turn-taking can choose IGNORE.
	 */
	channelType?: string;
	/**
	 * Override the registered action universe (e.g. the per-turn exposed action
	 * set). When omitted, `runtime.actions` is used.
	 */
	actions?: ReadonlyArray<
		Pick<Action, "name" | "parameters" | "allowAdditionalParameters">
	>;
}

export interface ResponseGrammarResult {
	/** Engine-neutral structure-forcing description (W4 compiles to lazy GBNF). */
	responseSkeleton: ResponseSkeleton;
	/**
	 * Precise GBNF grammar string for the Stage-1 envelope, including the
	 * `contexts` array-of-enum constraint (which the flat span model can't
	 * express). W4's `resolveGrammarForParams` prefers this over the skeleton.
	 * Always present for Stage-1.
	 */
	grammar: string;
}

// ---------------------------------------------------------------------------
// GBNF helpers
// ---------------------------------------------------------------------------

/** Escape a string for a GBNF double-quoted literal (C-style escapes). */
function gbnfEscapeLiteral(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
		else out += ch;
	}
	return out;
}

/** GBNF literal token for a fixed string `text`. */
function gbnfLiteral(text: string): string {
	return `"${gbnfEscapeLiteral(text)}"`;
}

/** GBNF literal token for the JSON-quoted form of `value` (i.e. `"value"`). */
function gbnfJsonStringLiteral(value: string): string {
	return gbnfLiteral(JSON.stringify(value));
}

/** Shared GBNF rule bodies, inlined so the grammar is self-contained. */
const GBNF_RULE_BODIES: Record<string, string> = {
	jsonstring: '"\\"" ( [^"\\\\] | "\\\\" . )* "\\""',
	jsonvalue:
		'jsonobject | jsonarray | jsonstring | jsonnumber | "true" | "false" | "null"',
	jsonobject:
		'"{" ws ( jsonstring ws ":" ws jsonvalue ( ws "," ws jsonstring ws ":" ws jsonvalue )* )? ws "}"',
	jsonarray: '"[" ws ( jsonvalue ( ws "," ws jsonvalue )* )? ws "]"',
	jsonnumber:
		'"-"? ( [0-9] | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?',
	jsonstringarray: '"[" ws ( jsonstring ( ws "," ws jsonstring )* )? ws "]"',
	jsonbool: '"true" | "false"',
	ws: "[ \\t\\n\\r]*",
};

/**
 * Tiny GBNF builder: collects named rules + a root, dedupes, and pulls in the
 * transitive closure of referenced shared rules.
 */
class GbnfBuilder {
	private rules = new Map<string, string>();
	private rootParts: string[] = [];

	root(parts: string[]): this {
		this.rootParts = parts;
		return this;
	}

	rule(name: string, body: string): this {
		if (!this.rules.has(name)) this.rules.set(name, body);
		return this;
	}

	/** Add a shared rule by name (and its transitive deps). */
	useShared(name: string): this {
		if (this.rules.has(name)) return this;
		const body = GBNF_RULE_BODIES[name];
		if (body === undefined) return this;
		this.rules.set(name, body);
		// Pull in transitively referenced shared rules.
		for (const candidate of Object.keys(GBNF_RULE_BODIES)) {
			if (candidate === name) continue;
			const referenced = new RegExp(
				`(^|[^A-Za-z0-9_-])${candidate}([^A-Za-z0-9_-]|$)`,
			);
			if (referenced.test(body)) this.useShared(candidate);
		}
		return this;
	}

	build(): string {
		const lines = [`root ::= ${this.rootParts.join(" ")}`];
		for (const [name, body] of this.rules) lines.push(`${name} ::= ${body}`);
		return lines.join("\n");
	}
}

// ---------------------------------------------------------------------------
// Stage-1: buildResponseGrammar
// ---------------------------------------------------------------------------

const stage1Cache = new Map<string, ResponseGrammarResult>();

/** Stable hash of a string set (order-insensitive). */
function hashStringSet(values: ReadonlyArray<string>): string {
	const sorted = Array.from(new Set(values)).sort();
	let h = 5381 >>> 0;
	for (const v of sorted) {
		for (let i = 0; i < v.length; i += 1) {
			h = ((h << 5) + h + v.charCodeAt(i)) >>> 0;
		}
		h = ((h << 5) + h + 0x1f) >>> 0;
	}
	return h.toString(16);
}

function deriveFieldSignature(
	fields: ReadonlyArray<ResponseHandlerFieldShape>,
): string {
	const sorted = sortFields(fields);
	return sorted.map((f) => `${f.name}:${JSON.stringify(f.schema)}`).join("|");
}

function sortFields(
	fields: ReadonlyArray<ResponseHandlerFieldShape>,
): ResponseHandlerFieldShape[] {
	return [...fields].sort((a, b) => {
		const pa = a.priority ?? 100;
		const pb = b.priority ?? 100;
		if (pa !== pb) return pa - pb;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Normalize the supplied context-id list: dedupe, ensure `simple` and
 * `general` are present, drop empties, preserve registry order otherwise.
 */
function normalizeContextIds(contexts: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of contexts) {
		const trimmed = String(id ?? "").trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	for (const required of ["simple", "general"]) {
		if (!seen.has(required)) {
			seen.add(required);
			out.push(required);
		}
	}
	return out;
}

/**
 * Skeleton span kind for an envelope key's value.
 */
function spanKindForKey(key: string): ResponseSkeletonSpan["kind"] {
	if (STAGE1_STRING_KEYS.has(key)) return "free-string";
	// Arrays / booleans / objects all sample as a free JSON sub-document.
	return "free-json";
}

/**
 * Skeleton span kind for a registered field evaluator's value, derived from its
 * declared JSON schema.
 */
function spanKindForFieldSchema(
	schema: JSONSchema,
): ResponseSkeletonSpan["kind"] {
	const type = (schema as { type?: unknown }).type;
	if (type === "string") {
		const enumValues = (schema as { enum?: unknown }).enum;
		if (Array.isArray(enumValues) && enumValues.length === 1) return "literal";
		if (
			Array.isArray(enumValues) &&
			enumValues.length > 1 &&
			enumValues.every((v): v is string => typeof v === "string")
		) {
			return "enum";
		}
		return "free-string";
	}
	return "free-json";
}

function stringEnumValuesForFieldSchema(schema: JSONSchema): string[] {
	const enumValues = (schema as { enum?: unknown }).enum;
	return Array.isArray(enumValues) &&
		enumValues.every((v): v is string => typeof v === "string")
		? enumValues.map(String)
		: [];
}

/** GBNF rule reference for an envelope key's value. */
function gbnfRefForKey(builder: GbnfBuilder, key: string): string {
	if (STAGE1_STRING_KEYS.has(key)) {
		builder.useShared("jsonstring");
		return "jsonstring";
	}
	if (STAGE1_STRING_ARRAY_KEYS.has(key)) {
		builder.useShared("jsonstringarray");
		return "jsonstringarray";
	}
	if (STAGE1_BOOLEAN_KEYS.has(key)) {
		builder.useShared("jsonbool");
		return "jsonbool";
	}
	// extract — a free JSON object.
	builder.useShared("jsonvalue");
	return "jsonvalue";
}

/** GBNF rule reference for a registered field evaluator's value. */
function gbnfRefForFieldSchema(
	builder: GbnfBuilder,
	schema: JSONSchema,
): string {
	const type = (schema as { type?: unknown }).type;
	if (type === "string") {
		const enumValues = (schema as { enum?: unknown }).enum;
		if (
			Array.isArray(enumValues) &&
			enumValues.every(
				(v): v is string =>
					typeof v === "string" ||
					typeof v === "number" ||
					typeof v === "boolean",
			) &&
			enumValues.length >= 1
		) {
			if (enumValues.length === 1)
				return gbnfJsonStringLiteral(String(enumValues[0]));
			const ruleName = `fieldenum_${hashStringSet(enumValues.map(String))}`;
			builder.rule(
				ruleName,
				enumValues.map((v) => gbnfJsonStringLiteral(String(v))).join(" | "),
			);
			return ruleName;
		}
		builder.useShared("jsonstring");
		return "jsonstring";
	}
	builder.useShared("jsonvalue");
	return "jsonvalue";
}

/**
 * Build the Stage-1 response envelope skeleton + a precise GBNF grammar.
 *
 * The skeleton's spans, in order:
 *   `{` literal
 * Field-registry path:
 *   [one span per registered field evaluator, priority-ordered]
 *
 * Legacy fallback path (only when no fields are supplied):
 *   [non-direct only] `"shouldRespond":` literal → enum span (RESPOND/IGNORE/STOP)
 *   `,"thought":` (or `{"thought":` when direct) literal → free-string span
 *   `,"replyText":` literal → free-string span
 *   `,"contexts":` literal → free-json span (the grammar pins it to an
 *      array-of-enum; the skeleton can't express that, so it is the looser
 *      free-json there — engines that drive the skeleton get a free JSON array)
 *   `,"contextSlices":` literal → free-json span (string array)
 *   `,"candidateActions":` … `,"parentActionHints":` … `,"requiresTool":` …
 *   `,"extract":` literal → free-json span (object)
 *   `}` literal
 *
 * Single-value enums (e.g. a field evaluator whose schema is a one-element
 * string enum) lower to literal spans here — no tokens spent. The
 * `shouldRespond` enum stays an `enum` span (3 values).
 */
export function buildResponseGrammar(
	runtime: ResponseGrammarRuntimeView,
	options: BuildResponseGrammarOptions,
): ResponseGrammarResult {
	const direct =
		options.channelType !== undefined &&
		DIRECT_CHANNEL_TYPES.has(options.channelType);
	const fields = sortFields(runtime.responseHandlerFields ?? []);
	const contextIds = normalizeContextIds(options.contexts);
	const actionNames = Array.from(
		new Set(
			(options.actions ?? runtime.actions ?? [])
				.map((a) => a.name)
				.filter(Boolean),
		),
	).sort();
	const fieldSignature =
		runtime.responseHandlerFieldSignature ?? deriveFieldSignature(fields);

	const cacheKey = [
		"stage1",
		direct ? "direct" : "full",
		hashStringSet(contextIds),
		hashStringSet(actionNames),
		fieldSignature,
	].join("#");
	const cached = stage1Cache.get(cacheKey);
	if (cached) return cached;

	const spans: ResponseSkeletonSpan[] = [];
	const builder = new GbnfBuilder();
	const rootParts: string[] = [];

	if (fields.length > 0) {
		const firstField = fields[0];
		const open = `{"${firstField.name}":`;
		spans.push({ kind: "literal", value: open });
		rootParts.push(gbnfLiteral(open));

		for (let i = 0; i < fields.length; i += 1) {
			const field = fields[i];
			if (i > 0) {
				const glue = `,"${field.name}":`;
				spans.push({ kind: "literal", value: glue });
				rootParts.push(gbnfLiteral(glue));
			}
			if (field.name === "contexts") {
				spans.push({
					kind: "free-json",
					key: "contexts",
					rule: "contextsarray",
				});
				if (contextIds.length === 0) {
					builder.useShared("jsonstringarray");
					rootParts.push("jsonstringarray");
				} else {
					const enumRule = "contextid";
					builder.rule(
						enumRule,
						contextIds.map((id) => gbnfJsonStringLiteral(id)).join(" | "),
					);
					builder.useShared("ws");
					builder.rule(
						"contextsarray",
						`"[" ws ( ${enumRule} ( ws "," ws ${enumRule} )* )? ws "]"`,
					);
					rootParts.push("contextsarray");
				}
				continue;
			}
			const kind = spanKindForFieldSchema(field.schema);
			if (kind === "literal") {
				const enumValues = (field.schema as { enum?: unknown[] }).enum ?? [];
				const value = JSON.stringify(String(enumValues[0] ?? ""));
				spans.push({ kind: "literal", key: field.name, value });
				rootParts.push(gbnfLiteral(value));
			} else if (kind === "enum") {
				spans.push({
					kind,
					key: field.name,
					enumValues: stringEnumValuesForFieldSchema(field.schema),
				});
				rootParts.push(gbnfRefForFieldSchema(builder, field.schema));
			} else {
				spans.push({ kind, key: field.name });
				rootParts.push(gbnfRefForFieldSchema(builder, field.schema));
			}
		}
		spans.push({ kind: "literal", value: "}" });
		rootParts.push(gbnfLiteral("}"));
		builder.root(rootParts);
		const grammar = builder.build();
		const skeleton: ResponseSkeleton = { spans, id: cacheKey };
		const result: ResponseGrammarResult = {
			responseSkeleton: skeleton,
			grammar,
		};
		stage1Cache.set(cacheKey, result);
		return result;
	}

	// Opening brace + first key glue. The first literal is the "trigger" the
	// engine uses to start a lazy grammar; we make it the JSON open + the first
	// key so generation only constrains the envelope, not any prose preceding
	// it (irrelevant for tool-call args, where the whole turn is JSON, but it
	// keeps the compiled-skeleton path lazy-friendly).
	const firstKey = direct ? "thought" : "shouldRespond";
	const open = `{"${firstKey}":`;
	spans.push({ kind: "literal", value: open });
	rootParts.push(gbnfLiteral(open));

	if (!direct) {
		// shouldRespond enum span.
		spans.push({
			kind: "enum",
			key: "shouldRespond",
			enumValues: [...SHOULD_RESPOND_VALUES],
		});
		const ruleName = "shouldrespond";
		builder.rule(
			ruleName,
			SHOULD_RESPOND_VALUES.map((v) => gbnfJsonStringLiteral(v)).join(" | "),
		);
		rootParts.push(ruleName);
		// Glue to `thought`.
		spans.push({ kind: "literal", value: ',"thought":' });
		rootParts.push(gbnfLiteral(',"thought":'));
	}

	// Walk the fixed envelope keys. The first one (`thought`) already had its
	// key glue emitted (either as the trailing part of `open` on the direct
	// path, or right after the shouldRespond enum on the non-direct path).
	for (let i = 0; i < STAGE1_ENVELOPE_KEYS.length; i += 1) {
		const key = STAGE1_ENVELOPE_KEYS[i];
		if (i > 0) {
			const glue = `,"${key}":`;
			spans.push({ kind: "literal", value: glue });
			rootParts.push(gbnfLiteral(glue));
		}
		if (key === "contexts") {
			// Skeleton: free-json (an array). Grammar: array of context-id enum.
			spans.push({ kind: "free-json", key: "contexts", rule: "contextsarray" });
			if (contextIds.length === 0) {
				builder.useShared("jsonstringarray");
				rootParts.push("jsonstringarray");
			} else {
				const enumRule = "contextid";
				builder.rule(
					enumRule,
					contextIds.map((id) => gbnfJsonStringLiteral(id)).join(" | "),
				);
				builder.useShared("ws");
				builder.rule(
					"contextsarray",
					`"[" ws ( ${enumRule} ( ws "," ws ${enumRule} )* )? ws "]"`,
				);
				rootParts.push("contextsarray");
			}
			continue;
		}
		spans.push({ kind: spanKindForKey(key), key });
		rootParts.push(gbnfRefForKey(builder, key));
	}

	// Registered field evaluators, priority-ordered, appended after `extract`.
	for (const field of fields) {
		const glue = `,"${field.name}":`;
		spans.push({ kind: "literal", value: glue });
		rootParts.push(gbnfLiteral(glue));
		const kind = spanKindForFieldSchema(field.schema);
		if (kind === "literal") {
			// Single-value string enum → its JSON-quoted form, no tokens.
			const enumValues = (field.schema as { enum?: unknown[] }).enum ?? [];
			const value = JSON.stringify(String(enumValues[0] ?? ""));
			spans.push({ kind: "literal", key: field.name, value });
			rootParts.push(gbnfLiteral(value));
		} else if (kind === "enum") {
			spans.push({
				kind,
				key: field.name,
				enumValues: stringEnumValuesForFieldSchema(field.schema),
			});
			rootParts.push(gbnfRefForFieldSchema(builder, field.schema));
		} else {
			spans.push({ kind, key: field.name });
			rootParts.push(gbnfRefForFieldSchema(builder, field.schema));
		}
	}

	// Closing brace.
	spans.push({ kind: "literal", value: "}" });
	rootParts.push(gbnfLiteral("}"));

	builder.root(rootParts);
	const grammar = builder.build();
	const skeleton: ResponseSkeleton = { spans, id: cacheKey };
	const result: ResponseGrammarResult = { responseSkeleton: skeleton, grammar };
	stage1Cache.set(cacheKey, result);
	return result;
}

/** Clear the process-wide Stage-1 grammar cache (test hook). */
export function clearResponseGrammarCache(): void {
	stage1Cache.clear();
	plannerCache.clear();
}

/**
 * True unless the operator has explicitly opted *out* of guided structured
 * decode for the local llama-server engine. Guided decode (the
 * deterministic-token prefill-plan fast-forward layered on top of the GBNF
 * constrained decode) is **on by default** for the Stage-1 response handler and
 * the Stage-2 planner — those are the calls that always carry a forced skeleton.
 * Set `MILADY_LOCAL_GUIDED_DECODE=0` (or `ELIZA_LOCAL_GUIDED_DECODE=0` /
 * `false` / `off` / `no`) to disable. Cloud adapters ignore
 * `providerOptions.eliza.guidedDecode` entirely, so this is a no-op for them.
 */
function guidedDecodeEnabledByDefault(): boolean {
	const raw = (
		process.env.MILADY_LOCAL_GUIDED_DECODE ??
		process.env.ELIZA_LOCAL_GUIDED_DECODE ??
		""
	)
		.trim()
		.toLowerCase();
	return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Merge `eliza.guidedDecode = true` into a provider-options bag so the local
 * llama-server engine builds the {@link ResponseSkeleton}'s deterministic-token
 * prefill plan (`eliza_prefill_plan`) and fast-forwards the forced scaffold
 * spans — turning the ≈28% of envelope tokens the GBNF already pins into ≈28%
 * fewer `decode()` calls (the fork-side fast-forward consumes the plan; without
 * it the runtime degrades to grammar-only / byte-identical output). Idempotent;
 * returns the same object reference with `eliza.guidedDecode` set. When the
 * operator opted out via `MILADY_LOCAL_GUIDED_DECODE=0` this is a no-op so an
 * existing `providerOptions.eliza.guidedDecode` (likely absent) is left alone.
 */
export function withGuidedDecodeProviderOptions<
	T extends Record<string, unknown>,
>(providerOptions: T): T {
	if (!guidedDecodeEnabledByDefault()) return providerOptions;
	const existingEliza =
		(providerOptions as { eliza?: Record<string, unknown> }).eliza ?? {};
	(providerOptions as { eliza?: Record<string, unknown> }).eliza = {
		...existingEliza,
		guidedDecode: true,
	};
	return providerOptions;
}

// ---------------------------------------------------------------------------
// Stage-2: planner action grammar
// ---------------------------------------------------------------------------

/**
 * A minimal description of an action available to the planner this turn: the
 * tool name plus the normalized JSON schema for its `parameters` object. The
 * planner renders these into the conversation's `available_actions` block; this
 * module turns the *name set* into an enum constraint and exposes the per-action
 * schemas so the engine can do the second pass (constrain `parameters` once the
 * `action` value is known).
 */
export interface PlannerActionDescriptor {
	name: string;
	parametersSchema: JSONSchema;
	/** True when the action's parameters schema allows undeclared properties. */
	allowAdditionalParameters: boolean;
}

export interface PlannerActionGrammarResult {
	/**
	 * Skeleton for the PLAN_ACTIONS tool-call arguments
	 * `{ "action": <enum>, "parameters": <free-json>, "thought": <free-string> }`.
	 * `parameters` is a `free-json` span — the per-action constraint can't be
	 * expressed in a single skeleton (it is conditional on the sampled `action`
	 * value), so the engine does a second pass against
	 * {@link PlannerActionGrammarResult.actionSchemas}.
	 */
	responseSkeleton: ResponseSkeleton;
	/**
	 * Precise GBNF for the PLAN_ACTIONS args with `action` pinned to the enum of
	 * available action names. `parameters` is left as a free JSON object.
	 */
	grammar: string;
	/**
	 * Map of action name → normalized JSON schema for that action's `parameters`
	 * object. The engine uses this for the second constrained pass; cloud
	 * adapters ignore it. Carried alongside the grammar/skeleton on
	 * `providerOptions.eliza.plannerActionSchemas`.
	 */
	actionSchemas: Record<string, JSONSchema>;
}

const plannerCache = new Map<string, PlannerActionGrammarResult>();

/**
 * Build a {@link PlannerActionDescriptor} from a registered action.
 */
export function actionToPlannerDescriptor(
	action: Pick<Action, "name" | "parameters" | "allowAdditionalParameters">,
): PlannerActionDescriptor {
	return {
		name: action.name,
		parametersSchema: normalizeActionJsonSchema(action),
		allowAdditionalParameters: action.allowAdditionalParameters === true,
	};
}

/**
 * Build the per-turn grammar for the Stage-2 planner's `PLAN_ACTIONS` call from
 * the set of actions exposed this turn. Constrains the `action` field to the
 * exact enum of available action names and exposes each action's normalized
 * parameter schema for the engine's second pass.
 *
 * Returns `null` when there are no actions to expose (the planner falls back to
 * its unconstrained behavior).
 */
export function buildPlannerActionGrammar(
	actions: ReadonlyArray<
		Pick<Action, "name" | "parameters" | "allowAdditionalParameters">
	>,
): PlannerActionGrammarResult | null {
	const descriptors = actions
		.map(actionToPlannerDescriptor)
		.filter((d) => d.name.length > 0);
	if (descriptors.length === 0) return null;
	const names = Array.from(new Set(descriptors.map((d) => d.name))).sort();

	const cacheKey = `planner#${hashStringSet(names)}#${JSON.stringify(
		descriptors
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((d) => [d.name, d.parametersSchema]),
	)}`;
	const cached = plannerCache.get(cacheKey);
	if (cached) return cached;

	const actionSchemas: Record<string, JSONSchema> = {};
	for (const d of descriptors) actionSchemas[d.name] = d.parametersSchema;

	// Skeleton: { "action": <enum>, "parameters": <free-json>, "thought": <free-string> }
	// Legacy PLAN_ACTIONS-style envelope kept here as the local engine's
	// guided-decode contract: the model's first sampled field pins the action
	// name, the second the action's parameters, the third a short thought.
	// Property order is action, parameters, thought.
	const spans: ResponseSkeletonSpan[] = [];
	const builder = new GbnfBuilder();
	const rootParts: string[] = [];

	const open = '{"action":';
	spans.push({ kind: "literal", value: open });
	rootParts.push(gbnfLiteral(open));

	if (names.length === 1) {
		const value = JSON.stringify(names[0]);
		spans.push({ kind: "literal", key: "action", value });
		rootParts.push(gbnfLiteral(value));
	} else {
		spans.push({ kind: "enum", key: "action", enumValues: names });
		builder.rule(
			"actionname",
			names.map((n) => gbnfJsonStringLiteral(n)).join(" | "),
		);
		rootParts.push("actionname");
	}

	const paramsGlue = ',"parameters":';
	spans.push({ kind: "literal", value: paramsGlue });
	rootParts.push(gbnfLiteral(paramsGlue));
	spans.push({ kind: "free-json", key: "parameters", rule: "actionparams" });
	builder.useShared("jsonobject");
	builder.rule("actionparams", "jsonobject");
	rootParts.push("actionparams");

	const thoughtGlue = ',"thought":';
	spans.push({ kind: "literal", value: thoughtGlue });
	rootParts.push(gbnfLiteral(thoughtGlue));
	spans.push({ kind: "free-string", key: "thought" });
	builder.useShared("jsonstring");
	rootParts.push("jsonstring");

	spans.push({ kind: "literal", value: "}" });
	rootParts.push(gbnfLiteral("}"));

	builder.root(rootParts);
	const result: PlannerActionGrammarResult = {
		responseSkeleton: { spans, id: cacheKey },
		grammar: builder.build(),
		actionSchemas,
	};
	plannerCache.set(cacheKey, result);
	return result;
}

/**
 * Single-call counterpart to `buildPlannerActionGrammar`: instead of pinning
 * only the `action` field and leaving `parameters` as free-JSON, the strict
 * variant produces a per-action *union* grammar where each branch encodes
 * `{"action":"<NAME>","parameters":<params_NAME>,"thought":<thought>}` with a
 * GBNF rule for `params_NAME` that constrains every property of that action's
 * normalized schema. Branches are root-level alternatives, so the chosen
 * action name and the parameter shape are co-determined by construction —
 * something a single-pass loose grammar cannot guarantee.
 *
 * Tradeoff vs. the loose `buildPlannerActionGrammar`: grammar size grows with
 * `actions × properties_per_action`, but the model only needs ONE call to
 * produce a validated structure (no engine-level second pass, no
 * coercion/reroll round in `validate-tool-args.ts`). Matches the intent of
 * P2-4 in `packages/training/benchmarks/INFERENCE_OPTIMIZATION_PLAN.md`.
 *
 * The returned `responseSkeleton` is intentionally minimal — the grammar
 * carries the entire structural contract, so the engine's prefill plan has
 * nothing useful to inject statically. Cloud adapters still ignore the
 * skeleton + grammar per the W3 contract; `tools` carries the equivalent
 * unforced contract for them.
 *
 * Returns `null` when no actions are exposed.
 */
/**
 * Group action names by longest common prefix (≥3 chars, ≥2 names sharing it).
 * Returns a map of prefix → suffixes, plus a list of ungrouped names.
 */
function groupActionNamesByPrefix(names: string[]): {
	groups: Map<string, string[]>;
	ungrouped: string[];
} {
	const groups = new Map<string, string[]>();
	const used = new Set<string>();

	// Find prefixes ending with "_" first (natural word boundaries in SNAKE_CASE).
	const candidates = new Set<string>();
	for (const name of names) {
		// Extract potential prefixes ending with "_"
		let idx = 0;
		while ((idx = name.indexOf("_", idx)) !== -1) {
			const prefix = name.substring(0, idx + 1); // Include the "_"
			if (prefix.length >= 3) candidates.add(prefix);
			idx++;
		}
	}

	// If no candidates with "_", fall back to all 3+ char prefixes.
	if (candidates.size === 0) {
		for (const name of names) {
			for (let len = 3; len < name.length; len++) {
				candidates.add(name.substring(0, len));
			}
		}
	}

	// Sort by length (longest first) to prefer longer prefixes.
	const candidateList = Array.from(candidates).sort((a, b) => b.length - a.length);
	for (const prefix of candidateList) {
		const matching = names.filter((n) => n.startsWith(prefix) && !used.has(n));
		if (matching.length >= 2) {
			const suffixes = matching.map((n) => n.substring(prefix.length));
			groups.set(prefix, suffixes);
			matching.forEach((n) => used.add(n));
		}
	}

	const ungrouped = names.filter((n) => !used.has(n));
	return { groups, ungrouped };
}

export function buildPlannerActionGrammarStrict(
	actions: ReadonlyArray<
		Pick<Action, "name" | "parameters" | "allowAdditionalParameters">
	>,
): PlannerActionGrammarResult | null {
	const descriptors = actions
		.map(actionToPlannerDescriptor)
		.filter((d) => d.name.length > 0);
	if (descriptors.length === 0) return null;
	const names = Array.from(new Set(descriptors.map((d) => d.name))).sort();

	const cacheKey = `planner-strict#${hashStringSet(names)}#${JSON.stringify(
		descriptors
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((d) => [d.name, d.parametersSchema]),
	)}`;
	const cached = plannerStrictCache.get(cacheKey);
	if (cached) return cached;

	const actionSchemas: Record<string, JSONSchema> = {};
	for (const d of descriptors) actionSchemas[d.name] = d.parametersSchema;

	const builder = new GbnfBuilder();
	builder.useShared("jsonstring");

	const branchRuleNames: string[] = [];
	const sortedDescriptors = descriptors
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));
	// Group action names by common prefix for factoring.
	const { groups, ungrouped } = groupActionNamesByPrefix(
		sortedDescriptors.map((d) => d.name)
	);

	// Emit grouped actions with shared prefix literals.
	for (const [prefix, suffixes] of groups) {
		const prefixSanitized = sanitizeGbnfRuleName(prefix);
		const suffixRuleName = `suffix_${prefixSanitized}`;

		// Emit a rule for the suffix alternation.
		const suffixAlts = suffixes
			.map((suffix) => gbnfJsonStringLiteral(suffix))
			.join(" | ");
		builder.rule(suffixRuleName, suffixAlts);

		// For each action in the group, emit a branch that factors the prefix.
		for (const fullName of sortedDescriptors
			.filter((d) => d.name.startsWith(prefix))
			.map((d) => d.name)) {
			const sanitized = sanitizeGbnfRuleName(fullName);
			const paramsRuleName = `paramsofaction_${sanitized}`;
			const descriptor = sortedDescriptors.find((d) => d.name === fullName)!;
			emitActionParamsRule(builder, paramsRuleName, descriptor.parametersSchema);
			const branchRuleName = `callofaction_${sanitized}`;
			const suffix = fullName.substring(prefix.length);
			const branchBody = [
				gbnfLiteral(`{"action":"${prefix}`),
				suffixRuleName,
				gbnfLiteral('","parameters":'),
				paramsRuleName,
				gbnfLiteral(',"thought":'),
				"jsonstring",
				gbnfLiteral("}"),
			].join(" ");
			builder.rule(branchRuleName, branchBody);
			branchRuleNames.push(branchRuleName);
		}
	}

	// Emit ungrouped actions (no shared prefix).
	for (const fullName of ungrouped) {
		const descriptor = sortedDescriptors.find((d) => d.name === fullName)!;
		const sanitized = sanitizeGbnfRuleName(fullName);
		const paramsRuleName = `paramsofaction_${sanitized}`;
		emitActionParamsRule(builder, paramsRuleName, descriptor.parametersSchema);
		const branchRuleName = `callofaction_${sanitized}`;
		const branchBody = [
			gbnfLiteral(`{"action":${JSON.stringify(fullName)}`),
			gbnfLiteral(',"parameters":'),
			paramsRuleName,
			gbnfLiteral(',"thought":'),
			"jsonstring",
			gbnfLiteral("}"),
		].join(" ");
		builder.rule(branchRuleName, branchBody);
		branchRuleNames.push(branchRuleName);
	}

	builder.root([branchRuleNames.join(" | ")]);

	// Minimal skeleton — the grammar carries the entire structural contract.
	// The engine's prefill plan has nothing useful to inject statically because
	// every branch starts with the same literal `{"action":"` but diverges on
	// the first character of the chosen action name.
	const responseSkeleton: ResponseSkeleton = {
		spans: [{ kind: "free-json", key: "envelope" }],
		id: cacheKey,
	};

	const result: PlannerActionGrammarResult = {
		responseSkeleton,
		grammar: builder.build(),
		actionSchemas,
	};
	plannerStrictCache.set(cacheKey, result);
	return result;
}

const plannerStrictCache = new Map<string, PlannerActionGrammarResult>();

/**
 * GBNF rule names must match `[a-zA-Z_][a-zA-Z0-9_-]*`. Action names in the
 * registry are typically `UPPER_SNAKE_CASE` already, but sanitize defensively
 * for plugin-supplied action names that might carry `:` / `.` / spaces.
 */
function sanitizeGbnfRuleName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
	return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Cap on object-recursion depth in the strict grammar — protects against
 * accidental schema cycles and keeps the generated GBNF bounded.
 */
const MAX_NESTED_OBJECT_DEPTH = 4;

/**
 * Emit a per-action parameters GBNF rule. Thin wrapper that pins the
 * top-level depth at 0; `emitObjectRule` does the recursive heavy lifting.
 */
function emitActionParamsRule(
	builder: GbnfBuilder,
	ruleName: string,
	schema: JSONSchema,
): void {
	emitObjectRule(builder, ruleName, schema, 0);
}

/**
 * Emit a GBNF rule for an object schema. Walks `properties`, translates each
 * value into a constrained GBNF expression, and assembles a body that
 * sequences required keys in declaration order then permits each optional
 * key zero-or-more times. (GBNF can't express true unordered sets without
 * combinatorial blowup; the single-occurrence invariant of optionals is
 * enforced by the downstream JSON parser rejecting duplicate keys.)
 *
 * Recursion: object-typed properties whose schema declares its own
 * `properties` emit a nested rule via this function, capped at
 * `MAX_NESTED_OBJECT_DEPTH` so accidental schema cycles can't blow up the
 * generated grammar.
 */
function emitObjectRule(
	builder: GbnfBuilder,
	ruleName: string,
	schema: JSONSchema,
	depth: number,
): void {
	const properties =
		(schema as { properties?: Record<string, JSONSchema> }).properties ?? {};
	const requiredList =
		((schema as { required?: unknown }).required as string[] | undefined) ?? [];
	const required = new Set(requiredList);
	const propertyNames = Object.keys(properties);
	if (propertyNames.length === 0) {
		builder.rule(ruleName, gbnfLiteral("{}"));
		return;
	}

	const requiredKeys = propertyNames.filter((k) => required.has(k));
	const optionalKeys = propertyNames.filter((k) => !required.has(k));

	const propertyTokens: Record<string, string> = {};
	for (const key of propertyNames) {
		const sanitizedKey = sanitizeGbnfRuleName(key);
		const propertyRuleName = `${ruleName}_p_${sanitizedKey}`;
		const contextRuleName = `${ruleName}_${sanitizedKey}`;
		const valueExpr = propertyValueGbnf(
			builder,
			properties[key],
			contextRuleName,
			depth,
		);
		builder.rule(
			propertyRuleName,
			[gbnfLiteral(`"${escapeJsonKey(key)}":`), valueExpr].join(" "),
		);
		propertyTokens[key] = propertyRuleName;
	}

	const parts: string[] = [gbnfLiteral("{")];
	if (requiredKeys.length > 0) {
		parts.push(propertyTokens[requiredKeys[0]]);
		for (let i = 1; i < requiredKeys.length; i++) {
			parts.push(gbnfLiteral(","));
			parts.push(propertyTokens[requiredKeys[i]]);
		}
	}
	if (optionalKeys.length > 0) {
		const optionalAlt = optionalKeys.map((k) => propertyTokens[k]).join(" | ");
		const leadingComma = requiredKeys.length > 0;
		const optionalGroup = leadingComma
			? `( ${gbnfLiteral(",")} ( ${optionalAlt} ) )*`
			: `( ( ${optionalAlt} ) ( ${gbnfLiteral(",")} ( ${optionalAlt} ) )* )?`;
		parts.push(optionalGroup);
	}
	parts.push(gbnfLiteral("}"));
	builder.rule(ruleName, parts.join(" "));
}

/**
 * Map a single property schema to a GBNF expression. Pulls in the matching
 * shared JSON rules and (for objects / arrays-of-objects) emits nested rules
 * as a side effect on `builder`.
 *
 * `contextRuleName` is the parent-scoped namespace prefix used to mint stable
 * unique rule names for nested constructs (e.g. `..._obj`, `..._item`).
 */
/**
 * Build a GBNF rule that matches only numbers within a [min, max] range.
 * For integers: emits a union of literal ranges and digit-length cases.
 * For numbers: allows integer part + optional fractional digits, bounded by min/max.
 * Returns a rule name to reference in the GBNF.
 */
function buildBoundedNumberRule(
	builder: GbnfBuilder,
	ruleName: string,
	schema: JSONSchema,
): string {
	const type = (schema as { type?: unknown }).type;
	const minimum = (schema as { minimum?: number }).minimum;
	const maximum = (schema as { maximum?: number }).maximum;

	// No bounds specified: use the shared unbounded rule.
	if (
		typeof minimum !== "number" &&
		typeof maximum !== "number"
	) {
		builder.useShared("jsonnumber");
		return "jsonnumber";
	}

	// For integers, emit a rule that matches only in-range values.
	if (type === "integer") {
		const min = typeof minimum === "number" ? Math.ceil(minimum) : Number.NEGATIVE_INFINITY;
		const max = typeof maximum === "number" ? Math.floor(maximum) : Number.POSITIVE_INFINITY;

		// Handle edge cases: if bounds are missing, fall back to unbounded.
		if (!Number.isFinite(min) && !Number.isFinite(max)) {
			builder.useShared("jsonnumber");
			return "jsonnumber";
		}

		// For manageable integer ranges, enumerate directly.
		// This is pragmatic for small ranges like [0, 100].
		if (Number.isFinite(min) && Number.isFinite(max) && max - min <= 200) {
			const literals: string[] = [];
			for (let i = min; i <= max; i++) {
				literals.push(gbnfJsonStringLiteral(String(i)));
			}
			builder.rule(ruleName, literals.join(" | "));
			return ruleName;
		}

		// For larger ranges, fall back to unbounded (the grammar won't tightly constrain).
		builder.useShared("jsonnumber");
		return "jsonnumber";
	}

	// For floats, emit a pattern: optional minus, digits, optional fractional part.
	// Validation of bounds happens server-side (we can't easily express arbitrary float ranges in GBNF).
	if (type === "number") {
		// Pragmatic: emit a rule that allows signed integers and decimals.
		// The server-side validation will reject out-of-range values.
		builder.useShared("jsonnumber");
		return "jsonnumber";
	}

	// Unknown type: use unbounded.
	builder.useShared("jsonnumber");
	return "jsonnumber";
}

function propertyValueGbnf(
	builder: GbnfBuilder,
	propSchema: JSONSchema,
	contextRuleName: string,
	depth: number,
): string {
	const type = (propSchema as { type?: unknown }).type;
	if (type === "string") {
		const enumValues = readStringEnumForGrammar(propSchema);
		if (enumValues !== null) {
			if (enumValues.length === 1) {
				return gbnfJsonStringLiteral(enumValues[0]);
			}
			return `( ${enumValues
				.map((v) => gbnfJsonStringLiteral(v))
				.join(" | ")} )`;
		}
		builder.useShared("jsonstring");
		return "jsonstring";
	}
	if (type === "number" || type === "integer") {
		const minimum = (propSchema as { minimum?: number }).minimum;
		const maximum = (propSchema as { maximum?: number }).maximum;
		// If bounds are specified, emit a bounded rule; otherwise use the shared rule.
		if (typeof minimum === "number" || typeof maximum === "number") {
			const boundedRuleName = `${contextRuleName}_bounded`;
			return buildBoundedNumberRule(builder, boundedRuleName, propSchema);
		}
		builder.useShared("jsonnumber");
		return "jsonnumber";
	}
	if (type === "boolean") {
		builder.useShared("jsonbool");
		return "jsonbool";
	}
	if (type === "array") {
		const items = (propSchema as { items?: JSONSchema }).items;
		const itemsType = items && (items as { type?: unknown }).type;
		if (itemsType === "string") {
			const enumValues = readStringEnumForGrammar(items as JSONSchema);
			if (enumValues !== null && enumValues.length > 0) {
				builder.useShared("ws");
				const elem = `( ${enumValues
					.map((v) => gbnfJsonStringLiteral(v))
					.join(" | ")} )`;
				return `"[" ws ( ${elem} ( ws "," ws ${elem} )* )? ws "]"`;
			}
		}
		if (
			itemsType === "object" &&
			depth < MAX_NESTED_OBJECT_DEPTH &&
			schemaHasDeclaredProperties(items as JSONSchema)
		) {
			const itemRuleName = `${contextRuleName}_item`;
			emitObjectRule(builder, itemRuleName, items as JSONSchema, depth + 1);
			builder.useShared("ws");
			return `"[" ws ( ${itemRuleName} ( ws "," ws ${itemRuleName} )* )? ws "]"`;
		}
		builder.useShared("jsonarray");
		return "jsonarray";
	}
	if (
		type === "object" &&
		depth < MAX_NESTED_OBJECT_DEPTH &&
		schemaHasDeclaredProperties(propSchema)
	) {
		const objRuleName = `${contextRuleName}_obj`;
		emitObjectRule(builder, objRuleName, propSchema, depth + 1);
		return objRuleName;
	}
	// object without declared properties, null, or unspecified → permit any JSON.
	builder.useShared("jsonvalue");
	return "jsonvalue";
}

function schemaHasDeclaredProperties(schema: JSONSchema): boolean {
	const properties = (schema as { properties?: Record<string, unknown> })
		.properties;
	return (
		typeof properties === "object" &&
		properties !== null &&
		Object.keys(properties).length > 0
	);
}

/** Reuse the conservative string-enum reader from buildPlannerParamsSkeleton. */
function readStringEnumForGrammar(propSchema: JSONSchema): string[] | null {
	const raw = (propSchema as { enum?: unknown }).enum;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const normalized: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string") return null;
		normalized.push(v);
	}
	return normalized;
}

function escapeJsonKey(key: string): string {
	return key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a {@link ResponseSkeleton} for the *second* planner pass: the
 * `parameters` object of a specific chosen action. The engine uses this once it
 * has sampled the `action` value. `properties` whose value is a single-element
 * string enum collapse to literal spans; everything else is `free-json` /
 * `free-string`.
 *
 * Exposed for completeness — the engine may instead just hand the JSON schema
 * to its own grammar compiler. We keep it here so the contract is in one place.
 */
export function buildPlannerParamsSkeleton(
	action: Pick<Action, "name" | "parameters" | "allowAdditionalParameters">,
): ResponseSkeleton {
	const schema = normalizeActionJsonSchema(action);
	const properties = (schema.properties ?? {}) as Record<string, JSONSchema>;
	const keys = Object.keys(properties);
	const spans: ResponseSkeletonSpan[] = [];
	if (keys.length === 0) {
		spans.push({ kind: "literal", value: "{}" });
		return { spans, id: `params#${action.name}` };
	}
	const enumDigest: string[] = [];
	keys.forEach((key, index) => {
		const glue = index === 0 ? `{"${key}":` : `,"${key}":`;
		spans.push({ kind: "literal", value: glue });
		const propSchema = properties[key];
		const type = (propSchema as { type?: unknown }).type;
		if (type === "string") {
			const enumValues = readStringEnum(propSchema);
			if (enumValues !== null && enumValues.length === 1) {
				spans.push({
					kind: "literal",
					key,
					value: JSON.stringify(enumValues[0]),
				});
				enumDigest.push(`${key}=${enumValues[0]}`);
			} else if (enumValues !== null && enumValues.length > 1) {
				spans.push({ kind: "enum", key, enumValues });
				enumDigest.push(`${key}∈[${enumValues.join("|")}]`);
			} else {
				spans.push({ kind: "free-string", key });
			}
		} else {
			spans.push({ kind: "free-json", key });
		}
	});
	spans.push({ kind: "literal", value: "}" });
	const idSuffix = enumDigest.length > 0 ? `#${enumDigest.join(",")}` : "";
	return { spans, id: `params#${action.name}#${keys.join(",")}${idSuffix}` };
}

/**
 * Read a string-property's `enum` array, normalising to `string[]` and
 * returning `null` when none is declared or values are non-string.
 *
 * Multi-value string enums are pinnable by the GBNF skeleton compiler as an
 * `enum` span — that's what makes the 2nd-pass per-action parameters grammar
 * actually constrain the model instead of falling through to `free-string`.
 */
function readStringEnum(propSchema: JSONSchema): string[] | null {
	const raw = (propSchema as { enum?: unknown }).enum;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const normalized: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string") return null;
		normalized.push(v);
	}
	return normalized;
}

// Re-export the local JsonSchema type for convenience.
export type { JsonSchema };
// Re-export the schema normalizer so callers that already import this module
// don't need a second import path.
export { normalizeActionJsonSchema };
