/**
 * Clarification helpers for workflow generation routes.
 *
 * - `coerceClarifications`: normalizes the plugin's mixed-shape
 *   `_meta.requiresClarification` (legacy strings + structured objects)
 *   into typed `WorkflowClarificationRequest[]`.
 * - `setByDotPath`: applies `{paramPath, value}` resolutions to a draft
 *   workflow JSON in place. Supports dot segments and bracketed-string
 *   segments (`nodes["Discord Send"].parameters.channelId`).
 *
 * Kept out of `workflows-routes.ts` so the handlers stay focused on transport.
 */

import { logger } from '@elizaos/core';

export interface WorkflowClarificationRequest {
  kind: 'target_channel' | 'target_server' | 'recipient' | 'value' | 'free_text';
  platform?: string;
  scope?: { guildId?: string };
  question: string;
  paramPath: string;
}

export interface WorkflowClarificationResolution {
  paramPath: string;
  value: string;
}

export interface WorkflowClarificationTargetGroup {
  platform: string;
  groupId: string;
  groupName: string;
  targets: Array<{
    id: string;
    name: string;
    kind: 'channel' | 'recipient' | 'chat';
  }>;
}

type RawStructuredClarification = Partial<WorkflowClarificationRequest> & {
  question: string;
};

const VALID_KINDS: ReadonlySet<WorkflowClarificationRequest['kind']> = new Set([
  'target_channel',
  'target_server',
  'recipient',
  'value',
  'free_text',
]);

/**
 * Stable sort priority for clarification kinds. Lower number = asked first.
 *
 * `target_server` MUST come before `target_channel` because the channel
 * picker reads `scope.guildId` from the server pick to narrow its options.
 * If the LLM emits them in reverse order (which it sometimes does), the
 * user picks a channel first against an unscoped catalog, which is bad UX
 * (every channel from every guild they belong to) and can land the wrong
 * id when channel names collide across guilds.
 *
 * `recipient` shares the server-scoped concern — DMs/contacts belong to a
 * platform context — so it sorts after `target_server` too. `value` and
 * `free_text` don't depend on prior picks; relative order is preserved
 * because Array.prototype.sort is stable as of ES2019.
 */
const KIND_SORT_PRIORITY: Readonly<Record<WorkflowClarificationRequest['kind'], number>> = {
  target_server: 0,
  target_channel: 1,
  recipient: 1,
  value: 2,
  free_text: 3,
};

function isStructuredClarification(v: unknown): v is RawStructuredClarification {
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

export function coerceClarifications(raw: unknown): WorkflowClarificationRequest[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const out: WorkflowClarificationRequest[] = [];
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
    const kindRaw = typeof item.kind === 'string' ? item.kind : 'free_text';
    const kind = (
      VALID_KINDS.has(kindRaw as WorkflowClarificationRequest['kind']) ? kindRaw : 'free_text'
    ) as WorkflowClarificationRequest['kind'];
    const platform = typeof item.platform === 'string' ? item.platform : undefined;
    let scope: { guildId?: string } | undefined;
    if (item.scope && typeof item.scope === 'object' && typeof item.scope.guildId === 'string') {
      scope = {
        guildId: item.scope.guildId,
      };
    }
    const paramPath = typeof item.paramPath === 'string' ? item.paramPath : '';
    out.push({
      kind,
      platform,
      scope,
      question: item.question.trim(),
      paramPath,
    });
  }
  // Stable-sort so dependency-bearing kinds come first. Within the same
  // priority bucket the LLM's emission order is preserved.
  out.sort((a, b) => KIND_SORT_PRIORITY[a.kind] - KIND_SORT_PRIORITY[b.kind]);
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
 * addresses workflow nodes by their human name even though `workflow.nodes`
 * is an array, so we map name → index here rather than rejecting the path.
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
 *     field. Common in LLM output: the model writes `nodes["Post to Slack"]`
 *     rather than `nodes[2]`. Treating that as a hard failure forced every
 *     clarification resolution through a 400.
 *
 * If the segment expects an array but the existing intermediate is a non-
 * array object, we treat it as an object key (workflow shapes mix arrays and
 * objects fairly freely; we err on the side of preserving structure).
 *
 * Terminal-segment guard: refuses to overwrite an existing object with a
 * non-object value. The LLM sometimes emits a paramPath that points at a
 * parent scope rather than a leaf (e.g.
 * `nodes["Hourly Trigger"].parameters` for a question whose answer is a
 * channel name); naively writing the string there replaces the entire
 * `parameters` object and the workflow runner then rejects the workflow with
 * `parameters must be object`. Throwing here gives `applyResolutions` a
 * chance to fall back to the userNotes path.
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
  const isNonNullObject = (v: unknown): boolean => v !== null && typeof v === 'object';
  if (Array.isArray(cur)) {
    let idx: number;
    if (/^[0-9]+$/.test(last)) {
      idx = Number(last);
    } else {
      idx = findArrayIndexByNameOrId(cur, last);
      if (idx < 0) {
        throw new Error(
          `paramPath terminal segment "${last}" did not match any element by name/id at array`
        );
      }
    }
    if (isNonNullObject(cur[idx]) && !isNonNullObject(value)) {
      throw new Error(
        `paramPath terminal "${last}" currently holds an object; refusing to overwrite with non-object value (path likely points at a parent scope rather than a leaf field)`
      );
    }
    cur[idx] = value;
  } else {
    const existing = (cur as Record<string, unknown>)[last];
    if (isNonNullObject(existing) && !isNonNullObject(value)) {
      throw new Error(
        `paramPath terminal "${last}" currently holds an object; refusing to overwrite with non-object value (path likely points at a parent scope rather than a leaf field)`
      );
    }
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
  resolutions: ReadonlyArray<WorkflowClarificationResolution>
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
    // Surface structural parse errors (unterminated bracket, empty
    // identifier, etc.) up to the caller as a 400 — these signal a
    // malformed LLM emission and cannot be silently recovered into
    // userNotes without losing the failure mode in the metrics pipeline.
    try {
      parseParamPath(r.paramPath);
    } catch (err) {
      return {
        ok: false,
        error: `paramPath is structurally invalid: ${
          err instanceof Error ? err.message : String(err)
        }`,
        paramPath: r.paramPath,
      };
    }
    try {
      setByDotPath(draft, r.paramPath, r.value);
    } catch (err) {
      // Lookup-time failure: the path parsed cleanly but didn't resolve
      // against the current draft (e.g. references a node the LLM didn't
      // actually create, or points at a parent scope rather than a leaf
      // field). Failing the whole resolution batch with a 400 is a
      // dead-end — the user has no way to recover without re-prompting
      // from scratch. Log a warn and record the answer as a free-form
      // note so the next regeneration round can use it.
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          src: 'plugin:workflow:clarification:applyResolutions',
          err: errMsg,
          paramPath: r.paramPath,
        },
        `setByDotPath failed for paramPath "${r.paramPath}"; recording "${r.value}" as a free-form note instead`
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
  }): Promise<WorkflowClarificationTargetGroup[]>;
}

/**
 * Build a catalog snapshot for the platforms referenced by `clarifications`.
 * If multiple clarifications reference the same platform, we union their
 * groupId scopes — broader queries (no scope) always win.
 */
export async function buildCatalogSnapshot(
  catalog: CatalogLike,
  clarifications: ReadonlyArray<WorkflowClarificationRequest>
): Promise<WorkflowClarificationTargetGroup[]> {
  const platforms = new Set<string>();
  for (const c of clarifications) {
    if (c.platform) {
      platforms.add(c.platform);
    }
  }
  if (platforms.size === 0) {
    return [];
  }
  const out: WorkflowClarificationTargetGroup[] = [];
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
