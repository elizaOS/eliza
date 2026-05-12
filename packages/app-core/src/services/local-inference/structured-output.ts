/**
 * Structured-output / forced-span / prefill plumbing for the local-inference
 * engine path.
 *
 * The canonical contract lives in `@elizaos/core` `GenerateTextParams`
 * (`prefill`, `responseSkeleton`, `grammar`, `streamStructured`) — W3 owns
 * those field definitions and threads them through `useModel` → router. This
 * module is the local-inference-layer mirror of the relevant subset plus the
 * GBNF compilation that turns a `ResponseSkeleton` into a *lazy* grammar so
 * the model only ever samples the free positions of the response envelope
 * (single-value enums collapse to literals — no tokens spent on the scaffold).
 *
 * Nothing here is local-model-specific in shape; cloud adapters never read
 * these fields. There is no fallback path — adapters that can't honour
 * `grammar` / `prefill` / `responseSkeleton` ignore them, full stop.
 */

import type { ResponseSkeleton, ResponseSkeletonSpan } from "@elizaos/core";

export type { ResponseSkeleton, ResponseSkeletonSpan };

/**
 * GBNF grammar fragment ready for a llama-server request body. `lazy` grammars
 * only kick in once a trigger word/sequence appears in the stream
 * (llama.cpp's `grammar_lazy` + `grammar_triggers`) — that lets the model
 * free-run the prose `replyText` and only constrain the structured scaffold
 * once the envelope boundary is reached.
 */
export interface GbnfGrammar {
  /** GBNF source. */
  source: string;
  /** When true, the server applies the grammar lazily (`grammar_lazy: true`). */
  lazy?: boolean;
  /** Trigger words that activate a lazy grammar (`grammar_triggers`). */
  triggers?: ReadonlyArray<string>;
}

/**
 * Local-inference mirror of the structured-output extensions on
 * `GenerateTextParams`. Threaded `useModel` → router → local handler →
 * engine → dflash-server.
 */
export interface StructuredGenerateParams {
  /**
   * Assistant-turn prefill — a partial assistant message the model should
   * *continue* rather than start fresh. On llama-server this is sent as a
   * trailing assistant message with `continue_final_message` / the
   * `assistant` chat-template prefix; the node-llama-cpp path seeds the
   * prompt text and re-prepends the prefill to the result.
   */
  prefill?: string;
  /**
   * Forced response skeleton. When set the engine compiles it to a lazy GBNF
   * (single-value enums → literals) so the model only samples the free
   * positions of the envelope.
   */
  responseSkeleton?: ResponseSkeleton;
  /**
   * Explicit GBNF grammar string. When both `grammar` and `responseSkeleton`
   * are present, the explicit `grammar` wins (W3 contract).
   */
  grammar?: string;
  /**
   * When true, the engine streams per-token chunks back via `onTextChunk`
   * (and structured-field events) instead of returning the whole string in
   * one shot.
   */
  streamStructured?: boolean;
  /**
   * The eliza harness schema for this call — the compact descriptor bundling
   * the response skeleton, a pre-built grammar (optional), the derived
   * deterministic-token {@link ElizaPrefillPlan}, and the short/long name maps.
   * When present, guided structured decode is *on* for this call: the engine
   * sends the grammar AND the prefill plan, and seeds the leading literal run
   * as an assistant-turn prefill. Absent → guided decode is off (the engine
   * may still honour a bare `grammar` / `responseSkeleton`, but never emits a
   * prefill plan). This is the off-by-default switch for the deterministic
   * short-circuit.
   */
  elizaSchema?: ElizaHarnessSchema;
}

/** True when `kind` is a span the model actually samples. */
function isFreeSpan(span: ResponseSkeletonSpan): boolean {
  return (
    span.kind === "free-string" ||
    span.kind === "free-json" ||
    (span.kind === "enum" &&
      Array.isArray(span.enumValues) &&
      span.enumValues.length > 1)
  );
}

/**
 * Escape a string for use inside a GBNF double-quoted literal (C-style escapes).
 */
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

/**
 * Collapse a skeleton: `enum` spans with exactly one value (or zero values)
 * become `literal` spans (C4). Adjacent literals stay separate spans — the
 * compiler merges them in the root rule.
 */
export function collapseSkeleton(skeleton: ResponseSkeleton): ResponseSkeleton {
  const out: ResponseSkeletonSpan[] = [];
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
export function compileSkeletonToGbnf(
  skeletonInput: ResponseSkeleton,
): GbnfGrammar | null {
  const skeleton = collapseSkeleton(skeletonInput);
  if (!skeleton.spans.some(isFreeSpan)) return null;

  const rules = new Map<string, string>();
  const rootParts: string[] = [];
  let freeIdx = 0;
  let needsJsonValue = false;
  let triggerWord: string | null = null;

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
export function resolveGrammarForParams(
  params: StructuredGenerateParams | undefined,
): GbnfGrammar | null {
  if (!params) return null;
  if (typeof params.grammar === "string" && params.grammar.trim().length > 0) {
    return { source: params.grammar, lazy: false };
  }
  if (params.responseSkeleton) {
    return compileSkeletonToGbnf(params.responseSkeleton);
  }
  return null;
}

/**
 * Build the OpenAI-/llama-server-compatible request-body fragment for a
 * grammar. Returns `grammar` + (when lazy) `grammar_lazy` / `grammar_triggers`.
 * Recent llama.cpp accepts these on both `/v1/chat/completions` and
 * `/completion`.
 */
export function grammarRequestFields(
  grammar: GbnfGrammar,
): Record<string, unknown> {
  const out: Record<string, unknown> = { grammar: grammar.source };
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
export function splitSkeletonAtFirstFree(skeleton: ResponseSkeleton): {
  prefixLiteral: string;
  rest: ResponseSkeletonSpan[];
} {
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

// ---------------------------------------------------------------------------
// Deterministic-token prefill plan
// ---------------------------------------------------------------------------
//
// The grammar bounds the *search* but the model still spends one forward pass
// per sampled token, including on the scaffold positions that the grammar
// forces (the JSON braces, the fixed key names, the `": "` glue). A
// constrained-decode server that understands the schema can do better: when a
// run of bytes is *deterministically implied* by the schema given the branch
// chosen so far, it can write those token ids straight into the sequence and
// advance the decoder to the next free parameter without a forward pass. The
// {@link ElizaPrefillPlan} is the compact metadata the engine sends so the
// server can do exactly that.
//
// The plan is purely a *speedup hint*. A server that ignores it still produces
// the identical output (the grammar already forces the same bytes); a server
// that honours it produces the identical output faster. Off by default — the
// engine only emits it when an `ElizaHarnessSchema` (or a `prefillPlan`) is
// present on the request, never for unguided generation.

/**
 * One deterministically-forced byte run in an {@link ElizaPrefillPlan}. The
 * runs alternate with the free (sampled) spans, so a run is unambiguously
 * anchored by *position* in that alternation rather than by an absolute byte
 * offset (the sampled spans have unknown length at plan time):
 *
 *   run[0]  free[0]  run[1]  free[1]  …  run[n]   (n = number of free spans)
 *
 * `afterFreeSpan` is `-1` for the leading run (before any free span — the
 * assistant-turn prefill), then `0, 1, 2, …` for the run that follows free
 * span 0, 1, 2, … . The server resumes sampling after writing each run; once
 * the matching free span is sampled it writes the next run's token ids without
 * a forward pass and advances the decoder to the next free span.
 */
export interface PrefillRun {
  /**
   * Index of the free span this run *follows*. `-1` = the leading run (the
   * prefill); `k >= 0` = the run after free span `k`. The last run (`n`) is the
   * tail scaffold (closing braces) after the final free span.
   */
  afterFreeSpan: number;
  /** The deterministically-forced bytes. */
  text: string;
}

/**
 * Compact descriptor of the deterministic structure of a constrained decode:
 * the ordered runs of bytes that are fixed (so the server can prefill their
 * token ids and skip the forward passes) interleaved with the count of free
 * positions, plus the leading literal run that should be seeded as an
 * assistant-turn prefill (`prefix`). Sent on the request as `eliza_prefill_plan`.
 *
 * Purely a speedup hint — a server that ignores it produces the identical
 * output because the lazy GBNF already forces the same bytes.
 */
export interface ElizaPrefillPlan {
  /**
   * The leading deterministic run — emitted as an assistant-turn prefill so
   * the model never samples it. Empty when the skeleton opens with a free span.
   */
  prefix: string;
  /**
   * Deterministic byte runs alternating with the free spans (see
   * {@link PrefillRun}), in output order, including the prefix run when
   * non-empty.
   */
  runs: PrefillRun[];
  /** Number of free (sampled) spans in the skeleton. `runs.length` is `freeCount + 1` minus the leading run when the skeleton starts free. */
  freeCount: number;
  /**
   * Opaque cache key (mirrors the skeleton's `id`) so the server can cache the
   * tokenised form of the runs across turns when the structure is unchanged.
   */
  id?: string;
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
export function compilePrefillPlan(
  skeletonInput: ResponseSkeleton,
): ElizaPrefillPlan | null {
  const skeleton = collapseSkeleton(skeletonInput);
  const runs: PrefillRun[] = [];
  let freeCount = 0;
  let pending = "";

  const flushPending = (afterFreeSpan: number) => {
    if (pending.length === 0) return;
    runs.push({ afterFreeSpan, text: pending });
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
export function prefillPlanRequestFields(
  plan: ElizaPrefillPlan | null,
): Record<string, unknown> {
  if (!plan) return {};
  return {
    eliza_prefill_plan: {
      prefix: plan.prefix,
      runs: plan.runs.map((r) => ({
        after_free_span: r.afterFreeSpan,
        text: r.text,
      })),
      free_count: plan.freeCount,
      id: plan.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Eliza harness schema — the compact descriptor the agent loop hands the engine
// ---------------------------------------------------------------------------

/**
 * The compact, engine-facing descriptor for a structured output the agent loop
 * wants forced. It is the bundle of (a) a {@link ResponseSkeleton} (which
 * compiles to a lazy GBNF for the constrained-decode path), (b) the derived
 * {@link ElizaPrefillPlan} (the deterministic-token short-circuit), and (c) the
 * short-name ↔ long-name maps so the on-wire/decoded form uses canonical short
 * action ids / enum values and the runtime expands them for the caller.
 *
 * Producers: `@elizaos/core` `buildPlannerActionGrammar` / `buildResponseGrammar`
 * wrapped by {@link elizaHarnessSchemaFromSkeleton}. Consumer: the local engine
 * (`dflash-server.ts` / `engine.ts`).
 */
export interface ElizaHarnessSchema {
  /** Structure-forcing description; compiles to a lazy GBNF. */
  skeleton: ResponseSkeleton;
  /** Pre-built GBNF (wins over compiling the skeleton), when the producer made one. */
  grammar?: string;
  /** Deterministic-token short-circuit derived from the skeleton. */
  prefillPlan: ElizaPrefillPlan | null;
  /**
   * Canonical short id → human-facing long name (display label), for any
   * closed enum the descriptor pins (action ids, known enum values). The wire
   * form is the short id; callers that want the long name look it up here.
   * Empty when nothing needs expanding.
   */
  longNames: Record<string, string>;
  /** Cache key (the skeleton's id). */
  id?: string;
}

/**
 * Wrap a {@link ResponseSkeleton} (+ optional pre-built grammar + name map)
 * into an {@link ElizaHarnessSchema}, computing the prefill plan. This is the
 * single place the prefill plan is derived so producers don't each reimplement
 * it.
 */
export function elizaHarnessSchemaFromSkeleton(input: {
  skeleton: ResponseSkeleton;
  grammar?: string;
  longNames?: Record<string, string>;
}): ElizaHarnessSchema {
  return {
    skeleton: input.skeleton,
    grammar: input.grammar,
    prefillPlan: compilePrefillPlan(input.skeleton),
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
export function expandShortName(
  schema: ElizaHarnessSchema | undefined,
  shortId: string,
): string {
  if (!schema) return shortId;
  return schema.longNames[shortId] ?? shortId;
}

/**
 * Invert {@link expandShortName}: given a (possibly long) name the caller
 * supplied, return the canonical short id the wire form expects. Identity when
 * the name is already a known short id or no mapping matches.
 */
export function canonicalizeShortName(
  schema: ElizaHarnessSchema | undefined,
  name: string,
): string {
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
export function resolveGuidedDecodeForParams(
  params: StructuredGenerateParams | undefined,
): {
  grammar: GbnfGrammar | null;
  prefillPlan: ElizaPrefillPlan | null;
  prefill: string | null;
} {
  if (!params) return { grammar: null, prefillPlan: null, prefill: null };
  const schema = params.elizaSchema;
  if (schema) {
    const grammar: GbnfGrammar | null =
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
