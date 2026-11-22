/**
 * The strict whole-message workflow commands chat owns: create one by name,
 * rename one, remove one, or list them. Stage 1 sometimes judged "create a
 * workflow called Alpha device test" as a clarification that still declared
 * pending work, twice, and the turn failed before any route ran (v610 Pixel,
 * STAGE1_ROUTING_CONFLICT). A match only routes the turn to the WORKFLOW
 * planner surface; it creates, renames or removes nothing itself.
 */
import {
  type IAgentRuntime,
  type Memory,
  namesViewNavigationTarget,
  registerDirectActionRoutingRule,
} from '@elizaos/core';

export type AuthoredWorkflowRequest =
  | { op: 'create'; name: string }
  | { op: 'rename'; workflowName: string; name: string }
  | { op: 'remove'; workflowName: string }
  | { op: 'list'; viewWording: boolean };

const COURTESY = String.raw`^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:please,?\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const END = String.raw`(?:,?\s+(?:please|for\s+me))?[.!?]*$`;
// A short name, optionally quoted. Clauses after it ("that runs every
// morning", "and turn it on") are more than a name and keep the planner path.
const NAME = String.raw`["“'‘]?([\p{L}\p{N}][\p{L}\p{N}'’&+#./-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’&+#./-]*){0,5}?)["”'’]?`;
// "delete the new workflow", "remove this workflow" and "the workflow I just
// created" describe a workflow instead of naming it. Read as a name, "new"
// matched "Morning news" and "this" matched nothing, and the owner's request
// could not complete, so these stay with the planner, which knows the context.
const DESCRIPTIVE_WORD =
  '(?:this|that|these|those|it|one|ones|the|my|last|latest|newest|new|old|oldest|older|newer|first|second|other|another|current|same|previous|recent|most|earlier|above|below|only|just|made|created|added)';
const DESCRIBES_NOT_NAMES = new RegExp(`^${DESCRIPTIVE_WORD}(?:\\s+${DESCRIPTIVE_WORD})*$`, 'iu');
// "the workflow I just created" and "the one you made" are clauses, but "IT
// backup", "I/O monitor" and "we-love-cats" are names, so a pronoun counts only
// before a clause word.
const PRONOUN_CLAUSE =
  /^(?:i|we|you|they|it)(?:['’](?:ve|d|ll|m|re|s))?\s+(?:just|recently|earlier|already|today|yesterday|made|make|created|create|added|add|set|setup|built|build|wrote|write|have|had|did|do|was|were|is|are|asked|told|mentioned|named|called|started|use|used|got|showed|saw)\b/iu;
const NOT_A_NAME =
  /\b(?:that|which|who|to|and|then|also|but|or|if|when|whenever|unless|every|each|daily|weekly|at|on|for|with|from|after|before|until|not|don['’]?t|never)\b/iu;

// "start workflow named Morning brief" asks to run one, so "start" creates
// only as "start a new workflow called ...".
const CREATE = new RegExp(
  `${COURTESY}(?:(?:create|make|add|set\\s+up|build)\\s+(?:(?:a|an|another|one)\\s+)?(?:new\\s+)?|start\\s+(?:(?:a|another)\\s+)?new\\s+)workflow\\s+(?:called|named|titled)\\s+${NAME}${END}`,
  'iu'
);
const RENAME = new RegExp(
  `${COURTESY}rename\\s+(?:(?:the|my)\\s+)?(?:workflow\\s+(?:called\\s+|named\\s+)?${NAME}|${NAME}\\s+workflow)\\s+to\\s+${NAME}${END}`,
  'iu'
);
const REMOVE = new RegExp(
  `${COURTESY}(?:delete|remove)\\s+(?:(?:the|my)\\s+)?(?:workflow\\s+(?:called\\s+|named\\s+)?${NAME}|${NAME}\\s+workflow)${END}`,
  'iu'
);
const LIST = new RegExp(
  `${COURTESY}(?:list|(show)(?:\\s+me)?|what\\s+are)\\s+(?:(?:all\\s+)?(?:of\\s+)?(?:my|the)\\s+)?workflows${END}`,
  'iu'
);
const WHAT_DO_I_HAVE = new RegExp(`${COURTESY}what\\s+workflows\\s+do\\s+i\\s+have${END}`, 'iu');

function name(value: string | undefined): string | undefined {
  // The sentence's own full stop is not part of the name ("v1.2" keeps its dot).
  const trimmed = value?.trim().replace(/[.]+$/u, '');
  if (!trimmed || trimmed.length > 80 || NOT_A_NAME.test(trimmed)) return undefined;
  // "the Alpha check workflow" and "workflow Alpha check" name the same one.
  if (/^(?:the|my|a|an)$/iu.test(trimmed) || /^workflows?$/iu.test(trimmed)) return undefined;
  if (DESCRIBES_NOT_NAMES.test(trimmed) || PRONOUN_CLAUSE.test(trimmed)) return undefined;
  return trimmed;
}

export function authoredWorkflowRequest(text: string): AuthoredWorkflowRequest | undefined {
  const request = text.trim();
  if (!request || request.length > 200) return undefined;
  const create = CREATE.exec(request);
  if (create) {
    const created = name(create[1]);
    return created ? { op: 'create', name: created } : undefined;
  }
  const rename = RENAME.exec(request);
  if (rename) {
    const current = name(rename[1] ?? rename[2]);
    const next = name(rename[3]);
    return current && next ? { op: 'rename', workflowName: current, name: next } : undefined;
  }
  const remove = REMOVE.exec(request);
  if (remove) {
    const removed = name(remove[1] ?? remove[2]);
    return removed ? { op: 'remove', workflowName: removed } : undefined;
  }
  const list = LIST.exec(request);
  if (list) return { op: 'list', viewWording: list[1] !== undefined };
  if (WHAT_DO_I_HAVE.test(request)) return { op: 'list', viewWording: false };
  return undefined;
}

/**
 * Whether WORKFLOW owns this whole message. "show my workflows" names the
 * Workflows view where a host registers one, so it stays view navigation
 * there; "list my workflows" is always the WORKFLOW list.
 */
export function workflowRequestOwned(
  runtime: IAgentRuntime,
  text: string,
  message?: Memory
): boolean {
  const request = authoredWorkflowRequest(text);
  if (!request) return false;
  if (request.op === 'list' && request.viewWording)
    return namesViewNavigationTarget(runtime, 'workflows', message) !== true;
  return true;
}

export function registerWorkflowRequestRouting(runtime: IAgentRuntime): void {
  const matches = (text: string, message?: Memory) => workflowRequestOwned(runtime, text, message);
  registerDirectActionRoutingRule(runtime, {
    id: 'workflow.authored-request',
    actionNames: ['WORKFLOW'],
    // Opening the Workflows view creates, renames or removes nothing.
    replacesActionNames: ['VIEWS', 'VIEWS_SHOW'],
    requiredActionTags: [],
    contexts: ['automation', 'general'],
    matches,
    wholeRequest: { matches, invalidateFields: ['visualContinuation'] },
  });
}
