import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  N8nCredentialStoreApi,
  N8nExecution,
  N8nWorkflow,
  N8nWorkflowResponse,
  WorkflowCreationResult,
} from "../types/index";
import {
  isCredentialProvider,
  N8N_CREDENTIAL_PROVIDER_TYPE,
  N8N_CREDENTIAL_STORE_TYPE,
  UnsupportedIntegrationError,
} from "../types/index";
import { N8nApiClient } from "../utils/api";
import { filterNodesByIntegrationSupport, searchNodes } from "../utils/catalog";
import { getUserTagName } from "../utils/context";
import { resolveCredentials } from "../utils/credentialResolver";
import {
  assessFeasibility,
  collectExistingNodeDefinitions,
  extractKeywords,
  generateWorkflow,
  modifyWorkflow,
} from "../utils/generation";
import {
  positionNodes,
  validateNodeInputs,
  validateNodeParameters,
  validateWorkflow,
} from "../utils/workflow";

export const N8N_WORKFLOW_SERVICE_TYPE = "n8n_workflow";

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
    "Generate and deploy n8n workflows from natural language using RAG pipeline. " +
    "Supports workflow CRUD, execution management, and credential resolution.";

  private apiClient: N8nApiClient | null = null;
  private serviceConfig: N8nWorkflowServiceConfig | null = null;

  static async start(runtime: IAgentRuntime): Promise<N8nWorkflowService> {
    logger.info({ src: "plugin:n8n:service:main" }, "Starting N8n Workflow Service...");

    // Validate configuration
    const apiKey = runtime.getSetting("N8N_API_KEY");
    const host = runtime.getSetting("N8N_HOST");

    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("N8N_API_KEY is required in settings");
    }

    if (!host || typeof host !== "string") {
      throw new Error("N8N_HOST is required in settings (e.g., https://your.n8n.cloud)");
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
      { src: "plugin:n8n:service:main" },
      `N8n Workflow Service started - connected to ${host}`
    );
    if (credentials) {
      const configured = Object.entries(credentials)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (configured.length > 0) {
        logger.info(
          { src: "plugin:n8n:service:main" },
          `Pre-configured credentials: ${configured.join(", ")}`
        );
      }
    }

    return service;
  }

  override async stop(): Promise<void> {
    logger.info({ src: "plugin:n8n:service:main" }, "Stopping N8n Workflow Service...");
    this.apiClient = null;
    this.serviceConfig = null;
    logger.info({ src: "plugin:n8n:service:main" }, "N8n Workflow Service stopped");
  }

  private injectCatalogClarifications(workflow: N8nWorkflow): void {
    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);
    const catalogWarnings = [...paramWarnings, ...inputWarnings];

    if (!workflow._meta) {
      workflow._meta = {};
    }

    // Strip previous catalog-derived clarifications to avoid stale duplicates
    // across regeneration cycles (generate → modify → modify).
    const CATALOG_SUFFIX = "— please provide this value or clarify your requirements";
    const nonCatalog = (workflow._meta.requiresClarification || []).filter(
      (c) => !c.endsWith(CATALOG_SUFFIX)
    );

    if (catalogWarnings.length > 0) {
      logger.warn(
        { src: "plugin:n8n:service:main" },
        `Catalog validation: ${catalogWarnings.join(", ")}`
      );
      const clarifications = catalogWarnings.map((w) => `${w} ${CATALOG_SUFFIX}`);
      workflow._meta.requiresClarification = [...nonCatalog, ...clarifications];
    } else {
      workflow._meta.requiresClarification = nonCatalog.length > 0 ? nonCatalog : undefined;
    }
  }

  private getClient(): N8nApiClient {
    if (!this.apiClient) {
      throw new Error("N8n Workflow Service not initialized");
    }
    return this.apiClient;
  }

  private getConfig(): N8nWorkflowServiceConfig {
    if (!this.serviceConfig) {
      throw new Error("N8n Workflow Service not initialized");
    }
    return this.serviceConfig;
  }

  async generateWorkflowDraft(prompt: string): Promise<N8nWorkflow> {
    logger.info(
      { src: "plugin:n8n:service:main" },
      "Generating workflow draft from prompt"
    );

    const keywords = await extractKeywords(this.runtime, prompt);
    logger.debug(
      { src: "plugin:n8n:service:main" },
      `Extracted keywords: ${keywords.join(", ")}`
    );

    let relevantNodes = searchNodes(keywords, 15);
    logger.debug(
      { src: "plugin:n8n:service:main" },
      `Found ${relevantNodes.length} relevant nodes`
    );

    if (relevantNodes.length === 0) {
      throw new Error(
        "No relevant n8n nodes found for the given prompt. Please be more specific about the integrations you want to use (e.g., Gmail, Slack, Stripe)."
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
            { src: "plugin:n8n:service:main" },
            `Feasibility OK: ${feasibility.reason}. Proceeding with ${remaining.length} nodes.`
          );
          relevantNodes = remaining;
        }
      }
    }
    // ── End integration check ──

    const workflow = await generateWorkflow(
      this.runtime,
      prompt,
      relevantNodes.map((r) => r.node)
    );
    logger.debug(
      { src: "plugin:n8n:service:main" },
      `Generated workflow with ${workflow.nodes?.length || 0} nodes`
    );

    const validationResult = validateWorkflow(workflow);
    if (!validationResult.valid) {
      logger.error(
        { src: "plugin:n8n:service:main" },
        `Validation errors: ${validationResult.errors.join(", ")}`
      );
      throw new Error(`Generated workflow is invalid: ${validationResult.errors[0]}`);
    }
    if (validationResult.warnings.length > 0) {
      logger.warn(
        { src: "plugin:n8n:service:main" },
        `Validation warnings: ${validationResult.warnings.join(", ")}`
      );
    }

    this.injectCatalogClarifications(workflow);
    return positionNodes(workflow);
  }

  async modifyWorkflowDraft(
    existingWorkflow: N8nWorkflow,
    modificationRequest: string
  ): Promise<N8nWorkflow> {
    logger.info(
      { src: "plugin:n8n:service:main" },
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
      { src: "plugin:n8n:service:main" },
      `Modify context: ${existingDefs.length} existing + ${newDefs.length} searched → ${combinedDefs.length} unique node defs`
    );

    const workflow = await modifyWorkflow(
      this.runtime,
      existingWorkflow,
      modificationRequest,
      combinedDefs
    );

    const validationResult = validateWorkflow(workflow);
    if (!validationResult.valid) {
      logger.error(
        { src: "plugin:n8n:service:main" },
        `Modified workflow validation errors: ${validationResult.errors.join(", ")}`
      );
      throw new Error(`Modified workflow is invalid: ${validationResult.errors[0]}`);
    }

    this.injectCatalogClarifications(workflow);
    return positionNodes(workflow);
  }

  async deployWorkflow(workflow: N8nWorkflow, userId: string): Promise<WorkflowCreationResult> {
    logger.info(
      { src: "plugin:n8n:service:main" },
      `Deploying workflow "${workflow.name}" for user ${userId}`
    );

    const config = this.getConfig();
    const client = this.getClient();

    const credStore = this.runtime.getService(N8N_CREDENTIAL_STORE_TYPE) as unknown as
      | N8nCredentialStoreApi
      | undefined;

    const rawProvider = this.runtime.getService(N8N_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;

    const credentialResult = await resolveCredentials(
      workflow,
      userId,
      config,
      credStore ?? null,
      credProvider,
      client
    );

    // Block deploy if any credential is unresolved
    if (credentialResult.missingConnections.length > 0) {
      return {
        id: "",
        name: workflow.name,
        active: false,
        nodeCount: workflow.nodes.length,
        missingCredentials: credentialResult.missingConnections,
      };
    }

    const createdWorkflow = await client.createWorkflow(credentialResult.workflow);

    // Activate (publish) the workflow immediately after creation
    let active = false;
    try {
      await client.activateWorkflow(createdWorkflow.id);
      active = true;
      logger.info(
        { src: "plugin:n8n:service:main" },
        `Workflow ${createdWorkflow.id} activated`
      );
    } catch (error) {
      logger.warn(
        { src: "plugin:n8n:service:main" },
        `Failed to activate workflow: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (userId) {
      try {
        const tagName = await getUserTagName(this.runtime, userId);
        const userTag = await client.getOrCreateTag(tagName);
        await client.updateWorkflowTags(createdWorkflow.id, [userTag.id]);
        logger.debug(
          { src: "plugin:n8n:service:main" },
          `Tagged workflow ${createdWorkflow.id} with "${tagName}"`
        );
      } catch (error) {
        logger.warn(
          { src: "plugin:n8n:service:main" },
          `Failed to tag workflow: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    logger.info(
      { src: "plugin:n8n:service:main" },
      `Workflow created successfully: ${createdWorkflow.id}`
    );

    return {
      id: createdWorkflow.id,
      name: createdWorkflow.name,
      active,
      nodeCount: createdWorkflow.nodes?.length || 0,
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
    logger.info({ src: "plugin:n8n:service:main" }, `Workflow ${workflowId} activated`);
  }

  async deactivateWorkflow(workflowId: string): Promise<void> {
    const client = this.getClient();
    await client.deactivateWorkflow(workflowId);
    logger.info({ src: "plugin:n8n:service:main" }, `Workflow ${workflowId} deactivated`);
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const client = this.getClient();
    await client.deleteWorkflow(workflowId);
    logger.info({ src: "plugin:n8n:service:main" }, `Workflow ${workflowId} deleted`);
  }

  async getWorkflowExecutions(workflowId: string, limit?: number): Promise<N8nExecution[]> {
    const client = this.getClient();
    const response = await client.listExecutions({ workflowId, limit });
    return response.data;
  }

  async getExecutionDetail(executionId: string): Promise<N8nExecution> {
    const client = this.getClient();
    return client.getExecution(executionId);
  }
}
