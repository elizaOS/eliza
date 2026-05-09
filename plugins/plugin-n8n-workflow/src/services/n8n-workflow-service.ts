import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import { peekN8nSidecar } from '@elizaos/app-core/services/n8n-sidecar';
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
 * Probe a candidate API key against `${host}/api/v1/workflows?limit=1`.
 * Returns true on 2xx, false on 401/403/network error.
 */
async function probeApiKey(host: string, key: string): Promise<boolean> {
  try {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/v1/workflows?limit=1`, {
      method: 'GET',
      headers: { 'X-N8N-API-KEY': key },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick the API key the workflow service should use.
 *
 * The local n8n sidecar provisions a fresh API key at every boot and
 * persists it under `${stateDir}/api-key` (see
 * `@elizaos/app-core/services/n8n-sidecar`). The plugin's settings
 * `N8N_API_KEY` is read from `.env` / config and can drift independently
 * — e.g. a previous sidecar instance was reset, or the user copied a key
 * from a stale install. When both are set but disagree, the env value
 * wins by default and every deploy gets 401 from n8n until someone
 * rewrites `.env` by hand.
 *
 * Resolution order:
 *   1. If a sidecar service is registered AND has provisioned a key, prefer
 *      that key — it is the freshest and is rotated by the sidecar itself.
 *   2. Otherwise fall back to the env / config value.
 *   3. If the chosen candidate fails a probe but the other candidate
 *      passes, use the working one.
 *   4. If both fail (or only one is present and it fails), return the
 *      best-available so the existing failure path produces a real
 *      diagnostic instead of a missing-config error.
 *
 * Returns null only when no candidates exist at all.
 */
export async function resolveN8nApiKey(
  host: string,
  envKey: string | null,
  deps: {
    getSidecarKey?: () => string | null;
    probe?: (host: string, key: string) => Promise<boolean>;
  } = {},
): Promise<string | null> {
  const getSidecarKey = deps.getSidecarKey ?? (() => peekN8nSidecar()?.getApiKey() ?? null);
  const probe = deps.probe ?? probeApiKey;

  const sidecarKey = getSidecarKey();

  if (!sidecarKey && !envKey) return null;

  // Single-candidate fast path: nothing to disambiguate.
  if (!envKey && sidecarKey) return sidecarKey;
  if (!sidecarKey && envKey) return envKey;

  // Both present. Prefer the sidecar key, but fall through to env if it
  // does not validate (e.g. sidecar still provisioning, or its host
  // differs from the configured N8N_HOST so the cached key doesn't apply).
  if (sidecarKey && (await probe(host, sidecarKey))) {
    if (envKey && envKey !== sidecarKey) {
      logger.info(
        { src: 'plugin:n8n-workflow:service:main' },
        'Using sidecar-provisioned N8N_API_KEY; the env-configured key did not match',
      );
    }
    return sidecarKey;
  }
  if (envKey && (await probe(host, envKey))) {
    return envKey;
  }
  // Neither validated. Return the sidecar key if we have it (it is the
  // canonical source); otherwise fall back to env so the upstream error
  // has *something* to report.
  return sidecarKey ?? envKey;
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
    const host = runtime.getSetting('N8N_HOST');
    if (!host || typeof host !== 'string') {
      throw new Error('N8N_HOST is required in settings (e.g., https://your.n8n.cloud)');
    }

    const envKeySetting = runtime.getSetting('N8N_API_KEY');
    const envKey =
      typeof envKeySetting === 'string' && envKeySetting.length > 0 ? envKeySetting : null;
    const apiKey = await resolveN8nApiKey(host, envKey);
    if (!apiKey) {
      throw new Error('N8N_API_KEY is required in settings');
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
    // Live-refresh from the sidecar. The plugin's service typically starts
    // BEFORE the n8n autostart provisions its API key, so the start-time
    // resolver may have fallen back to the env value when no sidecar key
    // was registered yet. Once the sidecar is ready, prefer its key — it
    // is the freshest and is rotated by the sidecar itself. peekN8nSidecar
    // is O(1); getApiKey returns a cached string, so this is microsecond
    // overhead per request.
    const sidecarKey = peekN8nSidecar()?.getApiKey();
    if (sidecarKey) {
      this.apiClient.setApiKey(sidecarKey);
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

  async generateWorkflowDraft(
    prompt: string,
    opts?: { userId?: string; triggerContext?: TriggerContext }
  ): Promise<N8nWorkflow> {
    logger.info(
      { src: 'plugin:n8n-workflow:service:main' },
      'Generating workflow draft from prompt'
    );

    // Fetch host-supplied bias hints early (before keyword extraction) so the
    // LLM is told which providers the host already knows it can satisfy.
    // We pass empty `relevantNodes` / `relevantCredTypes` here because we do
    // not yet have searchNodes results — `preferredProviders` is derived from
    // the host's connector config alone (independent of node search). The
    // full runtime context (with credentials + facts) is fetched again later
    // once we have the filtered node list.
    const earlyContext = await this.fetchRuntimeContext([], opts?.userId ?? 'local');
    const preferredProviders = earlyContext?.preferredProviders;

    const keywords = await extractKeywords(this.runtime, prompt, preferredProviders);
    logger.debug(
      { src: 'plugin:n8n-workflow:service:main' },
      `Extracted keywords: ${keywords.join(', ')}${preferredProviders?.length ? ` (with bias: ${preferredProviders.join(', ')})` : ''}`
    );

    let relevantNodes = searchNodes(keywords, 15);
    logger.debug(
      { src: 'plugin:n8n-workflow:service:main' },
      `Found ${relevantNodes.length} relevant nodes`
    );

    if (relevantNodes.length === 0) {
      throw new Error(
        'No relevant n8n nodes found for the given prompt. Please be more specific about the integrations you want to use (e.g., Gmail, Slack, Stripe).'
      );
    }

    // ── Integration availability check ──
    const rawProvider = this.runtime.getService(N8N_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;

    if (credProvider?.checkCredentialTypes) {
      const credTypes = new Set<string>();
      for (const { node } of relevantNodes) {
        for (const cred of node.credentials ?? []) {
          credTypes.add(cred.name);
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
      { src: 'plugin:n8n-workflow:service:main' },
      `Generated workflow with ${workflow.nodes?.length || 0} nodes`
    );

    // Safety net: even with the MANDATORY INVARIANT prompt rule, the LLM
    // sometimes omits the `credentials` block on credentialed nodes. Inject
    // it deterministically based on the node's catalog definition + the
    // host's supported cred types so resolveCredentials can mint the
    // credential server-side instead of falling back to a manual UI step.
    const injectedCreds = injectMissingCredentialBlocks(workflow, finalNodeDefs, runtimeContext);
    if (injectedCreds > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
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
    // Fetch the live n8n runtime's node-type registry once per deploy so
    // typeVersion clamping intersects catalog ∩ runtime — necessary
    // because the bundled `defaultNodes.json` can be ahead of the user's
    // actually-installed n8n binary (e.g. catalog says Gmail v2.2 but
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
            src: 'plugin:n8n-workflow:service:main',
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
          finalNodeDefs
        );
      } catch (err) {
        logger.warn(
          {
            src: 'plugin:n8n-workflow:service:main',
            err: err instanceof Error ? err.message : String(err),
          },
          'fixWorkflowErrors threw — exiting retry loop'
        );
        break;
      }
    }

    normalizeTriggerSimpleParam(workflow);

    const optionFixes = correctOptionParameters(workflow);
    if (optionFixes > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Corrected ${optionFixes} invalid option parameter(s)`
      );
    }

    const unknownParams = detectUnknownParameters(workflow);
    if (unknownParams.length > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Found ${unknownParams.length} node(s) with unknown parameters, auto-correcting...`
      );
      workflow = await correctParameterNames(this.runtime, workflow, unknownParams);
    }

    const invalidRefs = validateOutputReferences(workflow);
    if (invalidRefs.length > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Found ${invalidRefs.length} invalid field reference(s), auto-correcting...`
      );
      workflow = await correctFieldReferences(this.runtime, workflow, invalidRefs);
    }

    const exprPrefixed = ensureExpressionPrefix(workflow);
    if (exprPrefixed > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Prefixed ${exprPrefixed} expression value(s) with "="`
      );
    }

    const validationResult = validateWorkflow(workflow);
    if (!validationResult.valid) {
      logger.error(
        { src: 'plugin:n8n-workflow:service:main' },
        `Validation errors: ${validationResult.errors.join(', ')}`
      );
      throw new Error(`Generated workflow is invalid: ${validationResult.errors[0]}`);
    }
    if (validationResult.warnings.length > 0) {
      logger.warn(
        { src: 'plugin:n8n-workflow:service:main' },
        `Validation warnings: ${validationResult.warnings.join(', ')}`
      );
    }

    this.injectCatalogClarifications(workflow);
    return positionNodes(workflow);
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
        { src: 'plugin:n8n-workflow:service:main' },
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
            src: 'plugin:n8n-workflow:service:main',
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
          combinedDefs
        );
      } catch (err) {
        logger.warn(
          {
            src: 'plugin:n8n-workflow:service:main',
            err: err instanceof Error ? err.message : String(err),
          },
          'fixWorkflowErrors (modify) threw — exiting retry loop'
        );
        break;
      }
    }

    normalizeTriggerSimpleParam(workflow);

    const optionFixes = correctOptionParameters(workflow);
    if (optionFixes > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Corrected ${optionFixes} invalid option parameter(s) in modified workflow`
      );
    }

    const unknownParams = detectUnknownParameters(workflow);
    if (unknownParams.length > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Found ${unknownParams.length} node(s) with unknown parameters in modified workflow, auto-correcting...`
      );
      workflow = await correctParameterNames(this.runtime, workflow, unknownParams);
    }

    const invalidRefs = validateOutputReferences(workflow);
    if (invalidRefs.length > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Found ${invalidRefs.length} invalid field reference(s) in modified workflow, auto-correcting...`
      );
      workflow = await correctFieldReferences(this.runtime, workflow, invalidRefs);
    }

    const exprPrefixed = ensureExpressionPrefix(workflow);
    if (exprPrefixed > 0) {
      logger.debug(
        { src: 'plugin:n8n-workflow:service:main' },
        `Prefixed ${exprPrefixed} expression value(s) with "=" in modified workflow`
      );
    }

    const validationResult = validateWorkflow(workflow);
    if (!validationResult.valid) {
      logger.error(
        { src: 'plugin:n8n-workflow:service:main' },
        `Modified workflow validation errors: ${validationResult.errors.join(', ')}`
      );
      throw new Error(`Modified workflow is invalid: ${validationResult.errors[0]}`);
    }

    this.injectCatalogClarifications(workflow);
    return positionNodes(workflow);
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
