/**
 * Inline chat-reply widget registry.
 *
 * An assistant reply can embed widgets as text markers (e.g.
 * `[TASK:<id>]…[/TASK]`, `[CHOICE:…]…[/CHOICE]`). `MessageContent` resolves
 * those markers into rendered React by walking this registry instead of a
 * hard-coded switch — so a plugin can teach the chat surface a new widget by
 * registering its parser + renderer, with no edit to `MessageContent`.
 *
 * A definition owns two halves of one concern:
 *   - `parse(text)` — the marker's parsing semantics: scan a reply for this
 *     widget's regions and hand back their char bounds + typed payload.
 *   - `render(data, ctx, key)` — turn one payload into a React node, calling
 *     `ctx` handlers to drive the chat surface (send a reply, prefill the
 *     composer, navigate, submit a form). A widget that just displays state
 *     (the task card) ignores `ctx` entirely.
 *
 * Built-ins register at module load via `./inline-builtins`. The registry is a
 * process-global keyed by `kind`; re-registering a `kind` replaces it.
 */

import type { ReactNode } from "react";
import type { FormResultValue } from "./form-request";

/**
 * Chat-surface handlers an inline widget may call. Carried per render; widgets
 * that need none simply ignore the fields.
 */
export interface InlineWidgetContext {
  /** Send a value back through the action-message pipeline (a choice pick). */
  sendAction: (value: string) => void;
  /** Passive view-switch suggestion (a followup `navigate` chip). */
  navigate: (payload: string) => void;
  /** Prefill the composer draft (a followup `prompt` chip). */
  prefillComposer: (payload: string) => void;
  /** Submit a structured in-chat form. */
  submitForm: (formId: string, values: Record<string, FormResultValue>) => void;
}

/** One matched region of a reply: char bounds + the renderer's typed payload. */
export interface InlineWidgetMatch<TData = unknown> {
  start: number;
  end: number;
  data: TData;
}

export interface InlineWidgetDefinition<TData = unknown> {
  /** Unique marker kind, e.g. `"task"`, `"choice"`. */
  readonly kind: string;
  /**
   * The literal prefix every occurrence of this widget's opening marker starts
   * with, e.g. `"[FORM"` for `[FORM]…[/FORM]`. Defaults to `"[" + kind.toUpperCase()`,
   * which is correct for all seven built-ins. The incremental streaming parser
   * (`message-parser-incremental.ts`) uses it to detect an as-yet-unclosed
   * marker sitting in prose before the stable cut — a future close token could
   * retroactively claim that prose into a widget region, so the cut must not
   * advance past an open marker. A plugin whose opening marker does NOT start
   * with the default token must set this, or it forfeits ONLY the incremental
   * fast path (correctness is unaffected — the parser falls back to a full parse).
   */
  readonly openToken?: string;
  /**
   * Scan a reply for this widget's regions, left to right.
   *
   * Marker contract: the text form MUST be a bracketed `[…]` marker (like all
   * built-ins), and its opening text MUST start with {@link openToken}.
   * `parseSegments` pre-gates the whole widget scan on the message containing
   * one of `` ` `` `[` `{` `<`, so a marker without any of those characters
   * would never reach this parser on plain-prose messages.
   */
  parse(text: string): InlineWidgetMatch<TData>[];
  /** Render one matched payload. `key` is React-stable; `ctx` drives chat. */
  render(data: TData, ctx: InlineWidgetContext, key: string): ReactNode;
  /** Stable key fragment for reconciliation (defaults to `kind`). */
  keyFor?(data: TData): string;
}

const REGISTRY = new Map<string, InlineWidgetDefinition>();

/** Register (or replace) an inline widget by its marker `kind`. */
export function registerInlineWidget<TData>(
  definition: InlineWidgetDefinition<TData>,
): void {
  REGISTRY.set(definition.kind, definition as InlineWidgetDefinition);
}

/** All registered inline widgets, registration order. */
export function getInlineWidgets(): InlineWidgetDefinition[] {
  return [...REGISTRY.values()];
}

/** Look up one inline widget by its marker `kind`. */
export function getInlineWidget(
  kind: string,
): InlineWidgetDefinition | undefined {
  return REGISTRY.get(kind);
}

/** The default opening-marker prefix for a widget kind (`[KIND`). */
export function defaultOpenToken(kind: string): string {
  return `[${kind.toUpperCase()}`;
}

/**
 * The opening-marker prefixes of every registered widget, for the incremental
 * streaming parser's open-marker guard. Uses each definition's `openToken`,
 * falling back to `[KIND`.
 */
export function getInlineWidgetOpenTokens(): string[] {
  return [...REGISTRY.values()].map(
    (widget) => widget.openToken ?? defaultOpenToken(widget.kind),
  );
}
