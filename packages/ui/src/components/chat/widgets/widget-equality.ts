/**
 * Structural-equality predicates for the memoized inline chat widgets.
 *
 * The chat transcript re-parses every message body on each streamed token
 * (`MessageContent` → `parseSegments`), so a widget receives a FRESH
 * `data`-derived props object on every stream tick even when nothing about
 * that widget's payload changed. `React.memo`'s default referential check
 * therefore never bails — the widget re-renders on every token in the whole
 * turn. These predicates compare the widget's data props by VALUE so a memo'd
 * widget bails out unless its own payload actually changed, matching the
 * per-row comparator `chat-message.tsx` uses for the same reason.
 *
 * The interactive widgets also take callback props (`onChoose`, `onSubmit`,
 * `onNavigate`, `onPrompt`). Those come from the memoized `inlineWidgetCtx`
 * (`useInlineWidgetContext`), so they are stable references across renders and
 * a referential `===` on them is correct — a changed callback identity means
 * the host really did rebind and the widget must re-render.
 *
 * The predicates are exported so each widget's render-count regression test can
 * assert against the exact comparator the component ships with (not a re-derived
 * copy that could drift).
 */

import type { SwarmActivityPlanEntry } from "@elizaos/core";
import type { FollowupOption } from "../message-followups-parser";
import type { FormFieldSpec, FormRequestSpec } from "../message-form-parser";
import type {
  WorkflowSpec,
  WorkflowStepSpec,
} from "../message-workflow-parser";
import type { ChoiceOption } from "./ChoiceWidget";

/** Value-equal two same-order lists via a per-element predicate. */
function listEqual<T>(
  a: readonly T[],
  b: readonly T[],
  itemEqual: (x: T, y: T) => boolean,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!itemEqual(a[i], b[i])) return false;
  }
  return true;
}

function choiceOptionEqual(a: ChoiceOption, b: ChoiceOption): boolean {
  return a.value === b.value && a.label === b.label;
}

/** Choice widget: id/scope/allowCustom plus the option list by value. */
export function choicePropsEqual(
  prev: {
    id: string;
    scope: string;
    allowCustom?: boolean;
    options: ChoiceOption[];
    onChoose: (value: string) => void;
  },
  next: {
    id: string;
    scope: string;
    allowCustom?: boolean;
    options: ChoiceOption[];
    onChoose: (value: string) => void;
  },
): boolean {
  return (
    prev.id === next.id &&
    prev.scope === next.scope &&
    Boolean(prev.allowCustom) === Boolean(next.allowCustom) &&
    prev.onChoose === next.onChoose &&
    listEqual(prev.options, next.options, choiceOptionEqual)
  );
}

function followupOptionEqual(a: FollowupOption, b: FollowupOption): boolean {
  return a.kind === b.kind && a.payload === b.payload && a.label === b.label;
}

/** Followups widget: id, the three callbacks by identity, options by value. */
export function followupsPropsEqual(
  prev: {
    id: string;
    options: FollowupOption[];
    onChoose: (value: string) => void;
    onNavigate?: (payload: string) => void;
    onPrompt?: (payload: string) => void;
  },
  next: {
    id: string;
    options: FollowupOption[];
    onChoose: (value: string) => void;
    onNavigate?: (payload: string) => void;
    onPrompt?: (payload: string) => void;
  },
): boolean {
  return (
    prev.id === next.id &&
    prev.onChoose === next.onChoose &&
    prev.onNavigate === next.onNavigate &&
    prev.onPrompt === next.onPrompt &&
    listEqual(prev.options, next.options, followupOptionEqual)
  );
}

function formFieldEqual(a: FormFieldSpec, b: FormFieldSpec): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    a.label === b.label &&
    a.placeholder === b.placeholder &&
    Boolean(a.required) === Boolean(b.required) &&
    listEqual(
      a.options ?? [],
      b.options ?? [],
      (x, y) => x.value === y.value && x.label === y.label,
    )
  );
}

function formSpecEqual(a: FormRequestSpec, b: FormRequestSpec): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.submitLabel === b.submitLabel &&
    listEqual(a.fields, b.fields, formFieldEqual)
  );
}

/**
 * Form widget: the form spec by value plus `onSubmit` by identity. The form
 * carries user-entered state internally, so a payload-equal re-parse must NOT
 * remount it (that would wipe half-filled inputs) — this predicate is what
 * lets the memo keep the same instance across streamed tokens.
 */
export function formRequestPropsEqual(
  prev: { form: FormRequestSpec; onSubmit: unknown },
  next: { form: FormRequestSpec; onSubmit: unknown },
): boolean {
  return prev.onSubmit === next.onSubmit && formSpecEqual(prev.form, next.form);
}

function workflowStepEqual(a: WorkflowStepSpec, b: WorkflowStepSpec): boolean {
  return a.label === b.label && a.status === b.status;
}

/**
 * Workflow widget: id/title plus the step list by value. A re-emitted block
 * that advances a step's status IS a real change and must re-render; a
 * re-parse that produced the same statuses must not.
 */
export function workflowPropsEqual(
  prev: { workflow: WorkflowSpec },
  next: { workflow: WorkflowSpec },
): boolean {
  const a = prev.workflow;
  const b = next.workflow;
  return (
    a.id === b.id &&
    a.title === b.title &&
    listEqual(a.steps, b.steps, workflowStepEqual)
  );
}

function planEntryEqual(
  a: SwarmActivityPlanEntry,
  b: SwarmActivityPlanEntry,
): boolean {
  return a.content === b.content && a.status === b.status;
}

/**
 * Plan/checklist widget: the entries by value plus the title. Entry status
 * advancing (`pending`→`in_progress`→`completed`) is a real change; an
 * identical re-parse is not.
 */
export function planChecklistPropsEqual(
  prev: {
    entries: SwarmActivityPlanEntry[];
    title?: string;
    headerless?: boolean;
  },
  next: {
    entries: SwarmActivityPlanEntry[];
    title?: string;
    headerless?: boolean;
  },
): boolean {
  return (
    prev.title === next.title &&
    prev.headerless === next.headerless &&
    listEqual(prev.entries, next.entries, planEntryEqual)
  );
}
