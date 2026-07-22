/**
 * Public-facing WorkflowService (type `workflow`): the RAG generation pipeline
 * and CRUD facade the `WORKFLOW` action and rawPath routes call into. Turns a
 * natural-language prompt into a runnable workflow via keyword extraction →
 * catalog search → LLM generation → validate/repair → deploy, then persists and
 * owner-tags it as an inactive draft until activation is explicitly requested.
 *
 * Generation and modification both run up to three LLM-retry passes through
 * `validateAndRepair` + `fixWorkflowErrors` to correct typeVersion
 * hallucinations, missing credential blocks, and invalid output references
 * before deploy. Deployment and execution are delegated to the
 * EmbeddedWorkflowService; credential resolution goes through the registered
 * WorkflowCredentialStore.
 */
import { ElizaError, type IAgentRuntime, logger, Service } from '@elizaos/core';
import type {
  NodeDefinition,
  NodeSearchResult,
  RuntimeContext,
  TriggerContext,
  WorkflowCreationResult,
  WorkflowCredentialStoreApi,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowEvaluationSuite,
  WorkflowExecution,
  WorkflowRevision,
} from '../types/index';
import {
  isCredentialProvider,
  isRuntimeContextProvider,
  UnsupportedIntegrationError,
  WORKFLOW_CREDENTIAL_PROVIDER_TYPE,
  WORKFLOW_CREDENTIAL_STORE_TYPE,
  WORKFLOW_RUNTIME_CONTEXT_PROVIDER_TYPE,
  WorkflowApiError,
} from '../types/index';
import {
  filterNodesByIntegrationSupport,
  getDefaultRequiredCredentialTypes,
  searchNodes,
} from '../utils/catalog';
import { CATALOG_CLARIFICATION_SUFFIX, isCatalogClarification } from '../utils/clarification';
import { getLocalOwnerEntityId, getUserTagName } from '../utils/context';
import { resolveCredentials } from '../utils/credentialResolver';
import { buildWorkflowEvaluationSuite } from '../utils/evaluation-samples';
import {
  assessFeasibility,
  collectExistingNodeDefinitions,
  correctFieldReferences,
  correctParameterNames,
  extractKeywords,
  fixWorkflowErrors,
  generateWorkflow,
  modifyWorkflow,
} from '../utils/generation';
import { normalizeSetNodeParametersInWorkflow } from '../utils/setNodeParameters';
import { validateAndRepair } from '../utils/validateAndRepair';
import {
  correctOptionParameters,
  detectUnknownParameters,
  ensureExpressionPrefix,
  injectMissingCredentialBlocks,
  normalizeTriggerSimpleParam,
  normalizeWorkflowNodeParameterShapes,
  positionNodes,
  validateNodeInputs,
  validateNodeParameters,
  validateOutputReferences,
  validateWorkflow,
} from '../utils/workflow';
import {
  DEVICE_HEALTH_CHECK_WORKFLOW_ID,
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from './embedded-workflow-service';

export const WORKFLOW_SERVICE_TYPE = 'workflow';

export interface WorkflowServiceConfig {
  apiKey: 'embedded';
  host: 'in-process';
  backend: 'embedded';
  credentials?: Record<string, string>; // Pre-configured credential IDs
}

type WorkflowDefinitionClient = Pick<
  EmbeddedWorkflowService,
  | 'createWorkflow'
  | 'listWorkflows'
  | 'getWorkflow'
  | 'updateWorkflow'
  | 'deleteWorkflow'
  | 'activateWorkflow'
  | 'deactivateWorkflow'
  | 'listWorkflowRevisions'
  | 'restoreWorkflowRevision'
  | 'executeWorkflow'
  | 'updateWorkflowTags'
  | 'createCredential'
  | 'listExecutions'
  | 'getExecution'
  | 'deleteExecution'
  | 'listTags'
  | 'createTag'
  | 'getOrCreateTag'
> & {
  getRuntimeNodeTypeVersions():
    | Promise<Map<string, number[]> | null>
    | Map<string, number[]>
    | null;
  getRegisteredNodeTypes?(): string[];
  supportsWorkflow?(workflow: WorkflowDefinition): { supported: boolean; missing: string[] };
};

function isWorkflowCredentialStoreApi(service: unknown): service is WorkflowCredentialStoreApi {
  return (
    service !== null &&
    typeof service === 'object' &&
    typeof (service as { get?: unknown }).get === 'function' &&
    typeof (service as { set?: unknown }).set === 'function'
  );
}

const FIELD_TRANSFORM_VERB_PATTERN =
  /\b(adds?|adding|sets?|setting|assigns?|assigning|writes?|writing|maps?|mapping|appends?|appending|enrich(?:es|ing)?)\b/;
const FIELD_TRANSFORM_TARGET_PATTERN =
  /\b(field|fields|value|values|data|item|items|metadata|json|property|properties)\b/;
const NETWORK_REQUEST_PATTERN =
  /\b(http|https|url|api|request|fetch|call|post|get|put|patch|delete|webhook)\b/;
const WORKFLOW_SEARCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'automation',
  'automations',
  'can',
  'do',
  'find',
  'for',
  'have',
  'i',
  'list',
  'me',
  'my',
  'of',
  'please',
  'search',
  'show',
  'that',
  'the',
  'to',
  'what',
  'which',
  'workflow',
  'workflows',
]);

function buildWorkflowSearchKeywords(prompt: string, keywords: string[]): string[] {
  const normalized = new Set(keywords.map((keyword) => keyword.toLowerCase()));
  const addKeyword = (keyword: string): void => {
    if (!normalized.has(keyword)) {
      keywords.unshift(keyword);
      normalized.add(keyword);
    }
  };
  const lowerPrompt = prompt.toLowerCase();
  if (FIELD_TRANSFORM_VERB_PATTERN.test(lowerPrompt)) {
    if (FIELD_TRANSFORM_TARGET_PATTERN.test(lowerPrompt)) {
      addKeyword('set');
    }
  }
  return keywords;
}

function filterPromptCandidateNodes(prompt: string, nodes: NodeSearchResult[]): NodeSearchResult[] {
  const lowerPrompt = prompt.toLowerCase();
  const looksLikeFieldTransform =
    FIELD_TRANSFORM_VERB_PATTERN.test(lowerPrompt) &&
    FIELD_TRANSFORM_TARGET_PATTERN.test(lowerPrompt);
  const looksLikeNetworkRequest = NETWORK_REQUEST_PATTERN.test(lowerPrompt);
  if (!looksLikeFieldTransform || looksLikeNetworkRequest) {
    return nodes;
  }
  return nodes.filter((result) => result.node.name !== 'workflows-nodes-base.httpRequest');
}

function normalizeGeneratedNodeParameterShapes(
  workflow: WorkflowDefinition,
  context: 'generated workflow' | 'modified workflow'
): void {
  const fixes = normalizeWorkflowNodeParameterShapes(workflow);
  if (fixes > 0) {
    logger.debug(
      { src: 'plugin:workflow:service:main' },
      `Normalized ${fixes} node parameter shape(s) in ${context}`
    );
  }
}

function normalizeWorkflowSearchToken(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

export function tokenizeWorkflowSearchQuery(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => normalizeWorkflowSearchToken(token.trim()))
    .filter(
      (token, index, tokens) =>
        token.length >= 2 &&
        !WORKFLOW_SEARCH_STOPWORDS.has(token) &&
        tokens.indexOf(token) === index
    );
  return normalized;
}

function scoreWorkflowMatchTerm(workflow: WorkflowDefinitionResponse, q: string): number {
  const name = String(workflow.name ?? '').toLowerCase();
  let score = 0;
  if (name === q) score += 100;
  else if (name.startsWith(q)) score += 50;
  else if (name.includes(q)) score += 30;

  const nodes = (workflow as { nodes?: Array<{ type?: unknown; name?: unknown }> }).nodes;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const type = String(node?.type ?? '').toLowerCase();
      const nodeName = String(node?.name ?? '').toLowerCase();
      if (type.includes(q) || nodeName.includes(q)) {
        score += 10;
        break;
      }
    }
  }

  const description = String(
    (workflow as { description?: unknown }).description ?? ''
  ).toLowerCase();
  if (description.includes(q)) score += 5;

  return score;
}

/**
 * Score a workflow against a free-text query: name beats node type beats
 * description, and an exact/prefix name match beats a substring. Sentence
 * queries are tokenized with generic workflow/search words ignored. Returns 0
 * for no match. Pure + exported so the ranking is unit-testable without a DB.
 */
export function scoreWorkflowMatch(workflow: WorkflowDefinitionResponse, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const phraseScore = scoreWorkflowMatchTerm(workflow, q);
  const tokenScore = tokenizeWorkflowSearchQuery(q).reduce(
    (total, token) => total + scoreWorkflowMatchTerm(workflow, token),
    0
  );

  return Math.max(phraseScore, tokenScore);
}

/**
 * Rank workflows best-match-first for a free-text query, dropping non-matches.
 * Exact trimmed, case-insensitive names dominate weaker token matches so a
 * lifecycle request naming one workflow cannot collect every similarly-named
 * workflow. An empty or generic query returns the input order unchanged. Pure
 * + exported (#8913).
 */
export function rankWorkflowsByQuery(
  workflows: WorkflowDefinitionResponse[],
  query: string
): WorkflowDefinitionResponse[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return workflows;
  const exactNameMatches = workflows.filter(
    (workflow) =>
      String(workflow.name ?? '')
        .trim()
        .toLowerCase() === normalizedQuery
  );
  if (exactNameMatches.length > 0) return exactNameMatches;
  if (tokenizeWorkflowSearchQuery(query).length === 0) return workflows;
  return workflows
    .map((workflow) => ({ workflow, score: scoreWorkflowMatch(workflow, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.workflow);
}

/**
 * Workflow Service - Orchestrates the RAG pipeline for workflow generation.
 *
 * generateWorkflowDraft(): keywords → node search → LLM generation → validation → positioning
 * deployWorkflow(): credential resolution → in-process runtime → tagging
 */
export class WorkflowService extends Service {
  static override readonly serviceType = WORKFLOW_SERVICE_TYPE;

  override capabilityDescription =
    'Generate and deploy workflows from natural language using RAG pipeline. ' +
    'Supports workflow CRUD, execution management, and credential resolution.';

  private apiClient: WorkflowDefinitionClient | null = null;
  private serviceConfig: WorkflowServiceConfig | null = null;

  static async start(runtime: IAgentRuntime): Promise<WorkflowService> {
    logger.info({ src: 'plugin:workflow:service:main' }, 'Starting Workflow Service...');

    // Get optional pre-configured credentials from character.settings.workflows
    // Note: runtime.getSetting() only returns primitives — nested objects must be read directly
    const workflowSettings = runtime.character.settings?.workflows as
      | { credentials?: Record<string, string> }
      | undefined;
    const credentials = workflowSettings?.credentials;

    const service = new WorkflowService(runtime);
    const loadedEmbedded = await runtime.getServiceLoadPromise(EMBEDDED_WORKFLOW_SERVICE_TYPE);
    if (!(loadedEmbedded instanceof EmbeddedWorkflowService)) {
      throw new ElizaError('Embedded workflow service resolved to an incompatible service', {
        code: 'WORKFLOW_EMBEDDED_SERVICE_INVALID',
        context: { serviceType: EMBEDDED_WORKFLOW_SERVICE_TYPE },
      });
    }
    const embedded = loadedEmbedded;
    service.serviceConfig = {
      apiKey: 'embedded',
      host: 'in-process',
      backend: 'embedded',
      credentials,
    };
    service.apiClient = embedded;

    logger.info(
      { src: 'plugin:workflow:service:main' },
      `Workflow Service started - connected to ${service.serviceConfig.host}`
    );
    if (credentials) {
      const configured = Object.entries(credentials)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (configured.length > 0) {
        logger.info(
          { src: 'plugin:workflow:service:main' },
          `Pre-configured credentials: ${configured.join(', ')}`
        );
      }
    }

    return service;
  }

  override async stop(): Promise<void> {
    logger.info({ src: 'plugin:workflow:service:main' }, 'Stopping Workflow Service...');
    this.apiClient = null;
    this.serviceConfig = null;
    logger.info({ src: 'plugin:workflow:service:main' }, 'Workflow Service stopped');
  }

  private filterForEmbeddedBackend<T extends { node: NodeDefinition }>(results: T[]): T[] {
    if (this.serviceConfig?.backend !== 'embedded') {
      return results;
    }
    const registered = this.apiClient?.getRegisteredNodeTypes?.();
    if (!registered?.length) {
      return results;
    }
    const registeredSet = new Set(registered);
    return results.filter((result) => registeredSet.has(result.node.name));
  }

  private resolveDeployTarget(workflow: WorkflowDefinition): {
    client: WorkflowDefinitionClient;
    config: WorkflowServiceConfig;
    routedToFallback: boolean;
  } {
    const client = this.getClient();
    const config = this.getConfig();
    if (config.backend !== 'embedded') {
      return { client, config, routedToFallback: false };
    }

    const support = client.supportsWorkflow?.(workflow);
    if (!support || support.supported) {
      return { client, config, routedToFallback: false };
    }

    throw new WorkflowApiError(
      `Embedded workflow runtime does not support node type(s): ${support.missing.join(', ')}`,
      400
    );
  }

  private injectCatalogClarifications(workflow: WorkflowDefinition): void {
    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);
    const catalogWarnings = [...paramWarnings, ...inputWarnings];

    if (!workflow._meta) {
      workflow._meta = {};
    }

    // Strip previous catalog-derived clarifications to avoid stale duplicates
    // across regeneration cycles (generate → modify → modify). Mixed-shape
    // arrays (legacy strings + structured ClarificationRequest) are both
    // supported via isCatalogClarification.
    const nonCatalog = (workflow._meta.requiresClarification || []).filter(
      (c) => !isCatalogClarification(c)
    );

    if (catalogWarnings.length > 0) {
      logger.warn(
        { src: 'plugin:workflow:service:main' },
        `Catalog validation: ${catalogWarnings.join(', ')}`
      );
      const clarifications = catalogWarnings.map((w) => `${w} ${CATALOG_CLARIFICATION_SUFFIX}`);
      workflow._meta.requiresClarification = [...nonCatalog, ...clarifications];
    } else {
      workflow._meta.requiresClarification = nonCatalog.length > 0 ? nonCatalog : undefined;
    }
  }

  private getClient(): WorkflowDefinitionClient {
    if (!this.apiClient) {
      throw new Error('Workflow Service not initialized');
    }
    return this.apiClient;
  }

  private getConfig(): WorkflowServiceConfig {
    if (!this.serviceConfig) {
      throw new Error('Workflow Service not initialized');
    }
    return this.serviceConfig;
  }

  /**
   * Query the optional `workflow_runtime_context_provider` service for runtime
   * facts to inject into the workflow-generation prompt. The host runtime
   * uses this to surface real Discord guild/channel IDs, the user's Gmail
   * email, and which credential types it can resolve. Returns `undefined`
   * when no provider is registered or the call throws — generation proceeds
   * with the baseline prompt.
   */
  private async fetchRuntimeContext(
    nodeDefs: NodeDefinition[],
    userId: string,
    triggerContext?: TriggerContext
  ): Promise<RuntimeContext | undefined> {
    const raw = this.runtime.getService(WORKFLOW_RUNTIME_CONTEXT_PROVIDER_TYPE);
    const provider = isRuntimeContextProvider(raw) ? raw : null;
    if (!provider) {
      return undefined;
    }
    const relevantCredTypes = [
      ...new Set(nodeDefs.flatMap((n) => (n.credentials ?? []).map((c) => c.name))),
    ];
    try {
      return await provider.getRuntimeContext({
        userId,
        relevantNodes: nodeDefs,
        relevantCredTypes,
        ...(triggerContext ? { triggerContext } : {}),
      });
    } catch (err) {
      logger.warn(
        {
          src: 'plugin:workflow:service:main',
          err: err instanceof Error ? err.message : String(err),
        },
        'RuntimeContextProvider threw — generating without runtime facts'
      );
      return undefined;
    }
  }

  async generateWorkflowDraft(
    prompt: string,
    opts?: { userId?: string; triggerContext?: TriggerContext }
  ): Promise<WorkflowDefinition> {
    logger.info({ src: 'plugin:workflow:service:main' }, 'Generating workflow draft from prompt');

    // Fetch host-supplied bias hints early (before keyword extraction) so the
    // LLM is told which providers the host already knows it can satisfy.
    // We pass empty `relevantNodes` / `relevantCredTypes` here before
    // node-catalog search runs: `preferredProviders` is derived from the
    // host's connector config alone (independent of node search). The
    // full runtime context (with credentials + facts) is fetched again after search
    // once we have the filtered node list.
    const earlyContext = await this.fetchRuntimeContext([], opts?.userId ?? 'local');
    const preferredProviders = earlyContext?.preferredProviders;

    const keywords = buildWorkflowSearchKeywords(
      prompt,
      await extractKeywords(this.runtime, prompt, preferredProviders)
    );
    logger.debug(
      { src: 'plugin:workflow:service:main' },
      `Extracted keywords: ${keywords.join(', ')}${preferredProviders?.length ? ` (with bias: ${preferredProviders.join(', ')})` : ''}`
    );

    let relevantNodes = this.filterForEmbeddedBackend(
      filterPromptCandidateNodes(prompt, searchNodes(keywords, 15))
    );
    logger.debug(
      { src: 'plugin:workflow:service:main' },
      `Found ${relevantNodes.length} relevant nodes`
    );

    if (relevantNodes.length === 0) {
      throw new Error(
        'No relevant workflows nodes found for the given prompt. Please be more specific about the integrations you want to use (e.g., Gmail, Slack, Stripe).'
      );
    }

    // ── Integration availability check ──
    const rawProvider = this.runtime.getService(WORKFLOW_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;

    if (credProvider?.checkCredentialTypes) {
      const credTypes = new Set<string>();
      for (const { node } of relevantNodes) {
        for (const credentialType of getDefaultRequiredCredentialTypes(node)) {
          credTypes.add(credentialType);
        }
      }

      if (credTypes.size > 0) {
        const checkResult = credProvider.checkCredentialTypes([...credTypes]);

        if (checkResult.unsupported.length > 0) {
          const supportedSet = new Set(checkResult.supported);
          const { remaining, removed } = filterNodesByIntegrationSupport(
            relevantNodes,
            supportedSet
          );

          const remainingServiceNodes = remaining.filter(
            (result) => getDefaultRequiredCredentialTypes(result.node).length > 0
          );

          if (remainingServiceNodes.length === 0) {
            throw new UnsupportedIntegrationError(
              [...new Set(removed.map((r) => r.node.displayName))],
              []
            );
          }

          const feasibility = await assessFeasibility(this.runtime, prompt, removed, remaining);

          if (!feasibility.feasible) {
            throw new UnsupportedIntegrationError(
              [...new Set(removed.map((r) => r.node.displayName))],
              [...new Set(remainingServiceNodes.map((r) => r.node.displayName))]
            );
          }

          logger.debug(
            { src: 'plugin:workflow:service:main' },
            `Feasibility OK: ${feasibility.reason}. Proceeding with ${remaining.length} nodes.`
          );
          relevantNodes = remaining;
        }
      }
    }
    // ── End integration check ──

    const finalNodeDefs = relevantNodes.map((r) => r.node);
    const runtimeContext = await this.fetchRuntimeContext(
      finalNodeDefs,
      opts?.userId ?? 'local',
      opts?.triggerContext
    );

    let workflow = await generateWorkflow(this.runtime, prompt, finalNodeDefs, runtimeContext);
    logger.debug(
      { src: 'plugin:workflow:service:main' },
      `Generated workflow with ${workflow.nodes.length || 0} nodes`
    );

    // Safety net: even with the MANDATORY INVARIANT prompt rule, the LLM
    // sometimes omits the `credentials` block on credentialed nodes. Inject
    // it deterministically based on the node's catalog definition + the
    // host's supported cred types so resolveCredentials can mint the
    // credential server-side instead of falling back to a manual UI step.
    const injectedCreds = injectMissingCredentialBlocks(workflow, finalNodeDefs, runtimeContext);
    if (injectedCreds > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Injected ${injectedCreds} missing credentials block(s) (LLM omitted)`
      );
    }

    // Layer 1+3 (Session 21): deterministic pre-deploy validation pass with
    // bounded LLM-retry. Catches typeVersion hallucinations, missing
    // parameters.authentication, output-field case mismatches (Subject vs
    // subject), node-name collisions, and dangling connection edges. When
    // an error can't be auto-fixed deterministically, fixWorkflowErrors
    // sends a surgical fix prompt to the LLM. Cap at 3 retries to bound
    // worst-case cost.
    //
    // Fetch the live workflow runtime's node-type registry once per deploy so
    // typeVersion clamping intersects catalog ∩ runtime — necessary
    // because the bundled `defaultNodes.json` can be ahead of the user's
    // actually-installed workflows binary (e.g. catalog says Gmail v2.2 but
    // runtime only ships up to v2.1).
    const generateClient = this.getClient();
    const runtimeVersions = (await generateClient.getRuntimeNodeTypeVersions()) ?? undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const repairResult = validateAndRepair(
        workflow,
        finalNodeDefs,
        runtimeContext,
        runtimeVersions
      );
      workflow = repairResult.workflow;
      if (repairResult.errors.length === 0) {
        break;
      }
      if (attempt === 2) {
        logger.warn(
          {
            src: 'plugin:workflow:service:main',
            errors: repairResult.errors,
          },
          `validateAndRepair: ${repairResult.errors.length} unrecoverable error(s) after 3 retries — proceeding to deploy with _meta.errors`
        );
        workflow._meta = workflow._meta ?? {};
        const errorLines = repairResult.errors.map(
          (e) =>
            `${e.node}: ${e.detail}${e.availableFields?.length ? ` (available: ${e.availableFields.join(', ')})` : ''}`
        );
        const existing = workflow._meta.requiresClarification ?? [];
        workflow._meta.requiresClarification = [...existing, ...errorLines];
        break;
      }
      try {
        workflow = await fixWorkflowErrors(
          this.runtime,
          workflow,
          repairResult.errors,
          finalNodeDefs,
          prompt
        );
      } catch (err) {
        logger.warn(
          {
            src: 'plugin:workflow:service:main',
            err: err instanceof Error ? err.message : String(err),
          },
          'fixWorkflowErrors threw — exiting retry loop'
        );
        break;
      }
    }

    normalizeTriggerSimpleParam(workflow);
    normalizeGeneratedNodeParameterShapes(workflow, 'generated workflow');

    const optionFixes = correctOptionParameters(workflow);
    if (optionFixes > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Corrected ${optionFixes} invalid option parameter(s)`
      );
    }

    const unknownParams = detectUnknownParameters(workflow);
    if (unknownParams.length > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Found ${unknownParams.length} node(s) with unknown parameters, auto-correcting...`
      );
      workflow = await correctParameterNames(this.runtime, workflow, unknownParams);
      normalizeGeneratedNodeParameterShapes(workflow, 'generated workflow');
    }

    const invalidRefs = validateOutputReferences(workflow);
    if (invalidRefs.length > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Found ${invalidRefs.length} invalid field reference(s), auto-correcting...`
      );
      workflow = await correctFieldReferences(this.runtime, workflow, invalidRefs);
      normalizeGeneratedNodeParameterShapes(workflow, 'generated workflow');
    }

    const exprPrefixed = ensureExpressionPrefix(workflow);
    if (exprPrefixed > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Prefixed ${exprPrefixed} expression value(s) with "="`
      );
    }

    const validationResult = validateWorkflow(workflow);
    if (!validationResult.valid) {
      logger.error(
        { src: 'plugin:workflow:service:main' },
        `Validation errors: ${validationResult.errors.join(', ')}`
      );
      throw new Error(`Generated workflow is invalid: ${validationResult.errors[0]}`);
    }
    if (validationResult.warnings.length > 0) {
      logger.warn(
        { src: 'plugin:workflow:service:main' },
        `Validation warnings: ${validationResult.warnings.join(', ')}`
      );
    }

    this.injectCatalogClarifications(workflow);
    const draft = positionNodes(workflow);
    // The generation prompt describes the persisted workflow shape, so weak
    // models sometimes invent a top-level placeholder id such as
    // `workflow-001`. A create draft has no storage identity yet; retaining the
    // placeholder makes deployWorkflow correctly interpret it as an update and
    // fail with a misleading 404 instead of creating the new workflow. Node ids
    // remain intact because they identify graph edges, not persisted workflows.
    delete draft.id;
    return draft;
  }

  async modifyWorkflowDraft(
    existingWorkflow: WorkflowDefinition,
    modificationRequest: string,
    opts?: { userId?: string; triggerContext?: TriggerContext }
  ): Promise<WorkflowDefinition> {
    logger.info(
      { src: 'plugin:workflow:service:main' },
      `Modifying workflow draft: ${modificationRequest.slice(0, 100)}`
    );

    // Get definitions for nodes already in the workflow
    const existingDefs = collectExistingNodeDefinitions(existingWorkflow);

    // Search for new nodes the modification might need
    const keywords = buildWorkflowSearchKeywords(
      modificationRequest,
      await extractKeywords(this.runtime, modificationRequest)
    );
    const searchResults = this.filterForEmbeddedBackend(
      filterPromptCandidateNodes(modificationRequest, searchNodes(keywords, 10))
    );
    const newDefs = searchResults.map((r) => r.node);

    // Deduplicate: merge existing + new, preferring existing (already in workflow)
    const seenNames = new Set(existingDefs.map((d) => d.name));
    const combinedDefs = [...existingDefs];
    for (const def of newDefs) {
      if (!seenNames.has(def.name)) {
        seenNames.add(def.name);
        combinedDefs.push(def);
      }
    }

    logger.debug(
      { src: 'plugin:workflow:service:main' },
      `Modify context: ${existingDefs.length} existing + ${newDefs.length} searched → ${combinedDefs.length} unique node defs`
    );

    const runtimeContext = await this.fetchRuntimeContext(
      combinedDefs,
      opts?.userId ?? 'local',
      opts?.triggerContext
    );

    let workflow = await modifyWorkflow(
      this.runtime,
      existingWorkflow,
      modificationRequest,
      combinedDefs,
      runtimeContext
    );

    // Safety net: same deterministic credential-block injection as
    // generateWorkflowDraft. Modification regenerations are equally prone
    // to dropping the credentials block.
    const injectedCreds = injectMissingCredentialBlocks(workflow, combinedDefs, runtimeContext);
    if (injectedCreds > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Injected ${injectedCreds} missing credentials block(s) on modify (LLM omitted)`
      );
    }

    // Layer 1+3 (Session 21): mirror the validate-and-repair retry loop on
    // the modify path. Modifications can drift in the same ways generations
    // do (typeVersion hallucination, missing authentication, etc.) so the
    // gate must run here too. Same runtime-version intersect as the
    // generate path — fetch once, reuse across all 3 retry attempts.
    const modifyClient = this.getClient();
    const runtimeVersionsForModify = (await modifyClient.getRuntimeNodeTypeVersions()) ?? undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const repairResult = validateAndRepair(
        workflow,
        combinedDefs,
        runtimeContext,
        runtimeVersionsForModify
      );
      workflow = repairResult.workflow;
      if (repairResult.errors.length === 0) {
        break;
      }
      if (attempt === 2) {
        logger.warn(
          {
            src: 'plugin:workflow:service:main',
            errors: repairResult.errors,
          },
          `validateAndRepair (modify): ${repairResult.errors.length} unrecoverable error(s) after 3 retries`
        );
        workflow._meta = workflow._meta ?? {};
        const errorLines = repairResult.errors.map(
          (e) =>
            `${e.node}: ${e.detail}${e.availableFields?.length ? ` (available: ${e.availableFields.join(', ')})` : ''}`
        );
        const existing = workflow._meta.requiresClarification ?? [];
        workflow._meta.requiresClarification = [...existing, ...errorLines];
        break;
      }
      try {
        workflow = await fixWorkflowErrors(
          this.runtime,
          workflow,
          repairResult.errors,
          combinedDefs,
          modificationRequest
        );
      } catch (err) {
        logger.warn(
          {
            src: 'plugin:workflow:service:main',
            err: err instanceof Error ? err.message : String(err),
          },
          'fixWorkflowErrors (modify) threw — exiting retry loop'
        );
        break;
      }
    }

    normalizeTriggerSimpleParam(workflow);
    normalizeGeneratedNodeParameterShapes(workflow, 'modified workflow');

    const optionFixes = correctOptionParameters(workflow);
    if (optionFixes > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Corrected ${optionFixes} invalid option parameter(s) in modified workflow`
      );
    }

    const unknownParams = detectUnknownParameters(workflow);
    if (unknownParams.length > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Found ${unknownParams.length} node(s) with unknown parameters in modified workflow, auto-correcting...`
      );
      workflow = await correctParameterNames(this.runtime, workflow, unknownParams);
      normalizeGeneratedNodeParameterShapes(workflow, 'modified workflow');
    }

    const invalidRefs = validateOutputReferences(workflow);
    if (invalidRefs.length > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Found ${invalidRefs.length} invalid field reference(s) in modified workflow, auto-correcting...`
      );
      workflow = await correctFieldReferences(this.runtime, workflow, invalidRefs);
      normalizeGeneratedNodeParameterShapes(workflow, 'modified workflow');
    }

    const exprPrefixed = ensureExpressionPrefix(workflow);
    if (exprPrefixed > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Prefixed ${exprPrefixed} expression value(s) with "=" in modified workflow`
      );
    }

    const validationResult = validateWorkflow(workflow);
    if (!validationResult.valid) {
      logger.error(
        { src: 'plugin:workflow:service:main' },
        `Modified workflow validation errors: ${validationResult.errors.join(', ')}`
      );
      throw new Error(`Modified workflow is invalid: ${validationResult.errors[0]}`);
    }

    this.injectCatalogClarifications(workflow);
    return positionNodes(workflow);
  }

  async deployWorkflow(
    workflow: WorkflowDefinition,
    userId: string,
    options?: { activate?: boolean }
  ): Promise<WorkflowCreationResult> {
    logger.info(
      { src: 'plugin:workflow:service:main' },
      `Deploying workflow "${workflow.name}" for user ${userId}`
    );

    const deployTarget = this.resolveDeployTarget(workflow);
    const { config, client } = deployTarget;

    const rawCredStore = this.runtime.getService(WORKFLOW_CREDENTIAL_STORE_TYPE);
    const credStore = isWorkflowCredentialStoreApi(rawCredStore) ? rawCredStore : null;

    const rawProvider = this.runtime.getService(WORKFLOW_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;

    // An explicit id is an update contract, not permission to create a
    // replacement. Loading it through the owner-scoped facade also captures
    // the state that an update without a lifecycle instruction must preserve.
    const existingWorkflow = workflow.id ? await this.getWorkflow(workflow.id, userId) : null;

    // Compute tag name once - reused for credentials and workflow tagging
    const tagName = await getUserTagName(this.runtime, userId);

    const credentialResult = await resolveCredentials(
      workflow,
      userId,
      config,
      credStore ?? null,
      credProvider,
      client,
      tagName
    );

    // Block deploy if any credential is unresolved
    if (credentialResult.missingConnections.length > 0) {
      return {
        id: '',
        name: workflow.name,
        active: false,
        nodeCount: workflow.nodes.length,
        missingCredentials: credentialResult.missingConnections,
      };
    }

    const setParameterResult = normalizeSetNodeParametersInWorkflow(credentialResult.workflow);
    if (setParameterResult.corrections > 0) {
      logger.debug(
        { src: 'plugin:workflow:service:main' },
        `Normalized ${setParameterResult.corrections} Set/Edit Fields parameter shape(s) before deploy`
      );
    }
    if (setParameterResult.issues.length > 0) {
      throw new ElizaError('Workflow contains invalid Set/Edit Fields parameters', {
        code: 'WORKFLOW_SET_PARAMETERS_INVALID',
        context: {
          workflowId: workflow.id,
          issues: setParameterResult.issues,
        },
        severity: 'ephemeral',
      });
    }

    let deployedWorkflow: WorkflowDefinitionResponse;
    let wasUpdate = false;
    if (workflow.id) {
      // The editor DTO intentionally omits persisted metadata. Carry tags
      // forward so saving cannot erase the ownership tag and immediately make
      // the workflow disappear from both chat and HTTP owner scopes.
      const updateDefinition: WorkflowDefinition = {
        ...credentialResult.workflow,
        ...(existingWorkflow?.tags ? { tags: existingWorkflow.tags } : {}),
      };
      deployedWorkflow = await client.updateWorkflow(workflow.id, updateDefinition);
      wasUpdate = true;
    } else {
      deployedWorkflow = await client.createWorkflow(credentialResult.workflow);
    }

    logger.info(
      { src: 'plugin:workflow:service:main' },
      `Workflow ${wasUpdate ? 'updated' : 'created'}: ${deployedWorkflow.id}`
    );

    // Ownership must persist before a newly-created definition can become active.
    if (userId && !wasUpdate) {
      try {
        const userTag = await client.getOrCreateTag(tagName);
        await client.updateWorkflowTags(deployedWorkflow.id, [userTag.id]);
        logger.debug(
          { src: 'plugin:workflow:service:main' },
          `Tagged workflow ${deployedWorkflow.id} with "${tagName}"`
        );
      } catch (error) {
        // error-policy:J2 ownership persistence failure is rethrown with the
        // created workflow and user context after compensating the orphan.
        try {
          await client.deleteWorkflow(deployedWorkflow.id);
        } catch (cleanupError) {
          // error-policy:J6 compensation is best-effort; the ownership failure
          // below remains the primary error while the orphan cleanup is logged.
          logger.error(
            { src: 'plugin:workflow:service:main', cleanupError },
            `Failed to remove unowned workflow ${deployedWorkflow.id}`
          );
        }
        throw new ElizaError('Workflow ownership could not be persisted', {
          code: 'WORKFLOW_OWNERSHIP_PERSIST_FAILED',
          cause: error,
          context: { workflowId: deployedWorkflow.id, userId },
        });
      }
    }

    // Saving a definition is not a lifecycle operation. New workflows remain
    // drafts, while updates retain their prior state. Activation/deactivation
    // occurs only when a caller explicitly supplies `activate` (or when a
    // backend violates the update-preserves-state contract and needs repair).
    const desiredActive =
      options?.activate ?? (wasUpdate ? Boolean(existingWorkflow?.active) : false);
    const lifecycleNeeded = Boolean(deployedWorkflow.active) !== desiredActive;
    if (lifecycleNeeded) {
      try {
        if (desiredActive) {
          await client.activateWorkflow(deployedWorkflow.id);
        } else {
          await client.deactivateWorkflow(deployedWorkflow.id);
        }
        logger.info(
          { src: 'plugin:workflow:service:main' },
          `Workflow ${deployedWorkflow.id} ${desiredActive ? 'activated' : 'deactivated'}`
        );
      } catch (error) {
        // error-policy:J2 lifecycle failure is rethrown with the workflow,
        // owner, and create/update context after any create compensation.
        if (!wasUpdate) {
          try {
            await client.deleteWorkflow(deployedWorkflow.id);
          } catch (cleanupError) {
            // error-policy:J6 compensation is best-effort; the lifecycle
            // failure remains primary while orphan cleanup is observable here.
            logger.error(
              { src: 'plugin:workflow:service:main', cleanupError },
              `Failed to remove workflow ${deployedWorkflow.id} after lifecycle failure`
            );
          }
        }
        throw new ElizaError(
          desiredActive ? 'Workflow activation failed' : 'Workflow deactivation failed',
          {
            code: desiredActive ? 'WORKFLOW_ACTIVATION_FAILED' : 'WORKFLOW_DEACTIVATION_FAILED',
            cause: error,
            context: { workflowId: deployedWorkflow.id, userId, wasUpdate },
            severity: 'ephemeral',
          }
        );
      }
    }

    return {
      id: deployedWorkflow.id,
      name: deployedWorkflow.name,
      active: desiredActive,
      nodeCount: deployedWorkflow.nodes.length,
      missingCredentials: credentialResult.missingConnections,
    };
  }

  async listWorkflows(userId?: string): Promise<WorkflowDefinitionResponse[]> {
    const client = this.getClient();
    const workflowsResponse = await client.listWorkflows();

    if (userId) {
      const tagName = await getUserTagName(this.runtime, userId);
      const tagsResponse = await client.listTags();
      const userTag = tagsResponse.data.find((t) => t.name === tagName);

      // The install-time health check predates user tags and must remain usable
      // after an upgrade. Its fixed system id is visible only to this agent's
      // canonical local owner; all other rows still require an exact owner tag.
      const includeSystemDefault = userId.trim() === getLocalOwnerEntityId(this.runtime);
      return workflowsResponse.data.filter(
        (workflow) =>
          (includeSystemDefault &&
            workflow.id === DEVICE_HEALTH_CHECK_WORKFLOW_ID &&
            (!workflow.tags || workflow.tags.length === 0)) ||
          (userTag !== undefined && workflow.tags?.some((tag) => tag.id === userTag.id))
      );
    }

    return workflowsResponse.data;
  }

  /**
   * Free-text search over the user's workflows by name, node type, and
   * description, ranked best-match-first (#8913). Lets a user find "the Slack
   * workflow" from a chat message without knowing its id.
   */
  async searchWorkflows(query: string, userId?: string): Promise<WorkflowDefinitionResponse[]> {
    const workflows = await this.listWorkflows(userId);
    return rankWorkflowsByQuery(workflows, query);
  }

  private async assertWorkflowOwned(workflowId: string, userId: string): Promise<void> {
    const workflows = await this.listWorkflows(userId);
    if (workflows.some((workflow) => workflow.id === workflowId)) return;
    throw new WorkflowApiError(`Workflow not found: ${workflowId}`, 404);
  }

  async activateWorkflow(workflowId: string, userId?: string): Promise<void> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    await client.activateWorkflow(workflowId);
    logger.info({ src: 'plugin:workflow:service:main' }, `Workflow ${workflowId} activated`);
  }

  async deactivateWorkflow(workflowId: string, userId?: string): Promise<void> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    await client.deactivateWorkflow(workflowId);
    logger.info({ src: 'plugin:workflow:service:main' }, `Workflow ${workflowId} deactivated`);
  }

  async deleteWorkflow(workflowId: string, userId?: string): Promise<void> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    await client.deleteWorkflow(workflowId);
    logger.info({ src: 'plugin:workflow:service:main' }, `Workflow ${workflowId} deleted`);
  }

  async getWorkflow(workflowId: string, userId?: string): Promise<WorkflowDefinitionResponse> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    return client.getWorkflow(workflowId);
  }

  async listWorkflowRevisions(
    workflowId: string,
    limit?: number,
    userId?: string
  ): Promise<WorkflowRevision[]> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    const response = await client.listWorkflowRevisions(workflowId, limit);
    return response.data;
  }

  async restoreWorkflowRevision(
    workflowId: string,
    versionId: string,
    userId?: string
  ): Promise<WorkflowDefinitionResponse> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    return client.restoreWorkflowRevision(workflowId, versionId);
  }

  async runWorkflow(
    workflowId: string,
    options?: {
      mode?: WorkflowExecution['mode'];
      triggerData?: Record<string, unknown>;
      idempotencyKey?: string;
      throwOnError?: boolean;
    },
    userId?: string
  ): Promise<WorkflowExecution> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    return client.executeWorkflow(workflowId, {
      mode: options?.mode ?? 'manual',
      triggerData: options?.triggerData,
      idempotencyKey: options?.idempotencyKey,
      throwOnError: options?.throwOnError,
    });
  }

  async getWorkflowExecutions(
    workflowId: string,
    limit?: number,
    userId?: string
  ): Promise<WorkflowExecution[]> {
    if (userId) await this.assertWorkflowOwned(workflowId, userId);
    const client = this.getClient();
    const response = await client.listExecutions({ workflowId, limit });
    return response.data;
  }

  async getWorkflowEvaluationSuite(
    workflowId: string,
    limit?: number,
    userId?: string
  ): Promise<WorkflowEvaluationSuite> {
    const [workflow, executions] = await Promise.all([
      this.getWorkflow(workflowId, userId),
      this.getWorkflowExecutions(workflowId, limit, userId),
    ]);
    return buildWorkflowEvaluationSuite(workflow, executions, { limit });
  }

  async listExecutions(
    params?: {
      workflowId?: string;
      status?: 'canceled' | 'error' | 'running' | 'success' | 'waiting';
      limit?: number;
      cursor?: string;
    },
    userId?: string
  ): Promise<{ data: WorkflowExecution[]; nextCursor?: string }> {
    if (userId && params?.workflowId) {
      await this.assertWorkflowOwned(params.workflowId, userId);
    }
    const client = this.getClient();
    if (!userId || params?.workflowId) return client.listExecutions(params);

    const ownedIds = new Set((await this.listWorkflows(userId)).map((workflow) => workflow.id));
    const requestedLimit = params?.limit;
    const collected: WorkflowExecution[] = [];
    const seenCursors = new Set<string>();
    let cursor = params?.cursor;

    while (true) {
      const remaining =
        typeof requestedLimit === 'number' ? requestedLimit - collected.length : undefined;
      if (remaining !== undefined && remaining <= 0) {
        return { data: collected, ...(cursor ? { nextCursor: cursor } : {}) };
      }

      const response = await client.listExecutions({
        ...params,
        ...(remaining !== undefined ? { limit: remaining } : {}),
        ...(cursor ? { cursor } : {}),
      });
      collected.push(...response.data.filter((execution) => ownedIds.has(execution.workflowId)));

      const nextCursor = response.nextCursor;
      if (!nextCursor) return { data: collected };
      if (requestedLimit !== undefined && collected.length >= requestedLimit) {
        return { data: collected, nextCursor };
      }
      if (seenCursors.has(nextCursor) || nextCursor === cursor) {
        throw new ElizaError('Workflow execution pagination cursor did not advance', {
          code: 'WORKFLOW_EXECUTION_CURSOR_STALLED',
          context: { userId, cursor: nextCursor },
          severity: 'ephemeral',
        });
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async getExecutionDetail(executionId: string, userId?: string): Promise<WorkflowExecution> {
    const client = this.getClient();
    try {
      const execution = await client.getExecution(executionId);
      if (userId) await this.assertWorkflowOwned(execution.workflowId, userId);
      return execution;
    } catch (error) {
      // error-policy:J3 an untrusted execution id receives one explicit
      // not-found signal whether the row is absent or belongs to another user.
      if (userId && error instanceof WorkflowApiError && error.statusCode === 404) {
        throw new WorkflowApiError(`Execution not found: ${executionId}`, 404);
      }
      throw error;
    }
  }
}
