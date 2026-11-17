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

function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”"‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "the digest workflow" names "Morning digest": filler words are not part of a name. */
function nameQuery(value: string): string {
  const name = normalizeName(value);
  const bare = name
    .replace(/(?<![\p{L}\p{N}])(?:the|my|workflows?|automations?)(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return bare || name;
}

function containsWholePhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
}

/** 0 = exact name, 1 = whole word or phrase either way, 2 = substring, undefined = no match. */
function nameMatchTier(name: string, query: string): 0 | 1 | 2 | undefined {
  if (!name || !query) return undefined;
  if (name === query) return 0;
  if (containsWholePhrase(name, query) || containsWholePhrase(query, name)) return 1;
  return name.includes(query) ? 2 : undefined;
}

const quoted = (workflows: WorkflowDefinitionResponse[]) =>
  workflows.map((workflow) => `“${workflow.name}”`).join(', ');
const identities = (workflows: WorkflowDefinitionResponse[]) =>
  workflows.map(({ id, name, active }) => ({ id, name, active: active === true }));

/**
 * `removed` selects which set a name is looked up in: current workflows, or
 * removed ones for a restore. An id is read directly and must agree with a
 * name given beside it, so a mis-paired id never changes another workflow.
 */
export async function resolveWorkflowRef(
  service: WorkflowService,
  ownerId: string,
  reference: { workflowId?: string; workflowName?: string },
  removed = false
): Promise<WorkflowDefinitionResponse | ActionResult> {
  const { workflowId, workflowName } = reference;
  if (workflowId) {
    let loaded: WorkflowDefinitionResponse | undefined;
    try {
      loaded = await service.getWorkflow(workflowId, ownerId);
    } catch (error) {
      // An unknown id may be the planner passing a name; resolve it as one below.
      if (!(error instanceof WorkflowApiError) || error.statusCode !== 404) throw error;
    }
    if (loaded) {
      if (
        workflowName &&
        nameMatchTier(normalizeName(loaded.name), nameQuery(workflowName)) === undefined
      )
        return notApplied(
          'WORKFLOW_REF_MISMATCH',
          `workflowId resolves to “${loaded.name}”, not “${workflowName}”. Nothing was changed. Re-check the id or pass workflowName only.`,
          `I found “${loaded.name}”, not “${workflowName}”. Which workflow do you mean?`
        );
      return loaded;
    }
  }
  const all = await service.listWorkflows(ownerId, removed);
  const kind = removed ? 'removed workflow' : 'workflow';
  const source = workflowName ?? workflowId;
  if (!source)
    return notApplied(
      'WORKFLOW_MISSING_TARGET',
      all.length
        ? `workflowId or workflowName is required. Your ${kind}s: ${quoted(all)}.`
        : `workflowId or workflowName is required. There are no ${kind}s.`,
      all.length ? `Which ${kind} do you mean? You have: ${quoted(all)}.` : `You have no ${kind}s.`,
      true,
      { workflows: identities(all) }
    );
  const query = nameQuery(source);
  // The first tier with a hit wins, so "Digest" is not ambiguous with "Digest notes".
  const tiers: WorkflowDefinitionResponse[][] = [[], [], []];
  for (const workflow of all) {
    const tier = nameMatchTier(normalizeName(workflow.name), query);
    if (tier !== undefined) tiers[tier].push(workflow);
  }
  const matches = tiers.find((tier) => tier.length > 0) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    return notApplied(
      'WORKFLOW_AMBIGUOUS',
      `Several ${kind}s match “${source}”: ${quoted(matches)}. Nothing was changed. Ask which one, then pass its workflowId.`,
      `More than one ${kind} matches that: ${quoted(matches)}. Which one?`,
      true,
      { matches: identities(matches) }
    );
  return notApplied(
    'WORKFLOW_NOT_FOUND',
    all.length
      ? `No ${kind} matched “${source}”. Your ${kind}s: ${quoted(all)}. Pass workflowId or a workflowName fragment.`
      : `No ${kind} matched “${source}”. There are no ${kind}s.`,
    all.length
      ? `I could not find a ${kind} matching “${source}”. You have: ${quoted(all)}.`
      : `You have no ${kind}s.`,
    true,
    { workflows: identities(all) }
  );
}
