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

import type {
  JSONSchema,
  ResponseSkeleton,
  ResponseSkeletonSpan,
} from "@elizaos/core";

export {
  repairStructuredOutput,
  type StructuredOutputRepairOptions,
  type StructuredOutputRepairResult,
  type StructuredOutputRepairStatus,
  StructuredOutputRepairStream,
} from "./structured-output/deterministic-repair";
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
  /** Optional whole-response JSON schema from `GenerateTextParams`. */
  responseSchema?: JSONSchema;
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
