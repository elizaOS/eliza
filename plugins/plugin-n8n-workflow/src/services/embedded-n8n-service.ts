import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypes,
  IWorkflowExecuteAdditionalData,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import type {
  N8nCredential,
  N8nExecution,
  N8nTag,
  N8nWorkflow,
  N8nWorkflowResponse,
} from '../types/index';
import { N8nApiError } from '../types/index';

export const N8N_EMBEDDED_SERVICE_TYPE = 'n8n_embedded_workflow';

type N8nCoreRuntime = typeof import('n8n-core');
type N8nWorkflowRuntime = typeof import('n8n-workflow');

interface EmbeddedRuntimeModules {
  core: N8nCoreRuntime;
  workflow: N8nWorkflowRuntime;
}

interface StoredCredential extends N8nCredential {
  data?: Record<string, unknown>;
}

interface ScheduleHandle {
  workflowId: string;
  timer: ReturnType<typeof setInterval>;
}

interface ExecuteOptions {
  mode?: WorkflowExecuteMode;
}

const N8N_CORE_PACKAGE = 'n8n-core';
const N8N_WORKFLOW_PACKAGE = 'n8n-workflow';
const EMBEDDED_HOST = 'embedded://local';
const DEFAULT_SCHEDULE_INTERVAL_MS = 60_000;

let loadedModules: Promise<EmbeddedRuntimeModules> | null = null;

async function loadN8nRuntime(): Promise<EmbeddedRuntimeModules> {
  if (!loadedModules) {
    loadedModules = (async () => {
      try {
        const [core, workflow] = await Promise.all([
          import(N8N_CORE_PACKAGE),
          import(N8N_WORKFLOW_PACKAGE),
        ]);
        return { core, workflow };
      } catch (importError) {
        // Node ESM currently trips over n8n-workflow's extensionless ESM
        // internals. Bun handles it, but the CJS condition is a safe fallback
        // for tests/tools that run this plugin under Node.
        const require = createRequire(import.meta.url);
        try {
          return {
            core: require(N8N_CORE_PACKAGE) as N8nCoreRuntime,
            workflow: require(N8N_WORKFLOW_PACKAGE) as N8nWorkflowRuntime,
          };
        } catch (requireError) {
          throw new Error(
            `Failed to load embedded n8n runtime: ${
              requireError instanceof Error
                ? requireError.message
                : importError instanceof Error
                  ? importError.message
                  : String(requireError)
            }`
          );
        }
      }
    })();
  }
  return loadedModules;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeWorkflowPayload(workflow: N8nWorkflow, id: string, active: boolean): N8nWorkflow {
  return {
    ...cloneJson(workflow),
    id,
    active,
    settings: {
      executionOrder: 'v1',
      ...(workflow.settings ?? {}),
    },
  };
}

function responseFromWorkflow(
  workflow: N8nWorkflow,
  createdAt: string,
  updatedAt: string,
  versionId: string
): N8nWorkflowResponse {
  return {
    ...cloneJson(workflow),
    id: workflow.id ?? randomUUID(),
    createdAt,
    updatedAt,
    versionId,
  };
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveScheduleIntervalMs(parameters: Record<string, unknown>): number {
  const explicitMs = readNumber(parameters.intervalMs, NaN);
  if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;

  const explicitSeconds = readNumber(parameters.intervalSeconds, NaN);
  if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) return explicitSeconds * 1000;

  const rule = isRecord(parameters.rule) ? parameters.rule : null;
  const intervals = Array.isArray(rule?.interval) ? rule.interval : [];
  const first = intervals.find(isRecord);
  if (!first) return DEFAULT_SCHEDULE_INTERVAL_MS;

  const unit = readString(first.field, 'minutes');
  if (unit === 'seconds') return readNumber(first.secondsInterval, 60) * 1000;
  if (unit === 'minutes') return readNumber(first.minutesInterval, 1) * 60_000;
  if (unit === 'hours') return readNumber(first.hoursInterval, 1) * 3_600_000;
  if (unit === 'days') return readNumber(first.daysInterval, 1) * 86_400_000;

  return DEFAULT_SCHEDULE_INTERVAL_MS;
}

function normalizeHeaderEntries(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== 'undefined') headers[key] = String(headerValue);
    }
    return headers;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = readString(entry.name, '');
      if (name) headers[name] = String(entry.value ?? '');
    }
  }
  return headers;
}

function collectParametersList(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = readString(entry.name, '');
      if (name) out[name] = entry.value ?? '';
    }
  }
  return out;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function createScheduleTriggerNode(): INodeType {
  return {
    description: {
      displayName: 'Schedule Trigger',
      name: 'n8n-nodes-base.scheduleTrigger',
      group: ['trigger'],
      version: [1, 1.1, 1.2],
      description: 'Starts the workflow on a schedule.',
      defaults: { name: 'Schedule Trigger' },
      inputs: [],
      outputs: ['main'] as never,
      properties: [],
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      return [
        [
          {
            json: {
              firedAt: new Date().toISOString(),
              trigger: 'schedule',
            },
          },
        ],
      ];
    },
    async trigger() {
      return {};
    },
  };
}

function createSetNode(): INodeType {
  return {
    description: {
      displayName: 'Edit Fields (Set)',
      name: 'n8n-nodes-base.set',
      group: ['transform'],
      version: [1, 2, 3, 3.1, 3.2, 3.3, 3.4],
      description: 'Sets values on the current item.',
      defaults: { name: 'Edit Fields' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        {
          displayName: 'Include Other Fields',
          name: 'includeOtherFields',
          type: 'boolean',
          default: true,
        },
        {
          displayName: 'Assignments',
          name: 'assignments',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              displayName: 'Assignment',
              name: 'assignments',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Value', name: 'value', type: 'string', default: '' },
              ],
            },
          ],
        },
        {
          displayName: 'Values',
          name: 'values',
          type: 'json',
          default: {},
        },
        {
          displayName: 'Fields',
          name: 'fields',
          type: 'json',
          default: {},
        },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
      const output: INodeExecutionData[] = [];
      const nodeParameters = this.getNode().parameters as Record<string, unknown>;

      for (let itemIndex = 0; itemIndex < sourceItems.length; itemIndex++) {
        const includeOtherFields = nodeParameters.includeOtherFields !== false;
        const base: Record<string, unknown> = includeOtherFields
          ? { ...(sourceItems[itemIndex]?.json ?? {}) }
          : {};

        const assignmentContainer = isRecord(nodeParameters.assignments)
          ? nodeParameters.assignments
          : {};
        const assignments = Array.isArray(assignmentContainer.assignments)
          ? (assignmentContainer.assignments as Array<{ name?: unknown; value?: unknown }>)
          : [];
        for (const assignment of assignments) {
          const name = readString(assignment.name, '');
          if (name) base[name] = assignment.value;
        }

        const values = isRecord(nodeParameters.values) ? nodeParameters.values : {};
        for (const group of Object.values(values)) {
          if (!Array.isArray(group)) continue;
          for (const entry of group) {
            if (!isRecord(entry)) continue;
            const name = readString(entry.name, '');
            if (name) base[name] = entry.value;
          }
        }

        const fields = isRecord(nodeParameters.fields) ? nodeParameters.fields : {};
        if (isRecord(fields)) {
          Object.assign(base, fields);
        }

        output.push({
          json: base as INodeExecutionData['json'],
          pairedItem: { item: itemIndex },
        });
      }

      return [output];
    },
  };
}

function createHttpRequestNode(): INodeType {
  return {
    description: {
      displayName: 'HTTP Request',
      name: 'n8n-nodes-base.httpRequest',
      group: ['output'],
      version: [1, 2, 3, 4, 4.1, 4.2],
      description: 'Makes an HTTP request.',
      defaults: { name: 'HTTP Request' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        {
          displayName: 'Method',
          name: 'method',
          type: 'options',
          default: 'GET',
          options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => ({
            name: method,
            value: method,
          })),
        },
        {
          displayName: 'URL',
          name: 'url',
          type: 'string',
          default: '',
        },
        {
          displayName: 'Headers',
          name: 'headers',
          type: 'json',
          default: {},
        },
        {
          displayName: 'Header Parameters',
          name: 'headerParameters',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              displayName: 'Parameter',
              name: 'parameters',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Value', name: 'value', type: 'string', default: '' },
              ],
            },
          ],
        },
        {
          displayName: 'Body',
          name: 'body',
          type: 'string',
          default: '',
        },
        {
          displayName: 'JSON Body',
          name: 'jsonBody',
          type: 'json',
          default: {},
        },
        {
          displayName: 'Body Parameters',
          name: 'bodyParameters',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              displayName: 'Parameter',
              name: 'parameters',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Value', name: 'value', type: 'string', default: '' },
              ],
            },
          ],
        },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
      const output: INodeExecutionData[] = [];
      const nodeParameters = this.getNode().parameters as Record<string, unknown>;

      for (let itemIndex = 0; itemIndex < sourceItems.length; itemIndex++) {
        const url = readString(nodeParameters.url, '');
        if (!url) {
          throw new Error(
            `HTTP Request node requires a url parameter; got ${JSON.stringify(nodeParameters)}`
          );
        }

        const method = readString(nodeParameters.method, 'GET').toUpperCase().trim();

        const headerContainer = isRecord(nodeParameters.headerParameters)
          ? nodeParameters.headerParameters
          : {};
        const headerParameters = headerContainer.parameters ?? [];
        const headers = {
          ...normalizeHeaderEntries(nodeParameters.headers),
          ...normalizeHeaderEntries(headerParameters),
        };

        const requestOptions: RequestInit = { method, headers };
        const bodyContainer = isRecord(nodeParameters.bodyParameters)
          ? nodeParameters.bodyParameters
          : {};
        const bodyParameters = bodyContainer.parameters ?? [];
        const bodyObject = collectParametersList(bodyParameters);
        const jsonBody = nodeParameters.jsonBody;
        const rawBody = nodeParameters.body;

        if (!['GET', 'HEAD'].includes(method)) {
          if (typeof rawBody === 'string' && rawBody.length > 0) {
            requestOptions.body = rawBody;
          } else if (isRecord(jsonBody) || Object.keys(bodyObject).length > 0) {
            requestOptions.body = JSON.stringify(isRecord(jsonBody) ? jsonBody : bodyObject);
            headers['content-type'] = headers['content-type'] ?? 'application/json';
          }
        }

        const response = await fetch(url, requestOptions);
        const body = await parseResponseBody(response);
        output.push({
          json: {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body,
          } as INodeExecutionData['json'],
          pairedItem: { item: itemIndex },
        });
      }

      return [output];
    },
  };
}

class EmbeddedNodeTypes implements INodeTypes {
  private readonly nodes = new Map<string, INodeType>();

  constructor() {
    for (const node of [createScheduleTriggerNode(), createSetNode(), createHttpRequestNode()]) {
      this.nodes.set(node.description.name, node);
    }
  }

  getByName(nodeType: string): INodeType {
    return this.getByNameAndVersion(nodeType);
  }

  getByNameAndVersion(nodeType: string): INodeType {
    const node = this.nodes.get(nodeType);
    if (!node) {
      throw new Error(`Node type not available in embedded n8n runtime: ${nodeType}`);
    }
    return node;
  }

  getKnownTypes(): Record<string, { sourcePath: string; className: string }> {
    return Object.fromEntries(
      [...this.nodes.keys()].map((name) => [
        name,
        { sourcePath: 'embedded', className: name.split('.').at(-1) ?? name },
      ])
    );
  }

  has(nodeType: string): boolean {
    return this.nodes.has(nodeType);
  }

  versions(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const [name, node] of this.nodes) {
      const version = node.description.version;
      out.set(name, Array.isArray(version) ? version : [version]);
    }
    return out;
  }
}

export class EmbeddedN8nService extends Service {
  static override readonly serviceType = N8N_EMBEDDED_SERVICE_TYPE;

  override capabilityDescription =
    'Feature-flagged embedded n8n workflow runtime for local plugin-owned workflow execution.';

  private readonly workflows = new Map<
    string,
    { workflow: N8nWorkflow; createdAt: string; updatedAt: string; versionId: string }
  >();
  private readonly executions = new Map<string, N8nExecution>();
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly tags = new Map<string, N8nTag>();
  private readonly scheduleHandles = new Map<string, ScheduleHandle[]>();
  private readonly nodeTypes = new EmbeddedNodeTypes();

  static async start(runtime: IAgentRuntime): Promise<EmbeddedN8nService> {
    const service = new EmbeddedN8nService(runtime);
    logger.info(
      { src: 'plugin:n8n-workflow:embedded' },
      'Embedded n8n service registered (lazy runtime load)'
    );
    return service;
  }

  override async stop(): Promise<void> {
    for (const workflowId of this.scheduleHandles.keys()) {
      this.clearSchedules(workflowId);
    }
  }

  get host(): string {
    return EMBEDDED_HOST;
  }

  getRuntimeNodeTypeVersions(): Map<string, number[]> {
    return this.nodeTypes.versions();
  }

  async createWorkflow(workflow: N8nWorkflow): Promise<N8nWorkflowResponse> {
    this.assertRegisteredNodes(workflow);
    const id = workflow.id || randomUUID();
    const createdAt = nowIso();
    const stored = normalizeWorkflowPayload(workflow, id, false);
    this.workflows.set(id, {
      workflow: stored,
      createdAt,
      updatedAt: createdAt,
      versionId: randomUUID(),
    });
    return responseFromWorkflow(stored, createdAt, createdAt, this.workflows.get(id)!.versionId);
  }

  async updateWorkflow(id: string, workflow: N8nWorkflow): Promise<N8nWorkflowResponse> {
    const existing = this.getStoredWorkflow(id);
    this.assertRegisteredNodes(workflow);
    const updatedAt = nowIso();
    const stored = normalizeWorkflowPayload(workflow, id, existing.workflow.active ?? false);
    this.workflows.set(id, {
      workflow: stored,
      createdAt: existing.createdAt,
      updatedAt,
      versionId: randomUUID(),
    });
    if (stored.active) this.armSchedules(id);
    return responseFromWorkflow(stored, existing.createdAt, updatedAt, this.workflows.get(id)!.versionId);
  }

  async listWorkflows(params?: {
    active?: boolean;
    tags?: string[];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: N8nWorkflowResponse[]; nextCursor?: string }> {
    const data = [...this.workflows.values()]
      .filter((entry) => params?.active === undefined || entry.workflow.active === params.active)
      .filter((entry) => {
        if (!params?.tags?.length) return true;
        const tagIds = new Set(entry.workflow.tags?.map((tag) => tag.id) ?? []);
        return params.tags.every((tag) => tagIds.has(tag));
      })
      .map((entry) =>
        responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId)
      );
    return { data: typeof params?.limit === 'number' ? data.slice(0, params.limit) : data };
  }

  async getWorkflow(id: string): Promise<N8nWorkflowResponse> {
    const entry = this.getStoredWorkflow(id);
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async deleteWorkflow(id: string): Promise<void> {
    this.clearSchedules(id);
    if (!this.workflows.delete(id)) {
      throw new N8nApiError(`Workflow not found: ${id}`, 404);
    }
  }

  async activateWorkflow(id: string): Promise<N8nWorkflowResponse> {
    const entry = this.getStoredWorkflow(id);
    entry.workflow.active = true;
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    this.armSchedules(id);
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async deactivateWorkflow(id: string): Promise<N8nWorkflowResponse> {
    const entry = this.getStoredWorkflow(id);
    entry.workflow.active = false;
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    this.clearSchedules(id);
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async updateWorkflowTags(id: string, tagIds: string[]): Promise<N8nTag[]> {
    const entry = this.getStoredWorkflow(id);
    const tags = tagIds.map((tagId) => {
      const tag = this.tags.get(tagId);
      if (!tag) throw new N8nApiError(`Tag not found: ${tagId}`, 404);
      return tag;
    });
    entry.workflow.tags = cloneJson(tags);
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    return cloneJson(tags);
  }

  async createCredential(credential: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }): Promise<N8nCredential> {
    const id = randomUUID();
    const timestamp = nowIso();
    const stored: StoredCredential = {
      id,
      name: credential.name,
      type: credential.type,
      data: cloneJson(credential.data),
      isResolvable: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.credentials.set(id, stored);
    const { data: _data, ...response } = stored;
    return cloneJson(response);
  }

  async deleteCredential(id: string): Promise<void> {
    this.credentials.delete(id);
  }

  async listExecutions(params?: {
    workflowId?: string;
    status?: N8nExecution['status'];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: N8nExecution[]; nextCursor?: string }> {
    const data = [...this.executions.values()]
      .filter((execution) => !params?.workflowId || execution.workflowId === params.workflowId)
      .filter((execution) => !params?.status || execution.status === params.status)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return { data: typeof params?.limit === 'number' ? data.slice(0, params.limit) : data };
  }

  async getExecution(id: string): Promise<N8nExecution> {
    const execution = this.executions.get(id);
    if (!execution) throw new N8nApiError(`Execution not found: ${id}`, 404);
    return cloneJson(execution);
  }

  async deleteExecution(id: string): Promise<void> {
    this.executions.delete(id);
  }

  async listTags(): Promise<{ data: N8nTag[] }> {
    return { data: cloneJson([...this.tags.values()]) };
  }

  async createTag(name: string): Promise<N8nTag> {
    const existing = [...this.tags.values()].find((tag) => tag.name === name);
    if (existing) return cloneJson(existing);
    const timestamp = nowIso();
    const tag = { id: randomUUID(), name, createdAt: timestamp, updatedAt: timestamp };
    this.tags.set(tag.id, tag);
    return cloneJson(tag);
  }

  async getOrCreateTag(name: string): Promise<N8nTag> {
    const existing = [...this.tags.values()].find(
      (tag) => tag.name.toLowerCase() === name.toLowerCase()
    );
    return existing ? cloneJson(existing) : this.createTag(name);
  }

  async executeWorkflow(id: string, options: ExecuteOptions = {}): Promise<N8nExecution> {
    const entry = this.getStoredWorkflow(id);
    return this.runWorkflow(entry.workflow, options.mode ?? 'manual');
  }

  async triggerSchedulesOnce(workflowId?: string): Promise<N8nExecution[]> {
    const targets = workflowId ? [workflowId] : [...this.scheduleHandles.keys()];
    const executions: N8nExecution[] = [];
    for (const id of targets) {
      const entry = this.workflows.get(id);
      if (!entry?.workflow.active) continue;
      executions.push(await this.runWorkflow(entry.workflow, 'trigger'));
    }
    return executions;
  }

  private getStoredWorkflow(id: string): {
    workflow: N8nWorkflow;
    createdAt: string;
    updatedAt: string;
    versionId: string;
  } {
    const entry = this.workflows.get(id);
    if (!entry) throw new N8nApiError(`Workflow not found: ${id}`, 404);
    return entry;
  }

  private assertRegisteredNodes(workflow: N8nWorkflow): void {
    const missing = workflow.nodes
      .filter((node) => !node.disabled && !this.nodeTypes.has(node.type))
      .map((node) => `${node.name} (${node.type})`);
    if (missing.length > 0) {
      throw new N8nApiError(
        `Embedded n8n runtime does not support node(s): ${missing.join(', ')}`,
        400
      );
    }
  }

  private armSchedules(workflowId: string): void {
    this.clearSchedules(workflowId);
    const entry = this.getStoredWorkflow(workflowId);
    const scheduleNodes = entry.workflow.nodes.filter(
      (node) => !node.disabled && node.type === 'n8n-nodes-base.scheduleTrigger'
    );
    if (scheduleNodes.length === 0) return;

    const handles: ScheduleHandle[] = [];
    for (const node of scheduleNodes) {
      const intervalMs = resolveScheduleIntervalMs(node.parameters);
      const timer = setInterval(() => {
        void this.runWorkflow(entry.workflow, 'trigger').catch((error: unknown) => {
          logger.warn(
            { src: 'plugin:n8n-workflow:embedded' },
            `Scheduled workflow ${workflowId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }, intervalMs);
      timer.unref?.();
      handles.push({ workflowId, timer });
    }
    this.scheduleHandles.set(workflowId, handles);
  }

  private clearSchedules(workflowId: string): void {
    const handles = this.scheduleHandles.get(workflowId);
    if (!handles) return;
    for (const handle of handles) {
      clearInterval(handle.timer);
    }
    this.scheduleHandles.delete(workflowId);
  }

  private async runWorkflow(
    workflowData: N8nWorkflow,
    mode: WorkflowExecuteMode
  ): Promise<N8nExecution> {
    const { core, workflow: workflowRuntime } = await loadN8nRuntime();
    const executionId = randomUUID();
    const startedAt = new Date();
    const workflow = new workflowRuntime.Workflow({
      id: workflowData.id ?? '',
      name: workflowData.name,
      nodes: cloneJson(workflowData.nodes) as never,
      connections: cloneJson(workflowData.connections) as never,
      active: workflowData.active ?? false,
      settings: workflowData.settings,
      nodeTypes: this.nodeTypes,
    });
    const runner = new core.WorkflowExecute(
      this.createAdditionalData(core, executionId, mode, workflowData),
      mode
    );

    const pending: N8nExecution = {
      id: executionId,
      finished: false,
      mode,
      startedAt: startedAt.toISOString(),
      workflowId: workflowData.id ?? '',
      status: 'running',
    };
    this.executions.set(executionId, pending);

    try {
      const run = await runner.run({ workflow });
      const stoppedAt = new Date();
      const status = readString((run as unknown as { status?: unknown }).status, 'success') as
        | N8nExecution['status']
        | 'success';
      const execution: N8nExecution = {
        ...pending,
        finished: status === 'success',
        status: status === 'success' ? 'success' : status,
        stoppedAt: stoppedAt.toISOString(),
        data: cloneJson((run as unknown as { data?: N8nExecution['data'] }).data ?? {}),
      };
      this.executions.set(executionId, execution);
      return cloneJson(execution);
    } catch (error) {
      const stoppedAt = new Date();
      const execution: N8nExecution = {
        ...pending,
        finished: true,
        status: 'error',
        stoppedAt: stoppedAt.toISOString(),
        data: {
          resultData: {
            error: {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          },
        },
      };
      this.executions.set(executionId, execution);
      throw error;
    }
  }

  private createAdditionalData(
    core: N8nCoreRuntime,
    executionId: string,
    mode: WorkflowExecuteMode,
    workflowData: N8nWorkflow
  ): IWorkflowExecuteAdditionalData {
    const credentialsHelper = {
      getParentTypes: () => [],
      authenticate: async (
        _credentials: unknown,
        _typeName: string,
        requestOptions: unknown
      ) => requestOptions,
      preAuthentication: async () => undefined,
      getCredentials: async () => {
        throw new Error('Embedded n8n credential lookup is not implemented in P0');
      },
      getDecrypted: async () => {
        throw new Error('Embedded n8n credential decryption is not implemented in P0');
      },
      updateCredentials: async () => undefined,
      updateCredentialsOauthTokenData: async () => undefined,
      getCredentialsProperties: () => [],
    };

    return {
      credentialsHelper,
      executeWorkflow: async () => {
        throw new Error('Embedded sub-workflow execution is not implemented in P0');
      },
      getRunExecutionData: async () => undefined,
      hooks: new core.ExecutionLifecycleHooks(mode, executionId, workflowData as never),
      executionId,
      currentNodeExecutionIndex: 0,
      restApiUrl: EMBEDDED_HOST,
      instanceBaseUrl: EMBEDDED_HOST,
      formWaitingBaseUrl: EMBEDDED_HOST,
      webhookBaseUrl: EMBEDDED_HOST,
      webhookWaitingBaseUrl: EMBEDDED_HOST,
      webhookTestBaseUrl: EMBEDDED_HOST,
      variables: {},
      logAiEvent: () => undefined,
      startRunnerTask: async () => {
        throw new Error('Embedded n8n task runner is not implemented in P0');
      },
      getRunnerStatus: () => ({
        available: false,
        reason: 'Embedded P0 does not include task runners',
      }),
    } as unknown as IWorkflowExecuteAdditionalData;
  }
}
