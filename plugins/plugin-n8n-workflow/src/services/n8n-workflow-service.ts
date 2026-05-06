import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import { N8nApiClient } from '../utils/api';
import { searchNodes, filterNodesByIntegrationSupport } from '../utils/catalog';
import { getUserTagName } from '../utils/context';
import {
  extractKeywords,
  generateWorkflow,
  modifyWorkflow,
  collectExistingNodeDefinitions,
  assessFeasibility,
  correctFieldReferences,
  correctParameterNames,
} from '../utils/generation';
import {
  positionNodes,
  validateWorkflow,
  validateNodeParameters,
  validateNodeInputs,
  validateOutputReferences,
  normalizeTriggerSimpleParam,
  correctOptionParameters,
  detectUnknownParameters,
  ensureExpressionPrefix,
  injectMissingCredentialBlocks,
} from '../utils/workflow';
import { resolveCredentials } from '../utils/credentialResolver';
import { validateAndRepair } from '../utils/validateAndRepair';
import { fixWorkflowErrors } from '../utils/generation';
import { CATALOG_CLARIFICATION_SUFFIX, isCatalogClarification } from '../utils/clarification';
import type {
  N8nWorkflow,
  N8nWorkflowResponse,
  N8nExecution,
  WorkflowCreationResult,
  N8nCredentialStoreApi,
  NodeDefinition,
  NodeSearchResult,
  RuntimeContext,
  TriggerContext,
} from '../types/index';
import {
  N8N_CREDENTIAL_STORE_TYPE,
  N8N_CREDENTIAL_PROVIDER_TYPE,
  N8N_RUNTIME_CONTEXT_PROVIDER_TYPE,
  isCredentialProvider,
  isRuntimeContextProvider,
  UnsupportedIntegrationError,
} from '../types/index';

export const N8N_WORKFLOW_SERVICE_TYPE = 'n8n_workflow';

export interface N8nWorkflowServiceConfig {
  apiKey: string;
  host: string;
  credentials?: Record<string, string>; // Pre-configured credential IDs
}

/**
 * N8n Workflow Service - Orchestrates the RAG pipeline for workflow generation.
 *
 * generateWorkflowDraft(): keywords → node search → LLM generation → validation → positioning
 * deployWorkflow(): credential resolution → n8n Cloud API → tagging
 */
export class N8nWorkflowService extends Service {
  static override readonly serviceType = N8N_WORKFLOW_SERVICE_TYPE;

  override capabilityDescription =
    'Generate and deploy n8n workflows from natural language using RAG pipeline. ' +
    'Supports workflow CRUD, execution management, and credential resolution.';

  private apiClient: N8nApiClient | null = null;
  private serviceConfig: N8nWorkflowServiceConfig | null = null;

  static async start(runtime: IAgentRuntime): Promise<N8nWorkflowService> {
    logger.info({ src: 'plugin:n8n-workflow:service:main' }, 'Starting N8n Workflow Service...');

    // Validate configuration
    const apiKey = runtime.getSetting('N8N_API_KEY');
    const host = runtime.getSetting('N8N_HOST');

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('N8N_API_KEY is required in settings');
    }

    if (!host || typeof host !== 'string') {
      throw new Error('N8N_HOST is required in settings (e.g., https://your.n8n.cloud)');
    }

    // Get optional pre-configured credentials from character.settings.workflows
    // Note: runtime.getSetting() only returns primitives — nested objects must be read directly
    const workflowSettings = runtime.character?.settings?.workflows as
      | { credentials?: Record<string, string> }
      | undefined;
    const credentials = workflowSettings?.credentials;

    const service = new N8nWorkflowService(runtime);
    service.serviceConfig = {
      apiKey,
      host,
      credentials,
    };

    // Initialize API client
    service.apiClient = new N8nApiClient(host, apiKey);

    logger.info(
      { src: 'plugin:n8n-workflow:service:main' },
      `N8n Workflow Service started - connected to ${host}`
    );
    if (credentials) {
      const configured = Object.entries(credentials)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (configured.length > 0) {
        logger.info(
          { src: 'plugin:n8n-workflow:service:main' },
          `Pre-configured credentials: ${configured.join(', ')}`
        );
      }
    }

    return service;
  }

  override async stop(): Promise<void> {
    logger.info({ src: 'plugin:n8n-workflow:service:main' }, 'Stopping N8n Workflow Service...');
    this.apiClient = null;
    this.serviceConfig = null;
    logger.info({ src: 'plugin:n8n-workflow:service:main' }, 'N8n Workflow Service stopped');
  }

  private injectCatalogClarifications(workflow: N8nWorkflow): void {
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
        { src: 'plugin:n8n-workflow:service:main' },
        `Catalog validation: ${catalogWarnings.join(', ')}`
      );
      const clarifications = catalogWarnings.map((w) => `${w} ${CATALOG_CLARIFICATION_SUFFIX}`);
      workflow._meta.requiresClarification = [...nonCatalog, ...clarifications];
    } else {
      workflow._meta.requiresClarification = nonCatalog.length > 0 ? nonCatalog : undefined;
    }
  }

  private getClient(): N8nApiClient {
    if (!this.apiClient) {
      throw new Error('N8n Workflow Service not initialized');
    }
    return this.apiClient;
  }

  private getConfig(): N8nWorkflowServiceConfig {
    if (!this.serviceConfig) {
      throw new Error('N8n Workflow Service not initialized');
    }
    return this.serviceConfig;
  }

  /**
   * Query the optional `n8n_runtime_context_provider` service for runtime
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
    const raw = this.runtime.getService(N8N_RUNTIME_CONTEXT_PROVIDER_TYPE);
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
          src: 'plugin:n8n-workflow:service:main',
          err: err instanceof Error ? err.message : String(err),
        },
        'RuntimeContextProvider threw — generating without runtime facts'
      );
      return undefined;
    }
  }

  private async searchRelevantNodes(
    prompt: string,
    userId: string
  ): Promise<{ relevantNodes: NodeSearchResult[]; preferredProviders?: string[] }> {
    const earlyContext = await this.fetchRuntimeContext([], userId);
    const preferredProviders = earlyContext?.preferredProviders;
    const keywords = await extractKeywords(this.runtime, prompt, preferredProviders);
    logger.debug(
      { src: 'plugin:n8n-workflow:service:main' },
      `Extracted keywords: ${keywords.join(', ')}${preferredProviders?.length ? ` (with bias: ${preferredProviders.join(', ')})` : ''}`
    );

    const relevantNodes = searchNodes(keywords, 15);
    logger.debug(
      { src: 'plugin:n8n-workflow:service:main' },
      `Found ${relevantNodes.length} relevant nodes`
    );
    if (relevantNodes.length === 0) {
      throw new Error(
        'No relevant n8n nodes found for the given prompt. Please be more specific about the integrations you want to use (e.g., Gmail, Slack, Stripe).'
      );
    }
    return { relevantNodes, preferredProviders };
  }

  private async filterNodesByCredentialSupport(
    prompt: string,
    relevantNodes: NodeSearchResult[]
  ): Promise<NodeSearchResult[]> {
    const rawProvider = this.runtime.getService(N8N_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;
    if (!credProvider?.checkCredentialTypes) return relevantNodes;

    const credTypes = new Set<string>();
    for (const { node } of relevantNodes) {
      for (const cred of node.credentials ?? []) {
        credTypes.add(cred.name);
      }
    }
    if (credTypes.size === 0) return relevantNodes;

    const checkResult = credProvider.checkCredentialTypes([...credTypes]);
    if (checkResult.unsupported.length === 0) return relevantNodes;

    const { remaining, removed } = filterNodesByIntegrationSupport(
      relevantNodes,
      new Set(checkResult.supported)
    );
    const remainingServiceNodes = remaining.filter((r) => r.node.credentials?.length);
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
      { src: 'plugin:n8n-workflow:service:main' },
      `Feasibility OK: ${feasibility.reason}. Proceeding with ${remaining.length} nodes.`
    );
    return remaining;
  }

  private async resolveDraftContext(
    prompt: string,
    opts?: { userId?: string; triggerContext?: TriggerContext }
  ): Promise<{ nodeDefs: NodeDefinition[]; runtimeContext?: RuntimeContext }> {
    const userId = opts?.userId ?? 'local';
    const { relevantNodes } = await this.searchRelevantNodes(prompt, userId);
    const supportedNodes = await this.filterNodesByCredentialSupport(prompt, relevantNodes);
    const nodeDefs = supportedNodes.map((r) => r.node);
    return {
      nodeDefs,
      runtimeContext: await this.fetchRuntimeContext(nodeDefs, userId, opts?.triggerContext),
    };
  }

  private appendRepairErrorsToClarification(
    workflow: N8nWorkflow,
    errors: Array<{
      node: string;
      detail: string;
      availableFields?: string[];
    }>
  ): void {
    workflow._meta = workflow._meta ?? {};
    const errorLines = errors.map(
      (e) =>
        `${e.node}: ${e.detail}${e.availableFields?.length ? ` (available: ${e.availableFields.join(', ')})` : ''}`
    );
    const existing = workflow._meta.requiresClarification ?? [];
    workflow._meta.requiresClarification = [...existing, ...errorLines];
  }

  private async repairWorkflowDraft(
    workflow: N8nWorkflow,
    nodeDefs: NodeDefinition[],
    runtimeContext: RuntimeContext | undefined,
    label = 'generate'
  ): Promise<N8nWorkflow> {
    let repairedWorkflow = workflow;
    const runtimeVersions = (await this.getClient().getRuntimeNodeTypeVersions()) ?? undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const repairResult = validateAndRepair(
        repairedWorkflow,
        nodeDefs,
        runtimeContext,
        runtimeVersions
      );
      repairedWorkflow = repairResult.workflow;
      if (repairResult.errors.length === 0) break;
      if (attempt === 2) {
        logger.warn(
          { src: 'plugin:n8n-workflow:service:main', errors: repairResult.errors },
          `validateAndRepair (${label}): ${repairResult.errors.length} unrecoverable error(s) after 3 retries`
        );
        this.appendRepairErrorsToClarification(repairedWorkflow, repairResult.errors);
        break;
      }
      try {
        repairedWorkflow = await fixWorkflowErrors(
          this.runtime,
          repairedWorkflow,
          repairResult.errors,
          nodeDefs
        );
      } catch (err) {
        logger.warn(
          {
            src: 'plugin:n8n-workflow:service:main',
            err: err instanceof Error ? err.message : String(err),
          },
          `fixWorkflowErrors (${label}) threw — exiting retry loop`
        );
        break;
      }
    }
    return repairedWorkflow;
  }

  private async finalizeWorkflowDraft(
    workflow: N8nWorkflow,
    nodeDefs: NodeDefinition[],
    runtimeContext: RuntimeContext | undefined,
    label = 'generated'
  ): Promise<N8nWorkflow> {
    let finalWorkflow = await this.repairWorkflowDraft(workflow, nodeDefs, runtimeContext, label);
    normalizeTriggerSimpleParam(finalWorkflow);

    const optionFixes = correctOptionParameters(finalWorkflow);
    if (optionFixes > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Corrected ${optionFixes} invalid option parameter(s)`
      );
    }

    const unknownParams = detectUnknownParameters(finalWorkflow);
    if (unknownParams.length > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Found ${unknownParams.length} node(s) with unknown parameters, auto-correcting...`
      );
      finalWorkflow = await correctParameterNames(this.runtime, finalWorkflow, unknownParams);
    }

    const invalidRefs = validateOutputReferences(finalWorkflow);
    if (invalidRefs.length > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Found ${invalidRefs.length} invalid field reference(s), auto-correcting...`
      );
      finalWorkflow = await correctFieldReferences(this.runtime, finalWorkflow, invalidRefs);
    }

    const exprPrefixed = ensureExpressionPrefix(finalWorkflow);
    if (exprPrefixed > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Prefixed ${exprPrefixed} expression value(s) with "="`
      );
    }

    const validationResult = validateWorkflow(finalWorkflow);
    if (!validationResult.valid) {
      logger.error(
        { src: 'plugin:n8n-workflow:service:main' },
        `${label} workflow validation errors: ${validationResult.errors.join(', ')}`
      );
      throw new Error(`${label} workflow is invalid: ${validationResult.errors[0]}`);
    }
    if (validationResult.warnings.length > 0) {
      logger.warn(
        { src: 'plugin:n8n-workflow:service:main' },
        `Validation warnings: ${validationResult.warnings.join(', ')}`
      );
    }

    this.injectCatalogClarifications(finalWorkflow);
    return positionNodes(finalWorkflow);
  }

  async generateWorkflowDraft(
    prompt: string,
    opts?: { userId?: string; triggerContext?: TriggerContext }
  ): Promise<N8nWorkflow> {
    logger.info(
      { src: 'plugin:n8n-workflow:service:main' },
      'Generating workflow draft from prompt'
    );

    const { nodeDefs, runtimeContext } = await this.resolveDraftContext(prompt, opts);
    const workflow = await generateWorkflow(this.runtime, prompt, nodeDefs, runtimeContext);
    logger.debug(
      { src: 'plugin:n8n-workflow:service:main' },
      `Generated workflow with ${workflow.nodes?.length || 0} nodes`
    );

    const injectedCreds = injectMissingCredentialBlocks(workflow, nodeDefs, runtimeContext);
    if (injectedCreds > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Injected ${injectedCreds} missing credentials block(s) (LLM omitted)`
      );
    }

    return this.finalizeWorkflowDraft(workflow, nodeDefs, runtimeContext, 'Generated');
  }

  async modifyWorkflowDraft(
    existingWorkflow: N8nWorkflow,
    modificationRequest: string,
    opts?: { userId?: string; triggerContext?: TriggerContext }
  ): Promise<N8nWorkflow> {
    logger.info(
      { src: 'plugin:n8n-workflow:service:main' },
      `Modifying workflow draft: ${modificationRequest.slice(0, 100)}`
    );

    // Get definitions for nodes already in the workflow
    const existingDefs = collectExistingNodeDefinitions(existingWorkflow);

    // Search for new nodes the modification might need
    const keywords = await extractKeywords(this.runtime, modificationRequest);
    const searchResults = searchNodes(keywords, 10);
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
      { src: 'plugin:n8n-workflow:service:main' },
      `Modify context: ${existingDefs.length} existing + ${newDefs.length} searched → ${combinedDefs.length} unique node defs`
    );

    const runtimeContext = await this.fetchRuntimeContext(
      combinedDefs,
      opts?.userId ?? 'local',
      opts?.triggerContext
    );

    const workflow = await modifyWorkflow(
      this.runtime,
      existingWorkflow,
      modificationRequest,
      combinedDefs,
      runtimeContext
    );

    const injectedCreds = injectMissingCredentialBlocks(workflow, combinedDefs, runtimeContext);
    if (injectedCreds > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Injected ${injectedCreds} missing credentials block(s) on modify (LLM omitted)`
      );
    }

    return this.finalizeWorkflowDraft(workflow, combinedDefs, runtimeContext, 'Modified');
  }

  async deployWorkflow(workflow: N8nWorkflow, userId: string): Promise<WorkflowCreationResult> {
    logger.info(
      { src: 'plugin:n8n-workflow:service:main' },
      `Deploying workflow "${workflow.name}" for user ${userId}`
    );

    const config = this.getConfig();
    const client = this.getClient();

    const credStore = this.runtime.getService(N8N_CREDENTIAL_STORE_TYPE) as unknown as
      | N8nCredentialStoreApi
      | undefined;

    const rawProvider = this.runtime.getService(N8N_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;

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

    // Determine if this is an update (existing workflow) or create (new workflow).
    // If update fails (workflow deleted on n8n), fallback to create.
    let deployedWorkflow;
    let wasUpdate = false;
    if (workflow.id) {
      try {
        deployedWorkflow = await client.updateWorkflow(workflow.id, credentialResult.workflow);
        wasUpdate = true;
      } catch {
        logger.warn(
          { src: 'plugin:n8n-workflow:service:main' },
          `Update failed for workflow ${workflow.id}, creating new workflow instead`
        );
        const { id: _, ...rest } = credentialResult.workflow as unknown as Record<string, unknown>;
        deployedWorkflow = await client.createWorkflow(rest as unknown as N8nWorkflow);
      }
    } else {
      deployedWorkflow = await client.createWorkflow(credentialResult.workflow);
    }

    logger.info(
      { src: 'plugin:n8n-workflow:service:main' },
      `Workflow ${wasUpdate ? 'updated' : 'created'}: ${deployedWorkflow.id}`
    );

    // Activate (publish) the workflow immediately after creation/update
    let active = false;
    try {
      await client.activateWorkflow(deployedWorkflow.id);
      active = true;
      logger.info(
        { src: 'plugin:n8n-workflow:service:main' },
        `Workflow ${deployedWorkflow.id} activated`
      );
    } catch (error) {
      logger.warn(
        { src: 'plugin:n8n-workflow:service:main' },
        `Failed to activate workflow: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Only tag new workflows (existing ones should already have tags)
    if (userId && !wasUpdate) {
      try {
        const userTag = await client.getOrCreateTag(tagName);
        await client.updateWorkflowTags(deployedWorkflow.id, [userTag.id]);
        logger.debug(
          { src: 'plugin:n8n-workflow:service:main' },
          `Tagged workflow ${deployedWorkflow.id} with "${tagName}"`
        );
      } catch (error) {
        logger.warn(
          { src: 'plugin:n8n-workflow:service:main' },
          `Failed to tag workflow: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      id: deployedWorkflow.id,
      name: deployedWorkflow.name,
      active,
      nodeCount: deployedWorkflow.nodes?.length || 0,
      missingCredentials: credentialResult.missingConnections,
    };
  }

  async listWorkflows(userId?: string): Promise<N8nWorkflowResponse[]> {
    const client = this.getClient();

    if (userId) {
      const tagName = await getUserTagName(this.runtime, userId);
      const tagsResponse = await client.listTags();
      const userTag = tagsResponse.data.find((t) => t.name === tagName);

      if (!userTag) {
        return []; // No workflows for this user
      }

      // Get all workflows and filter by tag
      const workflowsResponse = await client.listWorkflows();
      return workflowsResponse.data.filter((w) => w.tags?.some((t) => t.id === userTag.id));
    }

    const response = await client.listWorkflows();
    return response.data;
  }

  async activateWorkflow(workflowId: string): Promise<void> {
    const client = this.getClient();
    await client.activateWorkflow(workflowId);
    logger.info({ src: 'plugin:n8n-workflow:service:main' }, `Workflow ${workflowId} activated`);
  }

  async deactivateWorkflow(workflowId: string): Promise<void> {
    const client = this.getClient();
    await client.deactivateWorkflow(workflowId);
    logger.info({ src: 'plugin:n8n-workflow:service:main' }, `Workflow ${workflowId} deactivated`);
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const client = this.getClient();
    await client.deleteWorkflow(workflowId);
    logger.info({ src: 'plugin:n8n-workflow:service:main' }, `Workflow ${workflowId} deleted`);
  }

  async getWorkflow(workflowId: string): Promise<N8nWorkflowResponse> {
    const client = this.getClient();
    return client.getWorkflow(workflowId);
  }

  async getWorkflowExecutions(workflowId: string, limit?: number): Promise<N8nExecution[]> {
    const client = this.getClient();
    const response = await client.listExecutions({ workflowId, limit });
    return response.data;
  }

  async listExecutions(params?: {
    workflowId?: string;
    status?: 'canceled' | 'error' | 'running' | 'success' | 'waiting';
    limit?: number;
    cursor?: string;
  }): Promise<{ data: N8nExecution[]; nextCursor?: string }> {
    const client = this.getClient();
    return client.listExecutions(params);
  }

  async getExecutionDetail(executionId: string): Promise<N8nExecution> {
    const client = this.getClient();
    return client.getExecution(executionId);
  }
}
