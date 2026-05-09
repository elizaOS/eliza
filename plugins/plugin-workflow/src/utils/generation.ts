import type { GenerateTextParams } from '@elizaos/core';
import { type IAgentRuntime, logger, ModelType } from '@elizaos/core';
import {
  draftIntentSchema,
  feasibilitySchema,
  keywordExtractionSchema,
  workflowMatchingSchema,
} from '../schemas/index';
import type {
  DraftIntentResult,
  FeasibilityResult,
  KeywordExtractionResult,
  NodeDefinition,
  NodeSearchResult,
  OutputRefValidation,
  RuntimeContext,
  WorkflowDefinition,
  WorkflowDraft,
  WorkflowMatchResult,
} from '../types/index';
import { getNodeDefinition, simplifyNodeForLLM } from './catalog';
import {
  formatSchemaForPrompt,
  getAvailableOperations,
  getAvailableResources,
  hasOutputSchema,
  loadOutputSchema,
} from './outputSchema';
import type { UnknownParamDetection } from './workflow';
import {
  ACTION_RESPONSE_SYSTEM_PROMPT,
  DRAFT_INTENT_SYSTEM_PROMPT,
  FEASIBILITY_CHECK_PROMPT,
  FIELD_CORRECTION_SYSTEM_PROMPT,
  FIELD_CORRECTION_USER_PROMPT,
  KEYWORD_EXTRACTION_SYSTEM_PROMPT,
  PARAM_CORRECTION_SYSTEM_PROMPT,
  PARAM_CORRECTION_USER_PROMPT,
  WORKFLOW_GENERATION_SYSTEM_PROMPT,
} from './workflow-prompts/index';
import { WORKFLOW_MATCHING_SYSTEM_PROMPT } from './workflow-prompts/workflowMatching';

type StructuredModelRunner = {
  useModel<T>(
    modelType: typeof ModelType.TEXT_SMALL,
    params: GenerateTextParams & { responseSchema: unknown },
    provider?: string
  ): Promise<T>;
};

async function useStructuredModel<T>(
  runtime: IAgentRuntime,
  prompt: string,
  schema: unknown
): Promise<T> {
  const structuredRuntime = runtime as IAgentRuntime & StructuredModelRunner;
  return (await structuredRuntime.useModel<T>(ModelType.TEXT_SMALL, {
    prompt,
    responseSchema: schema as never,
  })) as T;
}

/**
 * Build an optional bias directive that nudges keyword extraction toward
 * providers the host has already declared it can satisfy. The directive is
 * appended to KEYWORD_EXTRACTION_SYSTEM_PROMPT only when a non-empty
 * `preferredProviders` list is supplied — keeps existing baseline behavior
 * for non-host installs.
 */
function buildPreferredProvidersDirective(preferredProviders?: string[]): string {
  if (!preferredProviders || preferredProviders.length === 0) {
    return '';
  }
  const list = preferredProviders.map((p) => p.toLowerCase()).join(', ');
  return `\n\nHost-supported providers: ${list}. When the user names a generic concept that maps to one of these (e.g. "my email" with gmail in the list, "my chat" with discord in the list), emit the specific provider keyword (gmail, discord) — NOT a generic fallback (imap, webhook, email). Prefer these provider names over alternative integrations.`;
}

export async function extractKeywords(
  runtime: IAgentRuntime,
  userPrompt: string,
  preferredProviders?: string[]
): Promise<string[]> {
  let result: KeywordExtractionResult;
  try {
    result = await useStructuredModel<KeywordExtractionResult>(
      runtime,
      `${KEYWORD_EXTRACTION_SYSTEM_PROMPT}${buildPreferredProvidersDirective(preferredProviders)}\n\nUser request: ${userPrompt}`,
      keywordExtractionSchema
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: 'plugin:workflow:generation:keywords', error: errMsg },
      `Keyword extraction LLM call failed: ${errMsg}`
    );
    throw new Error(`Keyword extraction failed: ${errMsg}`, { cause: error });
  }

  // Validate structure
  if (!result?.keywords || !Array.isArray(result.keywords)) {
    logger.error(
      {
        src: 'plugin:workflow:generation:keywords',
        result: JSON.stringify(result),
      },
      'Invalid keyword extraction response structure'
    );
    throw new Error('Invalid keyword extraction response: missing or invalid keywords array');
  }

  // Validate all items are strings
  if (!result.keywords.every((kw) => typeof kw === 'string')) {
    throw new Error('Keywords array contains non-string elements');
  }

  // Limit to 5 keywords max, filter empty strings
  return result.keywords
    .slice(0, 5)
    .map((kw) => kw.trim())
    .filter((kw) => kw.length > 0);
}

export async function matchWorkflow(
  runtime: IAgentRuntime,
  userRequest: string,
  workflows: WorkflowDefinition[]
): Promise<WorkflowMatchResult> {
  if (workflows.length === 0) {
    return {
      matchedWorkflowId: null,
      confidence: 'none',
      matches: [],
      reason: 'No workflows available',
    };
  }

  try {
    // Build workflow list for LLM
    const workflowList = workflows
      .map(
        (wf, index) =>
          `${index + 1}. "${wf.name}" (ID: ${wf.id}, Status: ${wf.active ? 'ACTIVE' : 'INACTIVE'})`
      )
      .join('\n');

    const userPrompt = `${userRequest}

Available workflows:
${workflowList}`;

    let result: WorkflowMatchResult;
    try {
      result = await useStructuredModel<WorkflowMatchResult>(
        runtime,
        `${WORKFLOW_MATCHING_SYSTEM_PROMPT}\n\n${userPrompt}`,
        workflowMatchingSchema
      );
    } catch (innerError) {
      const errMsg = innerError instanceof Error ? innerError.message : String(innerError);
      logger.error(
        { src: 'plugin:workflow:generation:matcher', error: errMsg },
        `Workflow matching LLM call failed: ${errMsg}`
      );
      throw innerError;
    }

    // Validate the returned ID actually exists in the provided list
    if (result.matchedWorkflowId && !workflows.some((wf) => wf.id === result.matchedWorkflowId)) {
      logger.warn(
        { src: 'plugin:workflow:generation:matcher' },
        `LLM returned non-existent workflow ID "${result.matchedWorkflowId}" — discarding`
      );
      result.matchedWorkflowId = null;
      result.confidence = 'none';
    }

    logger.debug(
      { src: 'plugin:workflow:generation:matcher' },
      `Workflow match: ${result.matchedWorkflowId || 'none'} (confidence: ${result.confidence})`
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: 'plugin:workflow:generation:matcher' },
      `Workflow matching failed: ${errorMessage}`
    );

    return {
      matchedWorkflowId: null,
      confidence: 'none',
      matches: [],
      reason: `Workflow matching service unavailable: ${errorMessage}`,
    };
  }
}

export async function classifyDraftIntent(
  runtime: IAgentRuntime,
  userMessage: string,
  draft: WorkflowDraft
): Promise<DraftIntentResult> {
  const draftSummary = `Workflow: "${draft.workflow.name}"
Nodes: ${draft.workflow.nodes.map((n) => `${n.name} (${n.type})`).join(', ')}
Original prompt: "${draft.prompt}"`;

  let result: DraftIntentResult;
  try {
    result = await useStructuredModel<DraftIntentResult>(
      runtime,
      `${DRAFT_INTENT_SYSTEM_PROMPT}

## Current Draft

${draftSummary}

## User Message

${userMessage}`,
      draftIntentSchema
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: 'plugin:workflow:generation:intent', error: errMsg },
      `classifyDraftIntent LLM call failed: ${errMsg}`
    );
    return {
      intent: 'show_preview',
      reason: `Intent classification failed (${errMsg}) — re-showing preview`,
    };
  }

  const validIntents = ['confirm', 'cancel', 'modify', 'new'] as const;
  if (!result?.intent || !validIntents.includes(result.intent as (typeof validIntents)[number])) {
    logger.warn(
      { src: 'plugin:workflow:generation:intent' },
      `Invalid intent from LLM: ${JSON.stringify(result)}, re-showing preview`
    );
    return {
      intent: 'show_preview',
      reason: 'Could not classify intent — re-showing preview',
    };
  }

  return result;
}

/**
 * Layer 3 retry helper (Session 21). When `validateAndRepair` flags errors
 * it can't auto-fix deterministically (e.g. truly unknown output field),
 * send a surgical fix prompt to the LLM listing only the failing items
 * and re-validate. The caller wraps this in a 3-attempt loop.
 *
 * Lives next to `correctFieldReferences` and `correctParameterNames` —
 * those are still the preferred specific-class corrections. This is the
 * generic backstop for any remaining error class.
 */
export async function fixWorkflowErrors(
  runtime: IAgentRuntime,
  workflow: WorkflowDefinition,
  errors: Array<{
    kind: string;
    node: string;
    detail: string;
    expression?: string;
    availableFields?: string[];
  }>,
  relevantNodes: NodeDefinition[]
): Promise<WorkflowDefinition> {
  if (errors.length === 0) {
    return workflow;
  }
  const errorBlock = errors
    .map((e, i) => {
      const av = e.availableFields?.length
        ? ` Available fields on the upstream node: ${e.availableFields.join(', ')}.`
        : '';
      const expr = e.expression ? ` Expression: \`${e.expression}\`.` : '';
      return `${i + 1}. Node "${e.node}" — ${e.detail}.${expr}${av}`;
    })
    .join('\n');

  const simplifiedNodes = relevantNodes.map(simplifyNodeForLLM);
  const fixPrompt = `You are fixing a deterministic-validator-flagged workflow. Apply ONLY the listed fixes — do not refactor anything else.

## Errors to fix

${errorBlock}

## Available node definitions (for reference)

${JSON.stringify(simplifiedNodes, null, 2)}

## Current workflow JSON

${JSON.stringify(workflow, null, 2)}

Return the COMPLETE corrected workflow JSON. Preserve every field that was not part of the error list. Only change what is required to fix the listed items.`;

  let response: string;
  try {
    response = (await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: fixPrompt,
      temperature: 0,
      responseFormat: { type: 'json_object' },
    })) as string;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { src: 'plugin:workflow:generation:fixErrors', err: errMsg },
      `fixWorkflowErrors LLM call failed: ${errMsg}`
    );
    throw err;
  }

  try {
    return parseWorkflowResponse(response);
  } catch (_err) {
    logger.error(
      { src: 'plugin:workflow:generation:fixErrors' },
      'fixWorkflowErrors response could not be parsed; keeping original workflow'
    );
    return workflow;
  }
}

/**
 * Walk a string starting at every `{` opener, extract the first slice that
 * yields a valid JSON object, and return that parsed value. Tolerates leading
 * and trailing prose around the workflow JSON (which the LLM occasionally
 * emits in spite of `responseFormat: { type: 'json_object' }`).
 *
 * Returns the parsed value rather than the source string so callers don't pay
 * for a second `JSON.parse` on the same bytes.
 *
 * Caveat: returns the *first* slice that round-trips through `JSON.parse`. If
 * the LLM ever prefixes the workflow with a small standalone JSON fragment
 * (e.g. `{"ok":true}\n{…full workflow…}`), the small fragment wins and the
 * downstream `nodes`/`connections` validation throws "missing nodes array".
 * That's an obvious failure mode rather than a silent corruption, so we don't
 * try to second-guess which candidate is the workflow here.
 */
function extractFirstBalancedJsonObject(text: string): unknown | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function parseWorkflowResponse(response: string): WorkflowDefinition {
  // Strip markdown code fences (handles ```json, ```, with any whitespace/newlines)
  const cleaned = response
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/i, '') // Remove everything up to and including opening fence
    .replace(/\n?```[\s\S]*$/i, '') // Remove closing fence and everything after
    .trim();

  let workflow: WorkflowDefinition;
  try {
    workflow = JSON.parse(cleaned) as WorkflowDefinition;
  } catch (initialError) {
    // Fence-strip + JSON.parse failed. The LLM may have wrapped the JSON in
    // prose despite responseFormat: { type: 'json_object' }. Walk the cleaned
    // text and extract the first balanced JSON object that parses.
    const extracted = extractFirstBalancedJsonObject(cleaned);
    if (extracted === null) {
      throw new Error(
        `Failed to parse workflow JSON: ${initialError instanceof Error ? initialError.message : String(initialError)}\n\nRaw response: ${response}`,
        { cause: initialError }
      );
    }
    workflow = extracted as WorkflowDefinition;
  }

  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    throw new Error('Invalid workflow: missing or invalid nodes array');
  }

  if (!workflow.connections || typeof workflow.connections !== 'object') {
    throw new Error('Invalid workflow: missing or invalid connections object');
  }

  return workflow;
}

/**
 * Build output schema context for relevant nodes so the LLM knows the exact
 * output fields when writing expressions like {{ $json.field }}.
 */
function buildOutputSchemaContext(nodes: NodeDefinition[]): string {
  const sections: string[] = [];

  for (const node of nodes) {
    if (!hasOutputSchema(node.name)) {
      continue;
    }

    const resources = getAvailableResources(node.name);
    for (const resource of resources) {
      const operations = getAvailableOperations(node.name, resource);
      for (const operation of operations) {
        const result = loadOutputSchema(node.name, resource, operation);
        if (!result) {
          continue;
        }
        const formatted = formatSchemaForPrompt(result.schema);
        sections.push(
          `### ${node.name} (resource: "${resource}", operation: "${operation}")\n${formatted}`
        );
      }
    }
  }

  if (sections.length === 0) {
    return '';
  }

  return `\n## Node Output Schemas\n\nWhen referencing output data from a previous node using expressions like \`{{ $json.field }}\`, use ONLY the field paths listed below. Do NOT invent field names from your training data.\n\n${sections.join('\n\n')}`;
}

/**
 * Render the optional host-supplied runtime context as two prompt sections:
 * `## Available Credentials` (which credential types the host can resolve) and
 * `## Runtime Facts` (real values like Discord guild/channel IDs, the user's
 * email). Returns the empty string when the host did not register a provider
 * — preserving exact baseline behavior for non-host installs.
 */
function buildRuntimeContextSections(ctx?: RuntimeContext): string {
  if (!ctx) {
    return '';
  }
  const lines: string[] = [];
  if (ctx.supportedCredentials?.length) {
    lines.push('## Available Credentials');
    lines.push(
      'These credential types are pre-resolved by the host. Attach the credentials block to every relevant node — the host injects the real id post-generation.'
    );
    for (const c of ctx.supportedCredentials) {
      lines.push(
        `- ${c.credType}: name "${c.friendlyName}" — applies to: ${c.nodeTypes.join(', ')}`
      );
    }
    lines.push('');
  }
  if (ctx.facts?.length) {
    lines.push('## Runtime Facts');
    lines.push('Use these real values verbatim instead of placeholders.');
    for (const fact of ctx.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

/**
 * Run a TEXT_LARGE generation and parse the result as a workflow.
 * If the first response fails parseWorkflowResponse — which happens when the
 * LLM occasionally drops required fields despite responseFormat: json_object —
 * retry once with an explicit corrective nudge before letting the parse error
 * escape. Generation calls are 30-90s of sequential LLM work upstream of this
 * point, so failing closed on a single non-deterministic LLM roll is poor UX.
 */
async function callLlmAndParseWorkflow(
  runtime: IAgentRuntime,
  prompt: string,
  context: 'generateWorkflow' | 'modifyWorkflow'
): Promise<WorkflowDefinition> {
  const callOnce = async (extraInstruction?: string): Promise<string> =>
    (await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: extraInstruction ? `${prompt}\n\n${extraInstruction}` : prompt,
      temperature: 0,
      responseFormat: { type: 'json_object' },
    })) as string;

  const firstResponse = await callOnce();
  try {
    return parseWorkflowResponse(firstResponse);
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    logger.warn(
      { src: `plugin:workflow:generation:${context}`, err: firstMsg },
      'parseWorkflowResponse failed on first attempt; retrying once'
    );
    const retryResponse = await callOnce(
      'Your previous response was malformed and could not be parsed as a workflow. Return ONLY a single valid JSON object containing the required fields "nodes" (array) and "connections" (object) — no prose, no markdown fences, no explanations.'
    );
    return parseWorkflowResponse(retryResponse);
  }
}

export async function generateWorkflow(
  runtime: IAgentRuntime,
  userPrompt: string,
  relevantNodes: NodeDefinition[],
  runtimeContext?: RuntimeContext
): Promise<WorkflowDefinition> {
  const simplifiedNodes = relevantNodes.map(simplifyNodeForLLM);
  const outputSchemaCtx = buildOutputSchemaContext(relevantNodes);
  const runtimeCtxSections = buildRuntimeContextSections(runtimeContext);

  const fullPrompt = `${WORKFLOW_GENERATION_SYSTEM_PROMPT}

## Relevant Nodes Available

${JSON.stringify(simplifiedNodes, null, 2)}

Use these node definitions to generate the workflow. Each node's "properties" field defines the available parameters.
${outputSchemaCtx}${runtimeCtxSections}

## User Request

${userPrompt}

Generate a valid workflow JSON that fulfills this request.`;

  const workflow = await callLlmAndParseWorkflow(runtime, fullPrompt, 'generateWorkflow');

  if (!workflow.name) {
    workflow.name = `Workflow - ${userPrompt.slice(0, 50).trim()}`;
  }

  return workflow;
}

export async function modifyWorkflow(
  runtime: IAgentRuntime,
  existingWorkflow: WorkflowDefinition,
  modificationRequest: string,
  relevantNodes: NodeDefinition[],
  runtimeContext?: RuntimeContext
): Promise<WorkflowDefinition> {
  const { _meta, ...workflowForLLM } = existingWorkflow;

  const simplifiedNodes = relevantNodes.map(simplifyNodeForLLM);
  const outputSchemaCtx = buildOutputSchemaContext(relevantNodes);
  const runtimeCtxSections = buildRuntimeContextSections(runtimeContext);

  const fullPrompt = `${WORKFLOW_GENERATION_SYSTEM_PROMPT}

## Relevant Nodes Available

${JSON.stringify(simplifiedNodes, null, 2)}

Use these node definitions to modify the workflow. Each node's "properties" field defines the available parameters.
${outputSchemaCtx}${runtimeCtxSections}

## Existing Workflow (modify this)

${JSON.stringify(workflowForLLM, null, 2)}

## Modification Request

${modificationRequest}

Modify the existing workflow according to the request above. Return the COMPLETE modified workflow JSON.
Keep all unchanged nodes and connections intact. Only add, remove, or change what the user asked for.`;

  const modified = await callLlmAndParseWorkflow(runtime, fullPrompt, 'modifyWorkflow');

  // Preserve the original workflow ID for updates (LLM doesn't return it)
  if (existingWorkflow.id) {
    modified.id = existingWorkflow.id;
  }

  return modified;
}

export function collectExistingNodeDefinitions(workflow: WorkflowDefinition): NodeDefinition[] {
  const defs: NodeDefinition[] = [];
  const seen = new Set<string>();

  for (const node of workflow.nodes) {
    if (seen.has(node.type)) {
      continue;
    }
    seen.add(node.type);

    const def = getNodeDefinition(node.type);
    if (def) {
      defs.push(def);
    } else {
      logger.warn(
        { src: 'plugin:workflow:generation:modify' },
        `No catalog definition found for node type "${node.type}" — LLM will have limited context for this node`
      );
    }
  }

  return defs;
}

export async function formatActionResponse(
  runtime: IAgentRuntime,
  responseType: string,
  data: Record<string, unknown>
): Promise<string> {
  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `${ACTION_RESPONSE_SYSTEM_PROMPT}\n\nType: ${responseType}\n\nData:\n${formatActionDataForPrompt(data)}`,
    });

    return (response as string).trim();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        src: 'plugin:workflow:generation:format',
        error: errMsg,
        responseType,
      },
      `formatActionResponse LLM call failed: ${errMsg}`
    );
    // Return a fallback message so the action can still communicate with the user
    if (responseType === 'ERROR') {
      return `An error occurred: ${data.error || 'Unknown error'}`;
    }
    return `Operation completed (type: ${responseType})`;
  }
}

function formatActionDataForPrompt(value: unknown, indent = 0): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const formatted = formatActionDataForPrompt(item, indent + 2);
        return `${pad}- ${formatted.replace(/\n/g, `\n${pad}  `)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const formatted = formatActionDataForPrompt(entry, indent + 2);
        return formatted.includes('\n')
          ? `${pad}${key}:\n${formatted}`
          : `${pad}${key}: ${formatted}`;
      })
      .join('\n');
  }
  return String(value);
}

export async function assessFeasibility(
  runtime: IAgentRuntime,
  userPrompt: string,
  removedNodes: NodeSearchResult[],
  remainingNodes: NodeSearchResult[]
): Promise<FeasibilityResult> {
  const removedList = removedNodes
    .filter((r) => r.node.credentials?.length)
    .map((r) => r.node.displayName)
    .join(', ');

  const availableList = remainingNodes
    .filter((r) => r.node.credentials?.length)
    .map((r) => r.node.displayName)
    .join(', ');

  const utilityList = remainingNodes
    .filter((r) => !r.node.credentials?.length)
    .map((r) => r.node.displayName)
    .join(', ');

  try {
    const result = await useStructuredModel<FeasibilityResult>(
      runtime,
      `${FEASIBILITY_CHECK_PROMPT}\n\n## User Request\n${userPrompt}` +
        `\n\n## Removed Integrations (unavailable)\n${removedList}` +
        `\n\n## Available Service Integrations\n${availableList}` +
        `\n\n## Available Utility Nodes\n${utilityList}`,
      feasibilitySchema
    );

    return result;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: 'plugin:workflow:generation:feasibility', error: errMsg },
      `Feasibility assessment LLM call failed: ${errMsg}`
    );
    return {
      feasible: false,
      reason: `Feasibility check failed: ${errMsg}`,
    };
  }
}

/**
 * Auto-corrects invalid field references in expressions using parallel LLM calls.
 * Returns a new workflow with corrected expressions.
 */
export async function correctFieldReferences(
  runtime: IAgentRuntime,
  workflow: WorkflowDefinition,
  invalidRefs: OutputRefValidation[]
): Promise<WorkflowDefinition> {
  if (invalidRefs.length === 0) {
    return workflow;
  }

  logger.debug(
    { src: 'plugin:workflow:generation:correction' },
    `Correcting ${invalidRefs.length} invalid field reference(s)`
  );

  const corrections = await Promise.all(
    invalidRefs.map(async (ref) => {
      try {
        const userPrompt = FIELD_CORRECTION_USER_PROMPT.replace(
          '{expression}',
          ref.expression
        ).replace('{availableFields}', ref.availableFields.join('\n'));

        const corrected = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: `${FIELD_CORRECTION_SYSTEM_PROMPT}\n\n${userPrompt}`,
          temperature: 0,
        });

        const cleaned = (corrected as string).trim();
        return {
          original: ref.expression,
          corrected: cleaned,
          nodeName: ref.nodeName,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn(
          { src: 'plugin:workflow:generation:correction', error: errMsg },
          `Failed to correct expression "${ref.expression}": ${errMsg}`
        );
        return null;
      }
    })
  );

  const correctedWorkflow = JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;

  for (const correction of corrections) {
    if (!correction) {
      continue;
    }

    const node = correctedWorkflow.nodes.find((n) => n.name === correction.nodeName);
    if (!node?.parameters) {
      continue;
    }

    replaceInObject(node.parameters, correction.original, correction.corrected);

    logger.debug(
      { src: 'plugin:workflow:generation:correction' },
      `Corrected "${correction.original}" → "${correction.corrected}" in node "${correction.nodeName}"`
    );
  }

  return correctedWorkflow;
}

function replaceInObject(
  obj: Record<string, unknown>,
  original: string,
  replacement: string
): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (typeof value === 'string' && value.includes(original)) {
      obj[key] = value.replaceAll(original, replacement);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string' && value[i].includes(original)) {
          value[i] = value[i].replaceAll(original, replacement);
        } else if (typeof value[i] === 'object' && value[i] !== null) {
          replaceInObject(value[i] as Record<string, unknown>, original, replacement);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      replaceInObject(value as Record<string, unknown>, original, replacement);
    }
  }
}

/**
 * Try to deterministically rename an unknown key to a valid property name.
 * Returns the matching property name or null if no confident match.
 */
function fuzzyMatchParam(
  unknownKey: string,
  validProps: { name: string; type: string }[]
): string | null {
  const lower = unknownKey.toLowerCase();

  // Substring match: one valid prop contains the unknown key or vice-versa
  // Guard: shorter string must be ≥ 60% of the longer to avoid false positives (e.g. "url" in "curl")
  const substringMatches = validProps.filter((p) => {
    const pLower = p.name.toLowerCase();
    if (!(pLower.includes(lower) || lower.includes(pLower))) {
      return false;
    }
    const ratio = Math.min(lower.length, pLower.length) / Math.max(lower.length, pLower.length);
    return ratio >= 0.6;
  });
  if (substringMatches.length === 1) {
    return substringMatches[0].name;
  }

  return null;
}

/** Deterministic fast path + LLM fallback for parameter name correction. */
export async function correctParameterNames(
  runtime: IAgentRuntime,
  workflow: WorkflowDefinition,
  detections: UnknownParamDetection[]
): Promise<WorkflowDefinition> {
  if (detections.length === 0) {
    return workflow;
  }

  const correctedWorkflow = JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;

  // Phase 1: deterministic renames (no LLM cost)
  const needsLLM: UnknownParamDetection[] = [];

  for (const detection of detections) {
    const node = correctedWorkflow.nodes.find((n) => n.name === detection.nodeName);
    if (!node) {
      continue;
    }

    const remainingUnknowns: string[] = [];

    for (const key of detection.unknownKeys) {
      const match = fuzzyMatchParam(key, detection.propertyDefs);
      if (match) {
        logger.debug(
          { src: 'plugin:workflow:generation:paramCorrection' },
          `Node "${detection.nodeName}": ${key} → ${match} (deterministic)`
        );
        node.parameters[match] = node.parameters[key];
        delete node.parameters[key];
      } else {
        remainingUnknowns.push(key);
      }
    }

    if (remainingUnknowns.length > 0) {
      needsLLM.push({
        ...detection,
        unknownKeys: remainingUnknowns,
        currentParams: node.parameters,
      });
    }
  }

  if (needsLLM.length === 0) {
    return correctedWorkflow;
  }

  // Phase 2: LLM correction for complex cases (restructuring)
  logger.debug(
    { src: 'plugin:workflow:generation:paramCorrection' },
    `LLM correction needed for ${needsLLM.length} node(s): ${needsLLM.map((d) => `"${d.nodeName}" (${d.unknownKeys.join(', ')})`).join('; ')}`
  );

  const corrections = await Promise.all(
    needsLLM.map(async (detection) => {
      try {
        const userPrompt = PARAM_CORRECTION_USER_PROMPT.replace('{nodeType}', detection.nodeType)
          .replace('{currentParams}', JSON.stringify(detection.currentParams, null, 2))
          .replace('{propertyDefs}', JSON.stringify(detection.propertyDefs, null, 2));

        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: `${PARAM_CORRECTION_SYSTEM_PROMPT}\n\n${userPrompt}`,
          temperature: 0,
        });

        const cleaned = (response as string)
          .replace(/^[\s\S]*?```(?:json)?\s*\n?/i, '')
          .replace(/\n?```[\s\S]*$/i, '')
          .trim();

        const correctedParams = JSON.parse(cleaned) as Record<string, unknown>;

        // Validate: corrected params should only contain valid property names
        const validNames = new Set(detection.propertyDefs.map((p) => p.name));
        validNames.add('resource');
        validNames.add('operation');
        const invalidKeys = Object.keys(correctedParams).filter((k) => !validNames.has(k));
        if (invalidKeys.length > 0) {
          logger.warn(
            { src: 'plugin:workflow:generation:paramCorrection' },
            `LLM returned invalid keys for "${detection.nodeName}": ${invalidKeys.join(', ')} — dropping them`
          );
          for (const k of invalidKeys) {
            delete correctedParams[k];
          }
        }

        return { nodeName: detection.nodeName, correctedParams };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            src: 'plugin:workflow:generation:paramCorrection',
            error: errMsg,
          },
          `Failed to correct parameters for node "${detection.nodeName}": ${errMsg}`
        );
        return null;
      }
    })
  );

  for (const correction of corrections) {
    if (!correction) {
      continue;
    }

    const node = correctedWorkflow.nodes.find((n) => n.name === correction.nodeName);
    if (!node) {
      continue;
    }

    // Preserve resource/operation (already corrected by correctOptionParameters)
    if (node.parameters.resource !== undefined) {
      correction.correctedParams.resource = node.parameters.resource;
    }
    if (node.parameters.operation !== undefined) {
      correction.correctedParams.operation = node.parameters.operation;
    }

    logger.debug(
      { src: 'plugin:workflow:generation:paramCorrection' },
      `Node "${correction.nodeName}": params corrected via LLM — keys: ${Object.keys(correction.correctedParams).join(', ')}`
    );

    node.parameters = correction.correctedParams;
  }

  return correctedWorkflow;
}
