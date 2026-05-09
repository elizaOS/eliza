/**
 * Clarification helpers for n8n workflow generation routes.
 *
 * - `coerceClarifications`: normalizes the plugin's mixed-shape
 *   `_meta.requiresClarification` (legacy strings + structured objects)
 *   into typed `N8nClarificationRequest[]`.
 * - `setByDotPath`: applies `{paramPath, value}` resolutions to a draft
 *   workflow JSON in place. Supports dot segments and bracketed-string
 *   segments (`nodes["Discord Send"].parameters.channelId`).
 *
 * Kept out of `n8n-routes.ts` so the handlers stay focused on transport.
 */

import { logger } from '@elizaos/core';
import type {
  N8nClarificationRequest,
  N8nClarificationResolution,
  N8nClarificationTargetGroup,
} from '@elizaos/app-core/api/client-types-chat';

const VALID_KINDS: ReadonlySet<N8nClarificationRequest['kind']> = new Set([
  'target_channel',
  'target_server',
  'recipient',
  'value',
  'free_text',
]);

function isStructuredClarification(v: unknown): v is N8nClarificationRequest {
  if (!v || typeof v !== 'object') {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.question !== 'string' || o.question.trim().length === 0) {
    return false;
  }
  // `kind` and `paramPath` may be missing on partial / older payloads — we
  // default them here rather than reject the item outright.
  return true;
}

export function coerceClarifications(raw: unknown): N8nClarificationRequest[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const out: N8nClarificationRequest[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        continue;
      }
      out.push({ kind: 'free_text', question: trimmed, paramPath: '' });
      continue;
    }
    if (!isStructuredClarification(item)) {
      continue;
    }
    const o = item as unknown as Record<string, unknown>;
    const kindRaw = typeof o.kind === 'string' ? o.kind : 'free_text';
    const kind = (
      VALID_KINDS.has(kindRaw as N8nClarificationRequest['kind']) ? kindRaw : 'free_text'
    ) as N8nClarificationRequest['kind'];
    const platform = typeof o.platform === 'string' ? o.platform : undefined;
    let scope: { guildId?: string } | undefined;
    if (
      o.scope &&
      typeof o.scope === 'object' &&
      typeof (o.scope as Record<string, unknown>).guildId === 'string'
    ) {
      scope = {
        guildId: (o.scope as Record<string, string>).guildId,
      };
    }
    const paramPath = typeof o.paramPath === 'string' ? o.paramPath : '';
    out.push({
      kind,
      platform,
      scope,
      question: (o.question as string).trim(),
      paramPath,
    });
  }
  return out;
}

/**
 * Tokenizer for paramPath. Handles three segment forms:
 *   - dot identifier:        `parameters`
 *   - bracketed quoted key:  `["Discord Send"]` or `['k']`
 *   - bracketed numeric:     `[0]`
 */
export function parseParamPath(path: string): string[] {
  const segments: string[] = [];
  let i = 0;
  const n = path.length;
  while (i < n) {
    const ch = path[i];
    if (ch === '.') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) {
        throw new Error(`unterminated bracket at index ${i}`);
      }
      const inner = path.slice(i + 1, close).trim();
      if (inner.length === 0) {
        throw new Error(`empty bracket at index ${i}`);
      }
      const first = inner[0];
      const last = inner[inner.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        segments.push(inner.slice(1, -1));
      } else if (/^[0-9]+$/.test(inner)) {
        segments.push(inner);
      } else {
        // Unquoted bare identifier inside brackets — accept to be lenient
        // with LLM output (e.g. `[channelId]`).
        segments.push(inner);
      }
      i = close + 1;
      continue;
    }
    // Identifier run: read until next `.` or `[`.
    let j = i;
    while (j < n && path[j] !== '.' && path[j] !== '[') {
      j += 1;
    }
    const ident = path.slice(i, j).trim();
    if (ident.length === 0) {
      throw new Error(`empty identifier at index ${i}`);
    }
    segments.push(ident);
    i = j;
  }
  if (segments.length === 0) {
    throw new Error('paramPath has no segments');
  }
  return segments;
}

/**
 * Find the index of a named entry in an array of objects, matching against
 * `.name` first then `.id`. Returns -1 if no match. Used by `setByDotPath`
 * to resolve `nodes["My Node"]`-style segments — the LLM consistently
 * addresses n8n nodes by their human name even though `workflow.nodes` is
 * an array, so we map name → index here rather than rejecting the path.
 */
function findArrayIndexByNameOrId(arr: unknown[], key: string): number {
  for (let i = 0; i < arr.length; i += 1) {
    const entry = arr[i];
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (obj.name === key || obj.id === key) {
      return i;
    }
  }
  return -1;
}

/**
 * Mutate `obj` so that its value at `paramPath` becomes `value`. Creates
 * intermediate plain objects as needed; never replaces an existing
 * non-object intermediate (those throw, since the path is invalid).
 *
 * Segments that hit an array can be:
 *   - numeric → direct index
 *   - non-numeric (string) → looked up against the array's `.name` or `.id`
 *     field. Common in LLM output for n8n workflows: the model writes
 *     `nodes["Post to Slack"]` rather than `nodes[2]`. Treating that as a
 *     hard failure forced every clarification resolution through a 400.
 *
 * If the segment expects an array but the existing intermediate is a non-
 * array object, we treat it as an object key (n8n workflow shapes mix arrays
 * and objects fairly freely; we err on the side of preserving structure).
 */
export function setByDotPath(
  obj: Record<string, unknown>,
  paramPath: string,
  value: unknown
): void {
  const segments = parseParamPath(paramPath);
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    const isArrayIndex = /^[0-9]+$/.test(seg);
    if (Array.isArray(cur)) {
      let idx: number;
      if (isArrayIndex) {
        idx = Number(seg);
      } else {
        idx = findArrayIndexByNameOrId(cur, seg);
        if (idx < 0) {
          throw new Error(
            `paramPath segment "${seg}" did not match any element by name/id at depth ${i}`
          );
        }
      }
      let next = cur[idx];
      if (next === undefined || next === null) {
        next = /^[0-9]+$/.test(segments[i + 1]) ? [] : {};
        cur[idx] = next;
      }
      if (typeof next !== 'object') {
        throw new Error(`paramPath cannot descend into non-object at "${seg}" (depth ${i})`);
      }
      cur = next as Record<string, unknown> | unknown[];
      continue;
    }
    let next = (cur as Record<string, unknown>)[seg];
    if (next === undefined || next === null) {
      next = /^[0-9]+$/.test(segments[i + 1]) ? [] : {};
      (cur as Record<string, unknown>)[seg] = next;
    }
    if (typeof next !== 'object') {
      throw new Error(`paramPath cannot descend into non-object at "${seg}" (depth ${i})`);
    }
    cur = next as Record<string, unknown> | unknown[];
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cur)) {
    if (/^[0-9]+$/.test(last)) {
      cur[Number(last)] = value;
      return;
    }
    const idx = findArrayIndexByNameOrId(cur, last);
    if (idx < 0) {
      throw new Error(
        `paramPath terminal segment "${last}" did not match any element by name/id at array`
      );
    }
    cur[idx] = value;
  } else {
    (cur as Record<string, unknown>)[last] = value;
  }
}

/**
 * Append a free-form answer to `draft._meta.userNotes`. Used for
 * clarifications with no `paramPath` AND as the fallback when
 * `setByDotPath` can't resolve a paramPath against the current draft.
 * Subsequent LLM regeneration rounds read these notes from `_meta` so the
 * user's answer is preserved across the failure rather than discarded.
 */
function appendUserNote(draft: Record<string, unknown>, value: string): void {
  const existingMeta = draft._meta;
  const meta =
    existingMeta && typeof existingMeta === 'object'
      ? (existingMeta as Record<string, unknown>)
      : {};
  draft._meta = meta;

  let notes: string[];
  if (Array.isArray(meta.userNotes)) {
    notes = meta.userNotes as string[];
  } else {
    notes =
      meta.userNotes !== null && meta.userNotes !== undefined ? [String(meta.userNotes)] : [];
    meta.userNotes = notes;
  }
  notes.push(value);
}

export function applyResolutions(
  draft: Record<string, unknown>,
  resolutions: ReadonlyArray<N8nClarificationResolution>
): { ok: true } | { ok: false; error: string; paramPath?: string } {
  for (const r of resolutions) {
    if (!r || typeof r.paramPath !== 'string') {
      return { ok: false, error: 'resolution missing paramPath' };
    }
    if (typeof r.value !== 'string') {
      return {
        ok: false,
        error: 'resolution value must be a string',
        paramPath: r.paramPath,
      };
    }
    if (r.paramPath.length === 0) {
      // Free-form clarification with no field to wire into. Record the user's
      // answer under draft._meta.userNotes so subsequent LLM iterations can
      // consume the context, but don't mutate the workflow itself.
      appendUserNote(draft, r.value);
      continue;
    }
    try {
      setByDotPath(draft, r.paramPath, r.value);
    } catch (err) {
      // The LLM occasionally emits a paramPath that references a node it
      // didn't actually create (e.g. "Placeholder Notification") or points
      // at a parent scope rather than a leaf field. Failing the whole
      // resolution batch with a 400 is a dead-end — the user has no way to
      // recover without re-prompting from scratch. Instead, log a warn and
      // record the answer as a free-form note so the next regeneration
      // round can use it. The clarification still gets pruned by
      // `pruneResolvedClarifications` because we keep the original
      // paramPath in the resolutions list.
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          src: 'plugin:n8n-workflow:clarification:applyResolutions',
          err: errMsg,
          paramPath: r.paramPath,
        },
        `setByDotPath failed for paramPath "${r.paramPath}"; recording "${r.value}" as a free-form note instead: ${errMsg}`
      );
      appendUserNote(draft, r.value);
      continue;
    }
  }
  return { ok: true };
}

/**
 * Drop the resolved clarifications from the draft's `_meta` so the next
 * read of the draft does not re-prompt the user for the same parameter.
 *
 * Two pruning paths:
 *  1. Object-form clarifications with paramPath → prune by paramPath match.
 *  2. String-form clarifications (LLM emits free-form questions without a
 *     paramPath) and object-form clarifications with empty paramPath →
 *     prune positionally by `freeFormCount` (UI presents them in order, so
 *     each free-form resolution consumes the next one).
 *
 * Positional-pruning contract: free-form items are dropped from the head of
 * the stored list in order. The UI must therefore submit answers in the
 * order they were presented, with no skipped or out-of-order items in a
 * single batch — otherwise the wrong question gets pruned. If we ever need
 * to support partial/interleaved submissions, switch the resolution payload
 * to send the answered question text and match by value here instead.
 */
export function pruneResolvedClarifications(
  draft: Record<string, unknown>,
  resolved: ReadonlySet<string>,
  freeFormCount = 0
): void {
  const meta = (draft as { _meta?: Record<string, unknown> })._meta;
  if (!meta || typeof meta !== 'object') {
    return;
  }
  const list = meta.requiresClarification;
  if (!Array.isArray(list)) {
    return;
  }
  let toDropFreeForm = freeFormCount;
  const remaining = list.filter((item) => {
    if (typeof item === 'string') {
      if (toDropFreeForm > 0) {
        toDropFreeForm -= 1;
        return false;
      }
      return true;
    }
    if (item && typeof item === 'object') {
      const path = (item as { paramPath?: unknown }).paramPath;
      if (typeof path === 'string' && path.length > 0 && resolved.has(path)) {
        return false;
      }
      // Empty-paramPath object-form: also positional.
      if ((typeof path !== 'string' || path.length === 0) && toDropFreeForm > 0) {
        toDropFreeForm -= 1;
        return false;
      }
    }
    return true;
  });
  if (remaining.length === 0) {
    delete meta.requiresClarification;
  } else {
    meta.requiresClarification = remaining;
  }
}

/**
 * Subset of `ElizaConnectorTargetCatalog` used by the route. Declared here
 * (vs. imported from the service) so route tests can stub it without
 * spinning up the full service.
 */
export interface CatalogLike {
  listGroups(opts?: {
    platform?: string;
    groupId?: string;
  }): Promise<N8nClarificationTargetGroup[]>;
}

/**
 * Build a catalog snapshot for the platforms referenced by `clarifications`.
 * If multiple clarifications reference the same platform, we union their
 * groupId scopes — broader queries (no scope) always win.
 */
export async function buildCatalogSnapshot(
  catalog: CatalogLike,
  clarifications: ReadonlyArray<N8nClarificationRequest>
): Promise<N8nClarificationTargetGroup[]> {
  const platforms = new Set<string>();
  for (const c of clarifications) {
    if (c.platform) {
      platforms.add(c.platform);
    }
  }
  if (platforms.size === 0) {
    return [];
  }
  const out: N8nClarificationTargetGroup[] = [];
  const seen = new Set<string>();
  for (const platform of platforms) {
    const groups = await catalog.listGroups({ platform });
    for (const g of groups) {
      const key = `${g.platform}::${g.groupId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(g);
    }
  }
  return out;
}
