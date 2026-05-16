/**
 * Structured-output / forced-span / prefill plumbing for the local-inference
 * engine path.
 *
 * The canonical contract lives in `@elizaos/core` `GenerateTextParams`
 * (`prefill`, `responseSkeleton`, `grammar`, `streamStructured`) and is
 * threaded through `useModel` → router. This module is the
 * local-inference-layer mirror of the relevant subset plus the GBNF
 * compilation that turns a `ResponseSkeleton` into a *lazy* grammar so the
 * model only ever samples the free positions of the response envelope
 * (single-value enums collapse to literals — no tokens spent on the scaffold).
 *
 * Nothing here is local-model-specific in shape; cloud adapters never read
 * these fields. There is no fallback path — adapters that can't honour
 * `grammar` / `prefill` / `responseSkeleton` ignore them, full stop.
 */
export {
	repairStructuredOutput,
	StructuredOutputRepairStream,
} from "./structured-output/deterministic-repair";

/** True when `kind` is a span the model actually samples. */
function isFreeSpan(span) {
	return (
		span.kind === "free-string" ||
		span.kind === "free-json" ||
		span.kind === "number" ||
		span.kind === "boolean" ||
		(span.kind === "enum" &&
			Array.isArray(span.enumValues) &&
			span.enumValues.length > 1)
	);
}
/**
 * Escape a string for use inside a GBNF double-quoted literal (C-style escapes).
 */
function gbnfEscapeLiteral(text) {
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
/**
 * Collapse a skeleton: `enum` spans with exactly one value (or zero values)
 * become `literal` spans (C4). Adjacent literals stay separate spans — the
 * compiler merges them in the root rule.
 */
export function collapseSkeleton(skeleton) {
	const out = [];
	for (const span of skeleton.spans) {
		if (
			span.kind === "enum" &&
			Array.isArray(span.enumValues) &&
			span.enumValues.length <= 1
		) {
			const value = span.enumValues[0] ?? span.value ?? "";
			out.push({ kind: "literal", key: span.key, value });
			continue;
		}
		out.push(span);
	}
	return { spans: out, id: skeleton.id };
}
/**
 * GBNF rule body for a quoted JSON string value.
 */
const GBNF_JSON_STRING = '"\\"" ( [^"\\\\] | "\\\\" . )* "\\""';
/**
 * GBNF rule body for a JSON value (object/array/string/number/bool/null) —
 * the canonical recursive `json-value` grammar, inlined so a `free-json` span
 * is self-contained without a shared `json` import.
 */
const GBNF_JSON_VALUE = [
	'jsonvalue ::= jsonobject | jsonarray | jsonstring | jsonnumber | "true" | "false" | "null"',
	'jsonobject ::= "{" ws ( jsonstring ws ":" ws jsonvalue ( ws "," ws jsonstring ws ":" ws jsonvalue )* )? ws "}"',
	'jsonarray ::= "[" ws ( jsonvalue ( ws "," ws jsonvalue )* )? ws "]"',
	`jsonstring ::= ${GBNF_JSON_STRING}`,
	'jsonnumber ::= "-"? ( [0-9] | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?',
	"ws ::= [ \\t\\n\\r]*",
].join("\n");
/**
 * Compile a `ResponseSkeleton` to a *lazy* GBNF grammar. The grammar's `root`
 * rule is the concatenation of every span:
 *   - `literal` spans → GBNF string literals (the JSON key/glue scaffold),
 *   - `enum` spans (≥2 values) → an alternation of quoted-string literals,
 *   - `free-string` spans → a quoted JSON string rule,
 *   - `free-json` spans → the recursive JSON-value rule.
 *
 * The grammar runs *lazily* when the skeleton opens with a literal (the
 * trigger word) — generation free-runs until that literal is seen, then the
 * grammar pins the rest of the envelope. That keeps the prose prefix
 * unconstrained while forcing the JSON scaffold.
 *
 * Returns `null` when the skeleton has no free spans (nothing for the model to
 * sample — the caller should just emit the literal text and skip generation).
 */
export function compileSkeletonToGbnf(skeletonInput) {
	const skeleton = collapseSkeleton(skeletonInput);
	if (!skeleton.spans.some(isFreeSpan)) return null;
	const rules = new Map();
	const rootParts = [];
	let freeIdx = 0;
	let needsJsonValue = false;
	let triggerWord = null;
	for (let i = 0; i < skeleton.spans.length; i += 1) {
		const span = skeleton.spans[i];
		if (span.kind === "literal") {
			const text = span.value ?? "";
			if (i === 0 && text.length > 0) triggerWord = text;
			rootParts.push(`"${gbnfEscapeLiteral(text)}"`);
			continue;
		}
		if (span.kind === "enum") {
			const values =
				Array.isArray(span.enumValues) && span.enumValues.length > 0
					? span.enumValues
					: [span.value ?? ""];
			if (values.length === 1) {
				// collapseSkeleton already lowered single-value enums; this is a
				// defensive fallback for a producer that didn't.
				rootParts.push(`"${gbnfEscapeLiteral(`"${values[0]}"`)}"`);
				continue;
			}
			const ruleName = span.rule ?? `enum${freeIdx++}`;
			const alts = values.map((v) => `"${gbnfEscapeLiteral(`"${v}"`)}"`);
			rules.set(ruleName, alts.join(" | "));
			rootParts.push(ruleName);
			continue;
		}
		if (span.kind === "free-string") {
			const ruleName = span.rule ?? `freestr${freeIdx++}`;
			if (!rules.has(ruleName)) rules.set(ruleName, GBNF_JSON_STRING);
			rootParts.push(ruleName);
			continue;
		}
		if (span.kind === "number") {
			// jsonnumber lives inside GBNF_JSON_VALUE; pulling that whole block
			// in is overkill for a leaf number span — emit a local rule.
			const ruleName = span.rule ?? `jsonnum${freeIdx++}`;
			if (!rules.has(ruleName)) {
				rules.set(
					ruleName,
					'"-"? ( [0-9] | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?',
				);
			}
			rootParts.push(ruleName);
			continue;
		}
		if (span.kind === "boolean") {
			const ruleName = span.rule ?? `jsonbool${freeIdx++}`;
			if (!rules.has(ruleName)) {
				rules.set(ruleName, '"true" | "false"');
			}
			rootParts.push(ruleName);
			continue;
		}
		// free-json
		const ruleName = span.rule ?? "jsonvalue";
		needsJsonValue = needsJsonValue || ruleName === "jsonvalue";
		if (ruleName !== "jsonvalue" && !rules.has(ruleName)) {
			// A producer-named rule with no inline body falls back to a JSON value.
			rules.set(ruleName, "jsonvalue");
			needsJsonValue = true;
		}
		rootParts.push(ruleName);
	}
	const lines = [`root ::= ${rootParts.join(" ")}`];
	for (const [name, body] of rules) lines.push(`${name} ::= ${body}`);
	if (needsJsonValue) lines.push(GBNF_JSON_VALUE);
	const source = lines.join("\n");
	if (triggerWord) return { source, lazy: true, triggers: [triggerWord] };
	return { source, lazy: false };
}
/**
 * Resolve the GBNF grammar to apply for a generation call. Precedence: an
 * explicit `grammar` string on the params, then a compiled `responseSkeleton`.
 * Returns null when neither is set.
 */
export function resolveGrammarForParams(params) {
	if (!params) return null;
	if (typeof params.grammar === "string" && params.grammar.trim().length > 0) {
		return { source: params.grammar, lazy: false };
	}
	if (params.responseSkeleton) {
		return compileSkeletonToGbnf(params.responseSkeleton);
	}
	return null;
}
function stripPrefilledPrefixFromGrammar(grammar, prefix) {
	if (!prefix) return grammar;
	const lines = grammar.source.split("\n");
	const root = lines[0] ?? "";
	const rootPrefix = "root ::= ";
	if (!root.startsWith(rootPrefix)) return null;
	const escapedPrefix = `"${gbnfEscapeLiteral(prefix)}"`;
	const body = root.slice(rootPrefix.length);
	if (body === escapedPrefix) {
		return { source: [rootPrefix + '""', ...lines.slice(1)].join("\n"), lazy: false };
	}
	if (!body.startsWith(`${escapedPrefix} `)) return null;
	return {
		source: [
			`${rootPrefix}${body.slice(escapedPrefix.length).trimStart()}`,
			...lines.slice(1),
		].join("\n"),
		lazy: false,
	};
}
/**
 * Build the OpenAI-/llama-server-compatible request-body fragment for a
 * grammar. Returns `grammar` + (when lazy) `grammar_lazy` / `grammar_triggers`.
 * Recent llama.cpp accepts these on both `/v1/chat/completions` and
 * `/completion`.
 */
export function grammarRequestFields(grammar) {
	const out = { grammar: grammar.source };
	if (grammar.lazy) {
		out.grammar_lazy = true;
		if (grammar.triggers && grammar.triggers.length > 0) {
			out.grammar_triggers = grammar.triggers.map((value) => ({
				type: "word",
				value,
			}));
		}
	}
	return out;
}
/**
 * Split a skeleton's leading literal run off as an assistant-turn prefill
 * candidate, returning that prefix plus the remaining spans. Used by the
 * multi-call infill fallback (emit prefix as a prefill, generate the first
 * free span, then loop).
 */
export function splitSkeletonAtFirstFree(skeleton) {
	let prefixLiteral = "";
	let idx = 0;
	while (
		idx < skeleton.spans.length &&
		skeleton.spans[idx].kind === "literal"
	) {
		prefixLiteral += skeleton.spans[idx].value ?? "";
		idx += 1;
	}
	return { prefixLiteral, rest: skeleton.spans.slice(idx) };
}
/**
 * Compute the {@link ElizaPrefillPlan} for a response skeleton: walk the spans,
 * accumulating consecutive `literal` spans (and single-value enums collapsed to
 * literals) into deterministic byte runs and counting the free spans. Adjacent
 * literals merge into one run. Returns `null` when the skeleton has no
 * deterministic runs at all (nothing to prefill).
 *
 * Invariant the consumer relies on: concatenating the runs interleaved with the
 * (eventually-sampled) free-span values, in order, reproduces a byte-identical
 * JSON document to what the lazy GBNF from {@link compileSkeletonToGbnf} would
 * have produced. The tests assert this.
 */
export function compilePrefillPlan(skeletonInput, tokenize) {
	const skeleton = collapseSkeleton(skeletonInput);
	const runs = [];
	let freeCount = 0;
	let pending = "";
	const flushPending = (afterFreeSpan) => {
		if (pending.length === 0) return;
		const run = { afterFreeSpan, text: pending };
		if (tokenize) {
			run.tokenIds = tokenize(pending);
		}
		runs.push(run);
		pending = "";
	};
	for (const span of skeleton.spans) {
		if (span.kind === "literal") {
			pending += span.value ?? "";
			continue;
		}
		if (
			span.kind === "enum" &&
			Array.isArray(span.enumValues) &&
			span.enumValues.length === 1
		) {
			// Defensive: a producer that didn't collapse a single-value enum.
			pending += JSON.stringify(String(span.enumValues[0]));
			continue;
		}
		// A free position (enum ≥2 values, free-string, free-json). The
		// deterministic run accumulated so far follows free span `freeCount - 1`
		// (or is the leading prefill run when `freeCount === 0`).
		flushPending(freeCount - 1);
		freeCount += 1;
	}
	// Tail scaffold after the last free span.
	flushPending(freeCount - 1);
	if (runs.length === 0) return null;
	const prefix = runs[0].afterFreeSpan === -1 ? runs[0].text : "";
	return { prefix, runs, freeCount, id: skeleton.id };
}
/**
 * Build the request-body fragment carrying the prefill plan. The server reads
 * `eliza_prefill_plan` (a tolerant extension — old binaries ignore it and the
 * grammar still forces the same bytes). Returns `{}` when there is no plan.
 */
export function prefillPlanRequestFields(plan) {
	if (!plan) return {};
	return {
		eliza_prefill_plan: {
			prefix: plan.prefix,
			runs: plan.runs.map((r) => {
				const run = {
					after_free_span: r.afterFreeSpan,
					text: r.text,
				};
				if (r.tokenIds !== undefined) {
					run.token_ids = r.tokenIds;
				}
				return run;
			}),
			free_count: plan.freeCount,
			id: plan.id,
		},
	};
}
/**
 * Build the request-body fragment carrying per-span sampler overrides. The
 * fork-side llama-server reads `eliza_span_samplers` (a tolerant extension —
 * old binaries ignore it; the grammar still constrains the same tokens, we
 * just lose the per-span argmax determinism guarantee on the legacy path).
 *
 * Wire schema (snake_case for OpenAI body conventions):
 *   {
 *     overrides: [
 *       { span_index: number, temperature: number, top_k?: number, top_p?: number }
 *     ],
 *     strict?: boolean
 *   }
 *
 * Returns `{}` when there is no plan or no overrides — keep the wire surface
 * narrow so a stock server never has to skip past empty fork extensions.
 */
export function spanSamplerPlanRequestFields(plan) {
	if (!plan || plan.overrides.length === 0) return {};
	const overrides = plan.overrides.map((o) => {
		const wire = {
			span_index: o.spanIndex,
			temperature: o.temperature,
		};
		if (typeof o.topK === "number") wire.top_k = o.topK;
		if (typeof o.topP === "number") wire.top_p = o.topP;
		return wire;
	});
	const body = { overrides };
	if (plan.strict === true) body.strict = true;
	return { eliza_span_samplers: body };
}
/**
 * Wrap a {@link ResponseSkeleton} (+ optional pre-built grammar + name map)
 * into an {@link ElizaHarnessSchema}, computing the prefill plan. This is the
 * single place the prefill plan is derived so producers don't each reimplement
 * it.
 */
export function elizaHarnessSchemaFromSkeleton(input) {
	return {
		skeleton: input.skeleton,
		grammar: input.grammar,
		prefillPlan: compilePrefillPlan(input.skeleton, input.tokenize),
		longNames: input.longNames ?? {},
		id: input.skeleton.id,
	};
}
/**
 * Expand a canonical short id decoded out of a constrained generation back to
 * its human-facing long name (display label), using the descriptor's
 * {@link ElizaHarnessSchema.longNames} map (sourced from the action catalog).
 * Identity when there is no mapping — the canonical action ids
 * (`normalizeActionName` results, e.g. `SEND_MESSAGE`) are already the on-wire
 * form, so this is only meaningful when a producer registered a separate
 * display label.
 */
export function expandShortName(schema, shortId) {
	if (!schema) return shortId;
	return schema.longNames[shortId] ?? shortId;
}
/**
 * Invert {@link expandShortName}: given a (possibly long) name the caller
 * supplied, return the canonical short id the wire form expects. Identity when
 * the name is already a known short id or no mapping matches.
 */
export function canonicalizeShortName(schema, name) {
	if (!schema) return name;
	if (Object.hasOwn(schema.longNames, name)) return name; // already a short id
	for (const [shortId, longName] of Object.entries(schema.longNames)) {
		if (longName === name) return shortId;
	}
	return name;
}
/**
 * Resolve the GBNF + prefill plan + assistant-turn prefill to apply for a
 * generation call given the structured params. Precedence for the grammar:
 * an explicit `grammar` string, then a harness schema's `grammar`, then
 * compiling the harness schema's / params' `responseSkeleton`. The prefill plan
 * is only present when a harness schema is supplied (off by default).
 */
export function resolveGuidedDecodeForParams(params) {
	if (!params) return { grammar: null, prefillPlan: null, prefill: null };
	const schema = params.elizaSchema;
	if (schema) {
		const baseGrammar =
			typeof schema.grammar === "string" && schema.grammar.trim().length > 0
				? { source: schema.grammar, lazy: false }
				: compileSkeletonToGbnf(schema.skeleton);
		const plan = schema.prefillPlan ?? compilePrefillPlan(schema.skeleton);
		// Only use the plan's prefix when the caller didn't already supply one.
		const prefill =
			typeof params.prefill === "string" && params.prefill.length > 0
					? params.prefill
					: plan && plan.prefix.length > 0
						? plan.prefix
						: null;
		const grammar =
			baseGrammar && prefill && plan?.prefix === prefill
				? (stripPrefilledPrefixFromGrammar(baseGrammar, prefill) ?? baseGrammar)
				: baseGrammar;
		return { grammar, prefillPlan: plan, prefill };
	}
	return {
		grammar: resolveGrammarForParams(params),
		prefillPlan: null,
		prefill:
			typeof params.prefill === "string" && params.prefill.length > 0
				? params.prefill
				: null,
	};
}
//# sourceMappingURL=structured-output.js.map
