/**
 * Synthetic output-schema inference for nodes whose output keys are
 * deterministically derivable from their parameters (Summarize, Set, etc.).
 * For nodes with arbitrary user-defined output (Code, Function), returns
 * null — callers should skip downstream field validation rather than
 * false-error.
 *
 * Returning null = "unknowable, do not validate". Returning an empty array
 * also means "unknowable" but signals the caller can warn loudly. We use
 * null (skip) for Code/Function and a populated array for Summarize/Set.
 */

import type { WorkflowNode } from '../types/index';

/** n8n Summarize node aggregation → output prefix. Verified against actual
 *  n8n output during Session 20 dogfood (concatenate→concatenated_<field>,
 *  count→count_<field>). Update this map when new aggregations show up. */
const SUMMARIZE_AGG_PREFIX: Record<string, string> = {
  concatenate: 'concatenated',
  count: 'count',
  countUnique: 'uniqueCount',
  sum: 'sum',
  average: 'average',
  min: 'min',
  max: 'max',
  first: 'first',
  last: 'last',
  append: 'appended',
};

/** Returns top-level output field names a Summarize node will emit, derived
 *  from its `fieldsToSummarize.values[]` parameter. */
function inferSummarizeFields(node: WorkflowNode): string[] | null {
  const fields = (node.parameters as Record<string, unknown> | undefined)?.fieldsToSummarize as
    | { values?: Array<{ aggregation?: string; field?: string }> }
    | undefined;
  if (!fields?.values || !Array.isArray(fields.values)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of fields.values) {
    if (typeof entry?.aggregation !== 'string' || typeof entry?.field !== 'string') {
      continue;
    }
    const prefix = SUMMARIZE_AGG_PREFIX[entry.aggregation];
    if (!prefix) {
      continue;
    }
    out.push(`${prefix}_${entry.field}`);
  }
  return out.length > 0 ? out : null;
}

/** Returns field names a Set / EditFields node will emit, derived from
 *  `assignments.assignments[]` (modern Set node) or `values.<type>[]`
 *  (legacy Set node). */
function inferSetFields(node: WorkflowNode): string[] | null {
  const params = node.parameters as Record<string, unknown> | undefined;
  if (!params) {
    return null;
  }

  // Modern Set / EditFields shape: assignments.assignments[i].name
  const modern = params.assignments as { assignments?: Array<{ name?: string }> } | undefined;
  if (modern?.assignments && Array.isArray(modern.assignments)) {
    const names = modern.assignments
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length > 0) {
      return names;
    }
  }

  // Legacy Set shape: values.{string,number,boolean}[i].name
  const legacy = params.values as Record<string, Array<{ name?: string }>> | undefined;
  if (legacy && typeof legacy === 'object') {
    const names: string[] = [];
    for (const arr of Object.values(legacy)) {
      if (!Array.isArray(arr)) {
        continue;
      }
      for (const v of arr) {
        if (typeof v?.name === 'string' && v.name.length > 0) {
          names.push(v.name);
        }
      }
    }
    if (names.length > 0) {
      return names;
    }
  }

  return null;
}

/**
 * Gmail's `simple: true` mode flattens the response with PascalCase header
 * fields (`Subject`, `From`, `To`, `Date`, ...) — distinct from the static
 * schema in `schemaIndex.json` which captures the non-simple shape with
 * lowercase `subject` etc. Without this override, validateAndRepair sees
 * the static schema, decides `field: "subject"` is valid, and fails to
 * catch the LLM's lowercase pick — Summarize then aggregates 10 empty
 * strings at runtime because Gmail actually emits `Subject` capitalized.
 *
 * Verified during Session 20 dogfood: execution result data on a real
 * Gmail node with `simple: true` had `[id, threadId, snippet, payload,
 * sizeEstimate, historyId, internalDate, labels, Subject, From, To]`.
 */
const GMAIL_SIMPLE_MODE_FIELDS = [
  'id',
  'threadId',
  'snippet',
  'payload',
  'sizeEstimate',
  'historyId',
  'internalDate',
  'labels',
  'Subject',
  'From',
  'To',
  'Date',
  'Cc',
  'Bcc',
  'Reply-To',
];

function inferGmailSimpleFields(node: WorkflowNode): string[] | null {
  const params = node.parameters as Record<string, unknown> | undefined;
  // simple=true is the default in n8n's Gmail node. Treat both `true` and
  // `undefined` as simple-mode unless explicitly disabled.
  if (params?.simple === false) {
    return null;
  }
  return GMAIL_SIMPLE_MODE_FIELDS;
}

/**
 * Returns top-level output field names this node will emit, when derivable
 * from parameters alone. Returns `null` when the schema is unknowable
 * (Code, Function, AI Agent, custom) — callers should treat null as
 * "skip field validation against this node's output", NOT as "no fields".
 */
export function inferSyntheticOutputSchema(node: WorkflowNode): string[] | null {
  switch (node.type) {
    case 'n8n-nodes-base.summarize':
      return inferSummarizeFields(node);
    case 'n8n-nodes-base.set':
    case 'n8n-nodes-base.editFields':
      return inferSetFields(node);
    case 'n8n-nodes-base.gmail':
      // simple-mode override — only applies when simple !== false.
      // For simple=false, return null so the caller falls back to the
      // static schema (which captures the non-simple lowercase shape).
      return inferGmailSimpleFields(node);
    // Arbitrary user output — schema unknowable without execution.
    case 'n8n-nodes-base.code':
    case 'n8n-nodes-base.function':
    case 'n8n-nodes-base.functionItem':
      return null;
    default:
      return null;
  }
}
