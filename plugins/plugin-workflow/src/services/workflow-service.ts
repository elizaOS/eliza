/**
 * Chat-facing facade for authoring, searching, deploying, and inspecting native
 * Smithers workflows. Generation uses the selected elizaOS model and produces
 * the same source contract the editor saves; execution remains in the embedded
 * Smithers service behind elizaOS APIs.
 */
import { type IAgentRuntime, ModelType, Service } from '@elizaos/core';
import type {
  TriggerContext,
  WorkflowCreationResult,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
  WorkflowRevision,
} from '../types/index';
import { WorkflowApiError } from '../types/index';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
  type ExecuteWorkflowOptions,
} from './embedded-workflow-service';
import { validateSmithersSource } from './smithers-runtime';

export const WORKFLOW_SERVICE_TYPE = 'workflow';

export interface WorkflowServiceConfig extends Record<string, string> {
  host: 'eliza-cloud';
  backend: 'smthrs';
}

export interface WorkflowGenerationOptions {
  userId: string;
  triggerContext?: TriggerContext;
  existingWorkflow?: WorkflowDefinitionResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value = JSON.parse(trimmed);
    if (isRecord(value)) return value;
  } catch {
    // error-policy:J3 the fallback below extracts one explicitly-delimited JSON object.
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(trimmed.slice(start, end + 1));
      if (isRecord(value)) return value;
    } catch {
      // error-policy:J3 an invalid model response becomes a visible generation error.
    }
  }
  throw new WorkflowApiError('The model did not return a valid Smithers workflow object', 502);
}

function asWorkflow(value: Record<string, unknown>): WorkflowDefinition {
  if (
    typeof value.name !== 'string' ||
    typeof value.source !== 'string' ||
    (value.language !== 'tsx' && value.language !== 'typescript')
  ) {
    throw new WorkflowApiError('Generated workflow is missing name, language, or source', 502);
  }
  const workflow = value as unknown as WorkflowDefinition;
  validateSmithersSource(workflow.source);
  return workflow;
}

function generationPrompt(instruction: string, context: WorkflowGenerationOptions): string {
  const existing = context.existingWorkflow
    ? `\nExisting workflow to revise:\n${JSON.stringify(context.existingWorkflow, null, 2)}`
    : '';
  const trigger = context.triggerContext
    ? `\nConversation routing context:\n${JSON.stringify(context.triggerContext, null, 2)}`
    : '';
  return `You are the Smithers workflow author inside elizaOS.

Create a production-ready native Smithers workflow for this request:
${instruction}
${trigger}${existing}

Return one JSON object with exactly these top-level fields:
- name: concise string
- description: useful string
- language: "tsx"
- source: the complete executable TSX module as a JSON string
- inputSchema: JSON Schema object
- steps: ordered array of {id,label,kind,dependsOn?,description?,agent?}
- widgets: array of {id,title,description?,surface,component,dataPath?,actions?}
- schedule: optional {cron,timezone,enabled}

Source contract:
- Import createSmithers from "smthrs/create", other public APIs from supported smthrs subpaths, and schemas from "zod".
- Start with /** @jsxImportSource smthrs */.
- Use createSmithers schemas and pass { dbPath: process.env.ELIZA_SMTHRS_DB_PATH }.
- Default-export the result of smithers(...).
- Use globalThis.__elizaSmithers.agent for every Task agent so all inference is routed through elizaOS Cloud. Never instantiate OpenAI, Anthropic, Claude, Codex, or Gateway clients.
- Use Smithers Workflow, Task, Sequence, Parallel, Branch, Loop, Approval, Signal, Timer, UI, and TUI primitives as appropriate.
- Make Task ids stable and identical to ids in steps.
- Include a UI component and widget manifest when the workflow has useful interactive output.
- Do not use Smithers Gateway, gateway-react, gateway-ui, HTTP calls to a Smithers server, n8n concepts, node catalogs, or legacy Smithers package names.
- Do not use placeholders for the workflow logic. The module must run.

Return JSON only.`;
}

export class WorkflowService extends Service {
  static override readonly serviceType = WORKFLOW_SERVICE_TYPE;
  override capabilityDescription =
    'Chat authoring and elizaOS Cloud API facade for native Smithers workflows.';
  readonly config: WorkflowServiceConfig = { host: 'eliza-cloud', backend: 'smthrs' };

  static async start(runtime: IAgentRuntime): Promise<WorkflowService> {
    return new WorkflowService(runtime);
  }

  override async stop(): Promise<void> {}

  private embedded(): EmbeddedWorkflowService {
    const service = this.runtime.getService<EmbeddedWorkflowService>(
      EMBEDDED_WORKFLOW_SERVICE_TYPE
    );
    if (!service) throw new WorkflowApiError('Smithers workflow runtime is unavailable', 503);
    return service;
  }

  async generateWorkflowDraft(
    instruction: string,
    options: { userId: string; triggerContext?: TriggerContext }
  ): Promise<WorkflowDefinition> {
    if (!instruction.trim()) throw new WorkflowApiError('Workflow instruction is required', 400);
    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: generationPrompt(instruction, options),
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
    });
    return asWorkflow(parseJsonObject(response));
  }

  async modifyWorkflowDraft(
    workflow: WorkflowDefinitionResponse,
    instruction: string,
    options: { userId: string; triggerContext?: TriggerContext }
  ): Promise<WorkflowDefinition> {
    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: generationPrompt(instruction, { ...options, existingWorkflow: workflow }),
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
    });
    return asWorkflow(parseJsonObject(response));
  }

  async deployWorkflow(
    workflow: WorkflowDefinition,
    _ownerEntityId: string,
    options: { activate?: boolean } = {}
  ): Promise<WorkflowCreationResult> {
    const deployed = workflow.id
      ? await this.embedded().updateWorkflow(workflow.id, workflow)
      : await this.embedded().createWorkflow({
          ...workflow,
          active: options.activate ?? workflow.active ?? false,
        });
    if (options.activate === true && !deployed.active)
      await this.embedded().activateWorkflow(deployed.id);
    if (options.activate === false && deployed.active)
      await this.embedded().deactivateWorkflow(deployed.id);
    return {
      id: deployed.id,
      name: deployed.name,
      active: options.activate ?? deployed.active ?? false,
      stepCount: deployed.steps?.length ?? 0,
    };
  }

  async listWorkflows(_ownerEntityId?: string): Promise<WorkflowDefinitionResponse[]> {
    return (await this.embedded().listWorkflows()).data;
  }

  async searchWorkflows(
    query: string,
    ownerEntityId?: string
  ): Promise<WorkflowDefinitionResponse[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const workflows = await this.listWorkflows(ownerEntityId);
    return workflows
      .map((workflow) => {
        const haystack =
          `${workflow.name} ${workflow.description ?? ''} ${(workflow.tags ?? []).map((tag) => tag.name).join(' ')}`.toLowerCase();
        return {
          workflow,
          score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0),
        };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ workflow }) => workflow);
  }

  async getWorkflow(id: string, _ownerEntityId?: string): Promise<WorkflowDefinitionResponse> {
    return this.embedded().getWorkflow(id);
  }

  async updateWorkflow(
    id: string,
    workflow: WorkflowDefinition,
    _ownerEntityId?: string
  ): Promise<WorkflowDefinitionResponse> {
    return this.embedded().updateWorkflow(id, workflow);
  }

  async deleteWorkflow(id: string, _ownerEntityId?: string): Promise<void> {
    return this.embedded().deleteWorkflow(id);
  }

  async activateWorkflow(id: string, _ownerEntityId?: string): Promise<WorkflowDefinitionResponse> {
    return this.embedded().activateWorkflow(id);
  }

  async deactivateWorkflow(
    id: string,
    _ownerEntityId?: string
  ): Promise<WorkflowDefinitionResponse> {
    return this.embedded().deactivateWorkflow(id);
  }

  async startWorkflow(
    id: string,
    options: ExecuteWorkflowOptions = {}
  ): Promise<WorkflowExecution> {
    return this.embedded().startWorkflow(id, options);
  }

  async executeWorkflow(
    id: string,
    options: ExecuteWorkflowOptions = {}
  ): Promise<WorkflowExecution> {
    return this.embedded().executeWorkflow(id, options);
  }

  async getWorkflowExecutions(
    id: string,
    limit = 20,
    _ownerEntityId?: string
  ): Promise<WorkflowExecution[]> {
    return (await this.embedded().listExecutions({ workflowId: id, limit })).data;
  }

  async listExecutions(
    params: { workflowId?: string; limit?: number } = {},
    _ownerEntityId?: string
  ): Promise<{ data: WorkflowExecution[] }> {
    return this.embedded().listExecutions(params);
  }

  async getExecutionDetail(id: string, _ownerEntityId?: string): Promise<WorkflowExecution> {
    return this.embedded().getExecution(id);
  }

  async cancelExecution(id: string, _ownerEntityId?: string): Promise<WorkflowExecution> {
    return this.embedded().cancelExecution(id);
  }

  async decideApproval(
    runId: string,
    nodeId: string,
    iteration: number,
    approved: boolean,
    options: { note?: string; decidedBy?: string; decision?: unknown } = {}
  ): Promise<WorkflowExecution> {
    return this.embedded().decideApproval(runId, nodeId, iteration, approved, options);
  }

  async signalExecution(
    runId: string,
    signal: string,
    payload: unknown,
    receivedBy?: string
  ): Promise<WorkflowExecution> {
    return this.embedded().signalExecution(runId, signal, payload, receivedBy);
  }

  async getWorkflowRevisions(
    id: string,
    limit = 20,
    _ownerEntityId?: string
  ): Promise<WorkflowRevision[]> {
    return (await this.embedded().listWorkflowRevisions(id, limit)).data;
  }

  async restoreWorkflowRevision(
    id: string,
    versionId: string,
    _ownerEntityId?: string
  ): Promise<WorkflowDefinitionResponse> {
    return this.embedded().restoreWorkflowRevision(id, versionId);
  }

  async getWorkflowEvaluationSuite(
    id: string,
    limit = 20,
    ownerEntityId?: string
  ): Promise<Record<string, unknown>> {
    const workflow = await this.getWorkflow(id, ownerEntityId);
    const executions = await this.getWorkflowExecutions(id, limit, ownerEntityId);
    return {
      workflowId: id,
      workflowName: workflow.name,
      workflowVersionId: workflow.versionId,
      generatedAt: new Date().toISOString(),
      sampleCount: executions.length,
      samples: executions.map((execution) => ({
        executionId: execution.id,
        input: execution.input,
        output: execution.output,
        status: execution.status,
        passed: execution.status === 'finished',
      })),
      optimizer: { engine: 'smthrs', recommendedCommand: `bunx smthrs eval <workflow.tsx>` },
    };
  }
}
