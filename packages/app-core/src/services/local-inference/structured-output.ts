/**
 * Structured-output / forced-span / prefill contract for the local-inference
 * engine path.
 *
 * The canonical contract lives in `@elizaos/core` `GenerateTextParams`
 * (`prefill`, `forcedSpans` / `responseSkeleton`, `grammar`,
 * `streamStructured`) — W3 owns those field definitions and threads them
 * through `useModel` → router. This module defines the local-inference-layer
 * mirror of that contract plus the GBNF compilation that turns a
 * `ResponseSkeleton` into a *lazy* grammar so the model only ever samples the
 * free positions of the response envelope (single-value enums collapse to
 * literals — no tokens spent on the scaffold).
 *
 * Nothing here is local-model-specific in shape; the cloud adapters simply
 * never read these fields. There is no fallback path — adapters that can't
 * honour `grammar` / `prefill` / `forcedSpans` ignore them, full stop.
 */

/**
 * A single element of a forced response skeleton. `literal` spans are emitted
 * verbatim with no generation. `free` spans are the positions the model
 * actually samples — optionally constrained by an inline GBNF fragment, an
 * enum, or a JSON-Schema-ish leaf type.
 */
export type ResponseSkeletonSpan =
  | {
      kind: "literal";
      /** Raw text spliced into the output as-is (envelope keys, `": "`, `,\n`, etc.). */
      text: string;
    }
  | {
      kind: "free";
      /** Diagnostic name (e.g. `replyText`, `contexts`) — never emitted. */
      name: string;
      /**
       * Optional GBNF rule body constraining this span. When absent the span
       * is `root ::= [^"]*` (a free string value position) unless `enum` or
       * `leafType` narrows it.
       */
      grammar?: string;
      /**
       * Closed value set for this span. A single-element enum is collapsed to
       * a `literal` span at compile time (C4 — single-value enum/option skip).
       */
      enum?: readonly string[];
      /** JSON leaf shape when the span is a typed scalar value. */
      leafType?: "string" | "number" | "integer" | "boolean";
      /**
       * When true the span is emitted as a quoted JSON string (`"<value>"`);
       * otherwise the raw token sequence (numbers/booleans/object fragments).
       */
      quoted?: boolean;
    };

/**
 * The forced response envelope. `spans` are concatenated in order; `literal`
 * spans cost zero generation, `free` spans are the only positions the model
 * decodes. Carrying *all* evaluator parameters as `free` spans (with default
 * literals around them) is what guarantees post-turn evaluators always have
 * their fields (C5).
 */
export interface ResponseSkeleton {
  spans: readonly ResponseSkeletonSpan[];
  /**
   * Optional human label for diagnostics / telemetry (`response`,
   * `should_respond`, …).
   */
  label?: string;
}

/**
 * GBNF grammar source. Either a full grammar string (`root ::= …`) or a
 * "lazy" grammar that only kicks in after a trigger word/sequence appears in
 * the stream (llama.cpp's `grammar_lazy` + `grammar_triggers`). Lazy grammars
 * let the model free-run the prose prefix (`replyText`) and only constrain the
 * structured scaffold once the envelope boundary is reached.
 */
export interface GbnfGrammar {
  /** GBNF source. */
  source: string;
  /**
   * When true, the server applies the grammar lazily — generation runs
   * unconstrained until a trigger fires. Maps to llama-server's
   * `grammar_lazy: true`.
   */
  lazy?: boolean;
  /**
   * Trigger sequences that activate a lazy grammar. Plain strings (or
   * `{ word }` objects) — maps to llama-server's `grammar_triggers`.
   */
  triggers?: ReadonlyArray<string | { word: string }>;
}

/**
 * Local-inference mirror of the structured-output extensions on
 * `GenerateTextParams`. Threaded `useModel` → router → local handler →
 * engine → dflash-server. Kept structurally compatible with the canonical
 * core contract; reconcile field names with W3 when that lands.
 */
export interface StructuredGenerateParams {
  /**
   * Assistant-turn prefill — a partial assistant message the model should
   * *continue* rather than start fresh. On llama-server this is sent as a
   * trailing assistant message with `continue_final_message: true` (Jinja
   * chat template prefix) or, on the raw `/completion` path, appended to the
   * applied template before the model decodes.
   */
  prefill?: string;
  /**
   * Forced response skeleton. When set the engine compiles it to a lazy GBNF
   * (single-value enums → literals) so the model only samples the free
   * positions of the envelope (C2/C3/C4). The multi-call infill loop is the
   * fallback when a grammar can't express the skeleton.
   */
  responseSkeleton?: ResponseSkeleton;
  /** Alias for `responseSkeleton` — W3's contract names it `forcedSpans`. */
  forcedSpans?: ResponseSkeleton;
  /** Explicit GBNF grammar (overrides the compiled skeleton grammar). */
  grammar?: GbnfGrammar;
  /**
   * When true, the engine streams per-token chunks back via `onTextChunk`
   * (and the structured-field events) instead of returning the whole string
   * in one shot.
   */
  streamStructured?: boolean;
}

/** Resolve the skeleton from either field name. */
export function resolveResponseSkeleton(
  params: StructuredGenerateParams | undefined,
): ResponseSkeleton | undefined {
  if (!params) return undefined;
  return params.responseSkeleton ?? params.forcedSpans ?? undefined;
}

/**
 * Escape a string for use inside a GBNF double-quoted literal. GBNF literals
 * use C-style escapes; `"` and `\` must be escaped, and control chars become
 * `\xNN`.
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
 * Collapse a skeleton: any `free` span whose `enum` has exactly one value (or
 * whose constraint is otherwise degenerate) becomes a `literal` span. This is
 * C4 — when only one value is possible given current state, the model spends
 * zero tokens on it. Adjacent literals are merged.
 */
export function collapseSkeleton(skeleton: ResponseSkeleton): ResponseSkeleton {
  const out: ResponseSkeletonSpan[] = [];
  const pushLiteral = (text: string): void => {
    if (text.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.kind === "literal") last.text += text;
    else out.push({ kind: "literal", text });
  };
  for (const span of skeleton.spans) {
    if (span.kind === "literal") {
      pushLiteral(span.text);
      continue;
    }
    if (span.enum && span.enum.length === 1) {
      const value = span.enum[0];
      pushLiteral(span.quoted ? `"${value}"` : value);
      continue;
    }
    out.push(span);
  }
  return { spans: out, label: skeleton.label };
}

/** GBNF leaf-type rule bodies. */
const GBNF_LEAF_RULES: Record<string, string> = {
  string: '"\\"" ([^"\\\\] | "\\\\" .)* "\\""',
  number: '"-"? [0-9]+ ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
  integer: '"-"? [0-9]+',
  boolean: '"true" | "false"',
};

/**
 * Compile a `ResponseSkeleton` to a *lazy* GBNF grammar. The grammar's `root`
 * rule is the concatenation of every span:
 *   - `literal` spans become GBNF string literals,
 *   - `free` spans become a named sub-rule (their inline `grammar`, or an
 *     `enum` alternation, or a leaf-type rule, or a default free-string),
 * and the grammar runs *lazily* — generation free-runs until the first
 * literal of the skeleton is reached (the trigger), then the grammar pins the
 * rest of the envelope. That keeps the prose `replyText` unconstrained while
 * forcing the JSON scaffold (C2/C3/C5/C6).
 *
 * Returns `null` when the skeleton is fully literal (nothing for the model to
 * sample — the caller should just emit the literal text and skip generation).
 */
export function compileSkeletonToGbnf(
  skeletonInput: ResponseSkeleton,
): GbnfGrammar | null {
  const skeleton = collapseSkeleton(skeletonInput);
  const hasFree = skeleton.spans.some((s) => s.kind === "free");
  if (!hasFree) return null;

  const rules: string[] = [];
  const rootParts: string[] = [];
  let freeIdx = 0;
  // The lazy-trigger is the leading literal (if any). When the skeleton opens
  // with a `free` span there's no trigger word and the grammar is non-lazy.
  let triggerWord: string | null = null;

  for (let i = 0; i < skeleton.spans.length; i += 1) {
    const span = skeleton.spans[i];
    if (span.kind === "literal") {
      if (i === 0 && span.text.length > 0) triggerWord = span.text;
      rootParts.push(`"${gbnfEscapeLiteral(span.text)}"`);
      continue;
    }
    const ruleName = `free${freeIdx++}`;
    let body: string;
    if (span.grammar && span.grammar.trim().length > 0) {
      body = span.grammar.trim();
    } else if (span.enum && span.enum.length > 0) {
      const alts = span.enum.map((v) => {
        const value = span.quoted ? `"${v}"` : v;
        return `"${gbnfEscapeLiteral(value)}"`;
      });
      body = alts.join(" | ");
    } else if (span.leafType) {
      const leaf = GBNF_LEAF_RULES[span.leafType];
      body = span.quoted && span.leafType !== "string"
        ? `"\\"" (${leaf}) "\\""`
        : leaf;
    } else {
      // Default: a free (unquoted-content) JSON string body. The skeleton's
      // surrounding literals supply the quotes when `quoted` would have.
      body = span.quoted
        ? '"\\"" ([^"\\\\] | "\\\\" .)* "\\""'
        : '([^"\\\\] | "\\\\" .)*';
    }
    rules.push(`${ruleName} ::= ${body}`);
    rootParts.push(ruleName);
  }

  const source = [`root ::= ${rootParts.join(" ")}`, ...rules].join("\n");
  if (triggerWord) {
    return { source, lazy: true, triggers: [{ word: triggerWord }] };
  }
  return { source, lazy: false };
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
      out.grammar_triggers = grammar.triggers.map((t) =>
        typeof t === "string" ? { type: "word", value: t } : { type: "word", value: t.word },
      );
    }
  }
  return out;
}

/**
 * Split a `ResponseSkeleton` into the leading literal prefix (suitable for an
 * assistant-turn prefill) plus the remaining spans. Useful for the multi-call
 * infill fallback: emit the prefix as a prefill, generate the first free span,
 * then loop.
 */
export function splitSkeletonAtFirstFree(skeleton: ResponseSkeleton): {
  prefixLiteral: string;
  rest: readonly ResponseSkeletonSpan[];
} {
  let prefixLiteral = "";
  let idx = 0;
  while (idx < skeleton.spans.length && skeleton.spans[idx].kind === "literal") {
    prefixLiteral += (skeleton.spans[idx] as { text: string }).text;
    idx += 1;
  }
  return { prefixLiteral, rest: skeleton.spans.slice(idx) };
}
