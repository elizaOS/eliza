/**
 * Resolves the workflow a WORKFLOW chat call refers to, by id or by name. A miss
 * or an ambiguous name changes nothing, so both are retryable read failures.
 */
import type { ActionResult } from '@elizaos/core';
import type { WorkflowService } from '../services/workflow-service';
import { WorkflowApiError, type WorkflowDefinitionResponse } from '../types/index';

/** A refusal or miss that committed nothing. `userFacingText` is the owner's sentence. */
export function notApplied(
  code: string,
  text: string,
  userFacingText: string,
  retryable = true,
  data: Record<string, unknown> = {}
): ActionResult {
  return {
    success: false,
    text,
    userFacingText,
    error: code,
    data: { readOnlyOperation: true, ...data },
    effectReceipts: [],
    failureProvenance: { kind: 'handler_error', boundary: 'handler', code, retryable },
  };
}

export function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”"‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "the digest workflow" names "Digest": these filler words may be left out of a name. */
function withoutFiller(name: string): string {
  const bare = name
    .replace(/(?<![\p{L}\p{N}])(?:the|my|workflows?|automations?)(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return bare || name;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How a stored name answers the owner's reference. 0 = the name as given.
 * 1 = the same name once filler words are set aside on both sides. 2 = the
 * reference is whole words of the name ("daily report" in "Daily reports"). A
 * fragment inside a word is no match: "new" does not name "Morning news" and
 * "3" does not name "Q3 review". A name that is only part of the reference is
 * no match either: "the weekly digest" does not name a workflow called "Digest".
 */
function nameMatchTier(name: string, reference: string): 0 | 1 | 2 | undefined {
  const stored = normalizeName(name);
  const given = normalizeName(reference);
  if (!stored || !given) return undefined;
  if (stored === given) return 0;
  const query = withoutFiller(given);
  if (withoutFiller(stored) === query) return 1;
  // A plural is allowed only after a word of four or more letters ("report" ->
  // "reports"). A shorter stem is too often a different word: "new" is not "news".
  const plural = /\p{L}{4,}$/u.test(query) ? '(?:e?s)?' : '';
  const words = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(query)}${plural}(?![\\p{L}\\p{N}])`,
    'u'
  );
  return words.test(stored) ? 2 : undefined;
}

function quoted(workflows: WorkflowDefinitionResponse[], timeZone?: string): string {
  const seen = new Map<string, number>();
  for (const workflow of workflows) {
    const key = normalizeName(workflow.name);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // Same-named workflows are told apart by state and creation time, so the
  // question "which one?" has an answer the owner can give.
  return workflows
    .map((workflow) => {
      if ((seen.get(normalizeName(workflow.name)) ?? 0) < 2) return `“${workflow.name}”`;
      const created = Date.parse(workflow.createdAt);
      const when = Number.isFinite(created)
        ? new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            ...(timeZone ? { timeZone } : {}),
          }).format(created)
        : undefined;
      return `“${workflow.name}” (${workflow.active ? 'on' : 'off'}${when ? `, created ${when}` : ''})`;
    })
    .join(', ');
}
const identities = (workflows: WorkflowDefinitionResponse[]) =>
  workflows.map(({ id, name, active }) => ({ id, name, active: active === true }));

export interface WorkflowRefOptions {
  /** Look the name up among removed workflows, for a restore. */
  removed?: boolean;
  /**
   * Remove and rename act only on a name the owner gave in full. When the
   * reference is only words of one workflow's name, the owner is asked first.
   */
  strict?: boolean;
  /**
   * The name is the owner's own words (a whole-message command), so it is
   * looked up first; a planner id that is one of the same-named workflows, or
   * that agrees with the name, picks among them.
   */
  ownerWords?: boolean;
  /** The owner's zone, for telling same-named workflows apart. */
  timeZone?: string;
}

/**
 * An id is read directly and must agree with a name given beside it, so a
 * mis-paired id never changes another workflow.
 */
export async function resolveWorkflowRef(
  service: WorkflowService,
  ownerId: string,
  reference: { workflowId?: string; workflowName?: string },
  options: WorkflowRefOptions = {}
): Promise<WorkflowDefinitionResponse | ActionResult> {
  const { removed = false, strict = false, ownerWords = false, timeZone } = options;
  const { workflowId, workflowName } = reference;
  let loaded: WorkflowDefinitionResponse | undefined;
  if (workflowId) {
    try {
      loaded = await service.getWorkflow(workflowId, ownerId);
    } catch (error) {
      // An unknown id may be the planner passing a name; resolve it as one below.
      if (!(error instanceof WorkflowApiError) || error.statusCode !== 404) throw error;
    }
  }
  const mismatch = (found: WorkflowDefinitionResponse, given: string) =>
    notApplied(
      'WORKFLOW_REF_MISMATCH',
      `workflowId resolves to “${found.name}”, not “${given}”. Nothing was changed. Re-check the id or pass workflowName only.`,
      `I found “${found.name}”, not “${given}”. Which workflow do you mean?`
    );
  if (loaded && !workflowName) return loaded;
  if (loaded && workflowName && !ownerWords)
    return nameMatchTier(loaded.name, workflowName) === undefined
      ? mismatch(loaded, workflowName)
      : loaded;
  const all = await service.listWorkflows(ownerId, removed);
  const kind = removed ? 'removed workflow' : 'workflow';
  const source = workflowName ?? workflowId;
  if (!source)
    return notApplied(
      'WORKFLOW_MISSING_TARGET',
      all.length
        ? `workflowId or workflowName is required. Your ${kind}s: ${quoted(all, timeZone)}.`
        : `workflowId or workflowName is required. There are no ${kind}s.`,
      all.length
        ? `Which ${kind} do you mean? You have: ${quoted(all, timeZone)}.`
        : `You have no ${kind}s.`,
      true,
      { workflows: identities(all) }
    );
  // The first tier with a hit wins, so "Digest" is not ambiguous with "Digest notes",
  // and "Backup workflow" names that workflow, not one called "Backup".
  const tiers: WorkflowDefinitionResponse[][] = [[], [], []];
  for (const workflow of all) {
    const tier = nameMatchTier(workflow.name, source);
    if (tier !== undefined) tiers[tier].push(workflow);
  }
  const ambiguous = (matches: WorkflowDefinitionResponse[]) =>
    notApplied(
      'WORKFLOW_AMBIGUOUS',
      `Several ${kind}s match “${source}”: ${quoted(matches, timeZone)}. Nothing was changed. Ask which one, then pass its workflowId.`,
      `More than one ${kind} matches that: ${quoted(matches, timeZone)}. Which one?`,
      true,
      { matches: identities(matches) }
    );
  const full = tiers[0].length ? tiers[0] : tiers[1];
  if (full.length === 1) return full[0];
  if (full.length > 1) {
    // The planner's id settles which of the same-named workflows the owner means.
    const picked = loaded && full.find((workflow) => workflow.id === loaded.id);
    return picked ?? ambiguous(full);
  }
  if (loaded && workflowName) {
    // Only reached for the owner's own words that name no workflow in full.
    const tier = nameMatchTier(loaded.name, workflowName);
    if (tier === undefined) return mismatch(loaded, workflowName);
    if (!strict) return loaded;
  }
  const partial = tiers[2];
  if (partial.length === 1 && !strict) return partial[0];
  if (partial.length === 1)
    // Retrying in the same turn would act on a guess, so the owner answers first.
    return notApplied(
      'WORKFLOW_CONFIRM_TARGET',
      `No ${kind} is named “${source}”; it is only part of the name ${quoted(partial, timeZone)}. Nothing was changed. Ask the owner whether they mean that one before changing it; do not retry in this turn.`,
      `Do you mean ${quoted(partial, timeZone)}? I left it unchanged.`,
      false,
      { matches: identities(partial) }
    );
  if (partial.length > 1) return ambiguous(partial);
  return notApplied(
    'WORKFLOW_NOT_FOUND',
    all.length
      ? `No ${kind} matched “${source}”. Your ${kind}s: ${quoted(all, timeZone)}. Pass workflowId or a workflowName fragment.`
      : `No ${kind} matched “${source}”. There are no ${kind}s.`,
    all.length
      ? `I could not find a ${kind} matching “${source}”. You have: ${quoted(all, timeZone)}.`
      : `You have no ${kind}s.`,
    true,
    { workflows: identities(all) }
  );
}
