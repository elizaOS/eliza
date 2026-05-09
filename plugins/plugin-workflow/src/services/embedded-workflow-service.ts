import { createHash, randomUUID } from 'node:crypto';
import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  embeddedCredentials,
  embeddedExecutions,
  embeddedTags,
  embeddedWorkflows,
} from '../db/schema';
import type {
  WorkflowCredential,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
  WorkflowNode,
  WorkflowTag,
} from '../types/index';
import { WorkflowApiError } from '../types/index';

export const EMBEDDED_WORKFLOW_SERVICE_TYPE = 'embedded_workflow_service';

type WorkflowExecuteMode = WorkflowExecution['mode'];

interface INodeExecutionData {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number } | Array<{ item: number }>;
}

interface IExecuteFunctions {
  getInputData(inputIndex?: number): INodeExecutionData[];
  getNode(): WorkflowNode;
}

interface INodeTypeDescription {
  displayName: string;
  name: string;
  group: string[];
  version: number | number[];
  description: string;
  defaults: { name: string };
  inputs: unknown[];
  outputs: unknown[];
  properties: unknown[];
}

interface INodeType {
  description: INodeTypeDescription;
  execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
  trigger?(): Promise<unknown>;
}

interface INodeTypes {
  getByName(nodeType: string): INodeType;
  getByNameAndVersion(nodeType: string): INodeType;
  getKnownTypes(): Record<string, { sourcePath: string; className: string }>;
}

interface StoredCredential extends WorkflowCredential {
  data?: Record<string, unknown>;
}

interface StoredWorkflowRow {
  workflow: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
  versionId: string;
}

interface ScheduleHandle {
  workflowId: string;
  timer: ReturnType<typeof setInterval>;
}

interface ExecuteOptions {
  mode?: WorkflowExecuteMode;
}

interface IncomingConnection {
  source: string;
  sourceOutputIndex: number;
  destinationInputIndex: number;
}

const EMBEDDED_HOST = 'embedded://local';
const DEFAULT_SCHEDULE_INTERVAL_MS = 60_000;

let loadedQuickJs: Promise<typeof import('quickjs-emscripten')> | null = null;

async function loadQuickJs(): Promise<typeof import('quickjs-emscripten')> {
  loadedQuickJs ??= import('quickjs-emscripten');
  return loadedQuickJs;
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

function normalizeWorkflowPayload(
  workflow: WorkflowDefinition,
  id: string,
  active: boolean
): WorkflowDefinition {
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
  workflow: WorkflowDefinition,
  createdAt: string,
  updatedAt: string,
  versionId: string
): WorkflowDefinitionResponse {
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

function normalizeWebhookPath(path: unknown): string {
  return readString(path, '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
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

function normalizeExecutionItem(
  item: unknown,
  pairedItem?: INodeExecutionData['pairedItem']
): INodeExecutionData {
  if (isRecord(item) && 'json' in item) {
    return item as unknown as INodeExecutionData;
  }
  return {
    json: (isRecord(item) ? item : { value: item }) as INodeExecutionData['json'],
    ...(pairedItem ? { pairedItem } : {}),
  };
}

function normalizeExecutionItems(
  value: unknown,
  fallback: INodeExecutionData[]
): INodeExecutionData[] {
  if (typeof value === 'undefined') return fallback.map((item) => normalizeExecutionItem(item));
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeExecutionItem(item, { item: index }));
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items.map((item, index) => normalizeExecutionItem(item, { item: index }));
  }
  return [normalizeExecutionItem(value)];
}

function readPath(source: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g, '.$1$2$3')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveParameterValue(value: unknown, item: INodeExecutionData): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const expression =
    trimmed.startsWith('={{') && trimmed.endsWith('}}')
      ? trimmed.slice(3, -2).trim()
      : trimmed.startsWith('{{') && trimmed.endsWith('}}')
        ? trimmed.slice(2, -2).trim()
        : trimmed.startsWith('=')
          ? trimmed.slice(1).trim()
          : trimmed;
  const jsonPath = expression.match(/^\$json(?:\.|\[['"]?)(.+?)(?:['"]?\])?$/);
  if (jsonPath?.[1]) {
    return readPath(item.json, jsonPath[1]);
  }
  const itemJsonPath = expression.match(/^\$input\.item\.json(?:\.|\[['"]?)(.+?)(?:['"]?\])?$/);
  if (itemJsonPath?.[1]) {
    return readPath(item.json, itemJsonPath[1]);
  }
  return value;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'undefined' ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

function compareCondition(
  left: unknown,
  operation: string,
  right: unknown,
  item: INodeExecutionData
): boolean {
  const resolvedLeft = resolveParameterValue(left, item);
  const resolvedRight = resolveParameterValue(right, item);
  const op = operation.toLowerCase();

  if (op === 'exists') return typeof resolvedLeft !== 'undefined' && resolvedLeft !== null;
  if (op === 'notexists') return typeof resolvedLeft === 'undefined' || resolvedLeft === null;
  if (op === 'empty') return isEmptyValue(resolvedLeft);
  if (op === 'notempty') return !isEmptyValue(resolvedLeft);
  if (op === 'true') return resolvedLeft === true || resolvedLeft === 'true';
  if (op === 'false') return resolvedLeft === false || resolvedLeft === 'false';
  if (op === 'contains') return String(resolvedLeft ?? '').includes(String(resolvedRight ?? ''));
  if (op === 'notcontains')
    return !String(resolvedLeft ?? '').includes(String(resolvedRight ?? ''));
  if (op === 'startswith')
    return String(resolvedLeft ?? '').startsWith(String(resolvedRight ?? ''));
  if (op === 'endswith') return String(resolvedLeft ?? '').endsWith(String(resolvedRight ?? ''));
  if (op === 'larger' || op === 'largerorequal' || op === 'gt' || op === 'gte') {
    return op.includes('equal') || op === 'gte'
      ? Number(resolvedLeft) >= Number(resolvedRight)
      : Number(resolvedLeft) > Number(resolvedRight);
  }
  if (op === 'smaller' || op === 'smallerorequal' || op === 'lt' || op === 'lte') {
    return op.includes('equal') || op === 'lte'
      ? Number(resolvedLeft) <= Number(resolvedRight)
      : Number(resolvedLeft) < Number(resolvedRight);
  }
  if (op === 'notequal' || op === 'notequals') return resolvedLeft !== resolvedRight;
  return (
    resolvedLeft === resolvedRight || String(resolvedLeft ?? '') === String(resolvedRight ?? '')
  );
}

function collectConditionEntries(parameters: Record<string, unknown>): Array<{
  left: unknown;
  operation: string;
  right: unknown;
}> {
  const conditions = isRecord(parameters.conditions) ? parameters.conditions : {};
  const modern = Array.isArray(conditions.conditions) ? conditions.conditions : [];
  const out: Array<{ left: unknown; operation: string; right: unknown }> = [];

  for (const condition of modern) {
    if (!isRecord(condition)) continue;
    const operator = isRecord(condition.operator) ? condition.operator : {};
    out.push({
      left: condition.leftValue ?? condition.value1,
      operation: readString(operator.operation ?? condition.operation, 'equals'),
      right: condition.rightValue ?? condition.value2,
    });
  }

  for (const group of Object.values(conditions)) {
    if (!Array.isArray(group)) continue;
    for (const condition of group) {
      if (!isRecord(condition)) continue;
      out.push({
        left: condition.value1 ?? condition.leftValue,
        operation: readString(condition.operation, 'equals'),
        right: condition.value2 ?? condition.rightValue,
      });
    }
  }

  return out;
}

function evaluateConditions(
  parameters: Record<string, unknown>,
  item: INodeExecutionData
): boolean {
  const conditions = collectConditionEntries(parameters);
  if (conditions.length === 0) return true;
  const combinator = readString(
    isRecord(parameters.conditions) ? parameters.conditions.combinator : undefined,
    'and'
  ).toLowerCase();
  const results = conditions.map((condition) =>
    compareCondition(condition.left, condition.operation, condition.right, item)
  );
  return combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
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
      name: 'workflows-nodes-base.scheduleTrigger',
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
      name: 'workflows-nodes-base.set',
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
      name: 'workflows-nodes-base.httpRequest',
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

function createManualTriggerNode(): INodeType {
  return {
    description: {
      displayName: 'Manual Trigger',
      name: 'workflows-nodes-base.manualTrigger',
      group: ['trigger'],
      version: [1],
      description: 'Starts the workflow manually.',
      defaults: { name: 'Manual Trigger' },
      inputs: [],
      outputs: ['main'] as never,
      properties: [],
    },
    async execute(): Promise<INodeExecutionData[][]> {
      return [[{ json: { firedAt: new Date().toISOString(), trigger: 'manual' } }]];
    },
    async trigger() {
      return {};
    },
  };
}

function createWebhookNode(): INodeType {
  return {
    description: {
      displayName: 'Webhook',
      name: 'workflows-nodes-base.webhook',
      group: ['trigger'],
      version: [1, 2],
      description: 'Starts the workflow from an HTTP webhook.',
      defaults: { name: 'Webhook' },
      inputs: [],
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Path', name: 'path', type: 'string', default: '' },
        { displayName: 'HTTP Method', name: 'httpMethod', type: 'string', default: 'POST' },
        { displayName: 'Embedded Payload', name: '__embeddedPayload', type: 'json', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const payload = isRecord(parameters.__embeddedPayload)
        ? parameters.__embeddedPayload
        : { firedAt: new Date().toISOString(), trigger: 'webhook' };
      return [[{ json: cloneJson(payload) as INodeExecutionData['json'] }]];
    },
    async trigger() {
      return {};
    },
  };
}

function createRespondToWebhookNode(): INodeType {
  return {
    description: {
      displayName: 'Respond to Webhook',
      name: 'workflows-nodes-base.respondToWebhook',
      group: ['output'],
      version: [1],
      description: 'Returns the current item as a webhook response.',
      defaults: { name: 'Respond to Webhook' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Response Body', name: 'responseBody', type: 'json', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const parameters = this.getNode().parameters as Record<string, unknown>;
      if (isRecord(parameters.responseBody) && Object.keys(parameters.responseBody).length > 0) {
        return [[{ json: cloneJson(parameters.responseBody) as INodeExecutionData['json'] }]];
      }
      return [inputItems.length > 0 ? inputItems : [{ json: {} }]];
    },
  };
}

function createNoOpNode(): INodeType {
  return {
    description: {
      displayName: 'No Operation, do nothing',
      name: 'workflows-nodes-base.noOp',
      group: ['transform'],
      version: [1],
      description: 'Passes input data through unchanged.',
      defaults: { name: 'NoOp' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [],
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      return [inputItems.length > 0 ? inputItems : [{ json: {} }]];
    },
  };
}

function createIfNode(): INodeType {
  return {
    description: {
      displayName: 'If',
      name: 'workflows-nodes-base.if',
      group: ['transform'],
      version: [1, 2],
      description: 'Routes items based on conditions.',
      defaults: { name: 'If' },
      inputs: ['main'] as never,
      outputs: ['main', 'main'] as never,
      properties: [
        { displayName: 'Conditions', name: 'conditions', type: 'fixedCollection', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const inputItems = this.getInputData();
      const trueItems: INodeExecutionData[] = [];
      const falseItems: INodeExecutionData[] = [];
      inputItems.forEach((item, index) => {
        const out = evaluateConditions(parameters, item) ? trueItems : falseItems;
        out.push({ ...item, pairedItem: item.pairedItem ?? { item: index } });
      });
      return [trueItems, falseItems];
    },
  };
}

function createFilterNode(): INodeType {
  return {
    description: {
      displayName: 'Filter',
      name: 'workflows-nodes-base.filter',
      group: ['transform'],
      version: [1, 2],
      description: 'Keeps items that match conditions.',
      defaults: { name: 'Filter' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Conditions', name: 'conditions', type: 'fixedCollection', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      return [this.getInputData().filter((item) => evaluateConditions(parameters, item))];
    },
  };
}

function createSwitchNode(): INodeType {
  return {
    description: {
      displayName: 'Switch',
      name: 'workflows-nodes-base.switch',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Routes items to multiple outputs.',
      defaults: { name: 'Switch' },
      inputs: ['main'] as never,
      outputs: ['main', 'main', 'main', 'main', 'main'] as never,
      properties: [
        { displayName: 'Rules', name: 'rules', type: 'fixedCollection', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const rulesContainer = isRecord(parameters.rules) ? parameters.rules : {};
      const rules = Array.isArray(rulesContainer.rules) ? rulesContainer.rules : [];
      const outputs: INodeExecutionData[][] = [[], [], [], [], []];
      this.getInputData().forEach((item, itemIndex) => {
        const matchedIndex = rules.findIndex((rule) =>
          isRecord(rule) ? evaluateConditions({ conditions: rule.conditions ?? rule }, item) : false
        );
        const outputIndex = matchedIndex >= 0 ? Math.min(matchedIndex, 3) : 4;
        outputs[outputIndex].push({ ...item, pairedItem: item.pairedItem ?? { item: itemIndex } });
      });
      return outputs;
    },
  };
}

function createMergeNode(): INodeType {
  return {
    description: {
      displayName: 'Merge',
      name: 'workflows-nodes-base.merge',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Combines items from multiple inputs.',
      defaults: { name: 'Merge' },
      inputs: ['main', 'main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Mode', name: 'mode', type: 'string', default: 'append' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const getInput = this.getInputData as unknown as (
        inputIndex?: number
      ) => INodeExecutionData[];
      const first = getInput(0) ?? [];
      const second = getInput(1) ?? [];
      return [[...first, ...second]];
    },
  };
}

function createSplitInBatchesNode(): INodeType {
  return {
    description: {
      displayName: 'Split In Batches',
      name: 'workflows-nodes-base.splitInBatches',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Emits the next batch of items.',
      defaults: { name: 'Split In Batches' },
      inputs: ['main'] as never,
      outputs: ['main', 'main'] as never,
      properties: [
        { displayName: 'Batch Size', name: 'batchSize', type: 'number', default: 1 },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const batchSize = Math.max(
        1,
        readNumber(this.getNode().parameters.batchSize, inputItems.length)
      );
      return [inputItems.slice(0, batchSize), inputItems.slice(batchSize)];
    },
  };
}

function createWaitNode(): INodeType {
  return {
    description: {
      displayName: 'Wait',
      name: 'workflows-nodes-base.wait',
      group: ['transform'],
      version: [1, 1.1],
      description: 'Pauses execution for a duration.',
      defaults: { name: 'Wait' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Amount', name: 'amount', type: 'number', default: 1 },
        { displayName: 'Unit', name: 'unit', type: 'string', default: 'seconds' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const amount = Math.max(0, readNumber(parameters.amount, 1));
      const unit = readString(parameters.unit, 'seconds');
      const multiplier =
        unit === 'milliseconds'
          ? 1
          : unit === 'minutes'
            ? 60_000
            : unit === 'hours'
              ? 3_600_000
              : 1000;
      await new Promise((resolve) => setTimeout(resolve, amount * multiplier));
      return [this.getInputData()];
    },
  };
}

function createDateTimeNode(): INodeType {
  return {
    description: {
      displayName: 'Date & Time',
      name: 'workflows-nodes-base.dateTime',
      group: ['transform'],
      version: [1, 2],
      description: 'Adds date/time values to items.',
      defaults: { name: 'Date & Time' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Field Name', name: 'fieldName', type: 'string', default: 'dateTime' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const fieldName = readString(this.getNode().parameters.fieldName, 'dateTime');
      const now = new Date().toISOString();
      return [
        inputItems.map((item, index) => ({
          json: { ...(item.json ?? {}), [fieldName]: now } as INodeExecutionData['json'],
          pairedItem: item.pairedItem ?? { item: index },
        })),
      ];
    },
  };
}

function createCryptoNode(): INodeType {
  return {
    description: {
      displayName: 'Crypto',
      name: 'workflows-nodes-base.crypto',
      group: ['transform'],
      version: [1],
      description: 'Hashes data.',
      defaults: { name: 'Crypto' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
        { displayName: 'Algorithm', name: 'algorithm', type: 'string', default: 'sha256' },
        { displayName: 'Field Name', name: 'fieldName', type: 'string', default: 'hash' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const algorithm = readString(parameters.algorithm, 'sha256');
      const fieldName = readString(parameters.fieldName, 'hash');
      return [
        this.getInputData().map((item, index) => {
          const raw = resolveParameterValue(parameters.value, item);
          const source =
            raw === '' || typeof raw === 'undefined' ? JSON.stringify(item.json) : String(raw);
          return {
            json: {
              ...(item.json ?? {}),
              [fieldName]: createHash(algorithm).update(source).digest('hex'),
            } as INodeExecutionData['json'],
            pairedItem: item.pairedItem ?? { item: index },
          };
        }),
      ];
    },
  };
}

function createItemListsNode(): INodeType {
  return {
    description: {
      displayName: 'Item Lists',
      name: 'workflows-nodes-base.itemLists',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Transforms item lists.',
      defaults: { name: 'Item Lists' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Operation', name: 'operation', type: 'string', default: 'passthrough' },
        { displayName: 'Limit', name: 'limit', type: 'number', default: 0 },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const inputItems = this.getInputData();
      const operation = readString(parameters.operation, 'passthrough');
      if (operation === 'limit') {
        const limit = Math.max(0, readNumber(parameters.limit, inputItems.length));
        return [inputItems.slice(0, limit)];
      }
      return [inputItems];
    },
  };
}

async function runQuickJsCode(jsCode: string, inputItems: INodeExecutionData[]): Promise<unknown> {
  const { getQuickJS, shouldInterruptAfterDeadline } = await loadQuickJs();
  const QuickJS = await getQuickJS();
  const embeddedInput = JSON.stringify(inputItems.map((item) => normalizeExecutionItem(item)));
  const source = `
    "use strict";
    const $input = ${embeddedInput};
    const items = $input;
    const item = $input[0] ?? { json: {} };
    const $json = item.json ?? {};
    const $now = new Date("${new Date().toISOString()}");
    const $workflow = {};
    const $env = {};
    const console = { log() {}, warn() {}, error() {}, info() {} };
    (function embeddedWorkflowCodeNode() {
      ${jsCode}
    })()
  `;
  return QuickJS.evalCode(source, {
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 5_000),
    memoryLimitBytes: 32 * 1024 * 1024,
  });
}

function createCodeNode(): INodeType {
  return {
    description: {
      displayName: 'Code',
      name: 'workflows-nodes-base.code',
      group: ['transform'],
      version: [1, 2],
      description: 'Runs JavaScript in a QuickJS sandbox.',
      defaults: { name: 'Code' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        {
          displayName: 'JavaScript Code',
          name: 'jsCode',
          type: 'string',
          default: 'return items;',
        },
        { displayName: 'Mode', name: 'mode', type: 'string', default: 'runOnceForAllItems' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const jsCode = readString(parameters.jsCode, 'return items;');
      const mode = readString(parameters.mode, 'runOnceForAllItems');
      if (mode === 'runOnceForEachItem') {
        const out: INodeExecutionData[] = [];
        for (const item of sourceItems) {
          const result = await runQuickJsCode(jsCode, [item]);
          out.push(...normalizeExecutionItems(result, [item]));
        }
        return [out];
      }
      const result = await runQuickJsCode(jsCode, sourceItems);
      return [normalizeExecutionItems(result, sourceItems)];
    },
  };
}

class EmbeddedNodeTypes implements INodeTypes {
  private readonly nodes = new Map<string, INodeType>();

  constructor() {
    for (const node of [
      createScheduleTriggerNode(),
      createManualTriggerNode(),
      createWebhookNode(),
      createRespondToWebhookNode(),
      createSetNode(),
      createHttpRequestNode(),
      createNoOpNode(),
      createIfNode(),
      createFilterNode(),
      createSwitchNode(),
      createMergeNode(),
      createSplitInBatchesNode(),
      createWaitNode(),
      createDateTimeNode(),
      createCryptoNode(),
      createItemListsNode(),
      createCodeNode(),
    ]) {
      this.nodes.set(node.description.name, node);
    }
  }

  getByName(nodeType: string): INodeType {
    return this.getByNameAndVersion(nodeType);
  }

  getByNameAndVersion(nodeType: string): INodeType {
    const node = this.nodes.get(nodeType);
    if (!node) {
      throw new Error(`Node type not available in embedded workflow runtime: ${nodeType}`);
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

  names(): string[] {
    return [...this.nodes.keys()];
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

export class EmbeddedWorkflowService extends Service {
  static override readonly serviceType = EMBEDDED_WORKFLOW_SERVICE_TYPE;

  override capabilityDescription =
    'Feature-flagged embedded workflow runtime for local plugin-owned workflow execution.';

  private readonly scheduleHandles = new Map<string, ScheduleHandle[]>();
  private readonly nodeTypes = new EmbeddedNodeTypes();
  private schemaReady: Promise<void> | null = null;

  static async start(runtime: IAgentRuntime): Promise<EmbeddedWorkflowService> {
    const service = new EmbeddedWorkflowService(runtime);
    logger.info(
      { src: 'plugin:workflow:embedded' },
      'Embedded workflow service registered (lazy runtime load)'
    );
    if (runtime.db) {
      await service.ensureSchema();
      await service.rehydrateSchedules();
    }
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

  getRegisteredNodeTypes(): string[] {
    return this.nodeTypes.names();
  }

  supportsWorkflow(workflow: WorkflowDefinition): { supported: boolean; missing: string[] } {
    const missing = workflow.nodes
      .filter((node) => !node.disabled && !this.nodeTypes.has(node.type))
      .map((node) => node.type);
    return { supported: missing.length === 0, missing: [...new Set(missing)] };
  }

  private getDb(): NodePgDatabase {
    const db = this.runtime.db;
    if (!db) {
      throw new Error(
        'Database not available for EmbeddedWorkflowService. Embedded workflow requires plugin-sql/PGlite/Postgres persistence.'
      );
    }
    return db as NodePgDatabase;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        const db = this.getDb();
        await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "workflow"`);
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."credential_mappings" (
            "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            "user_id" text NOT NULL,
            "cred_type" text NOT NULL,
            "workflow_credential_id" text NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL
          )
        `);
        await db.execute(sql`
          CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_cred"
          ON "workflow"."credential_mappings" ("user_id", "cred_type")
        `);
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_workflows" (
            "id" text PRIMARY KEY,
            "name" text NOT NULL,
            "active" boolean DEFAULT false NOT NULL,
            "workflow" jsonb NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL,
            "version_id" text NOT NULL
          )
        `);
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_embedded_workflows_active"
          ON "workflow"."embedded_workflows" ("active")
        `);
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_embedded_workflows_updated_at"
          ON "workflow"."embedded_workflows" ("updated_at")
        `);
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_executions" (
            "id" text PRIMARY KEY,
            "workflow_id" text NOT NULL,
            "status" text NOT NULL,
            "mode" text NOT NULL,
            "finished" boolean DEFAULT false NOT NULL,
            "started_at" text NOT NULL,
            "stopped_at" text,
            "execution" jsonb NOT NULL
          )
        `);
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_embedded_executions_workflow_id"
          ON "workflow"."embedded_executions" ("workflow_id")
        `);
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_embedded_executions_status"
          ON "workflow"."embedded_executions" ("status")
        `);
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_embedded_executions_started_at"
          ON "workflow"."embedded_executions" ("started_at")
        `);
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_credentials" (
            "id" text PRIMARY KEY,
            "name" text NOT NULL,
            "type" text NOT NULL,
            "data" jsonb NOT NULL,
            "is_resolvable" boolean DEFAULT true NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL
          )
        `);
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_embedded_credentials_type"
          ON "workflow"."embedded_credentials" ("type")
        `);
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_tags" (
            "id" text PRIMARY KEY,
            "name" text NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL
          )
        `);
        await db.execute(sql`
          CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedded_tags_name"
          ON "workflow"."embedded_tags" ("name")
        `);
      })();
    }
    await this.schemaReady;
  }

  async createWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinitionResponse> {
    this.assertRegisteredNodes(workflow);
    await this.ensureSchema();
    const db = this.getDb();
    const id = workflow.id || randomUUID();
    const createdAt = nowIso();
    const versionId = randomUUID();
    const stored = normalizeWorkflowPayload(workflow, id, false);
    await db.insert(embeddedWorkflows).values({
      id,
      name: stored.name,
      active: false,
      createdAt,
      updatedAt: createdAt,
      versionId,
      workflow: stored,
    });
    return responseFromWorkflow(stored, createdAt, createdAt, versionId);
  }

  async updateWorkflow(
    id: string,
    workflow: WorkflowDefinition
  ): Promise<WorkflowDefinitionResponse> {
    this.assertRegisteredNodes(workflow);
    const existing = await this.getStoredWorkflow(id);
    const db = this.getDb();
    const updatedAt = nowIso();
    const versionId = randomUUID();
    const stored = normalizeWorkflowPayload(workflow, id, existing.workflow.active ?? false);
    await db
      .update(embeddedWorkflows)
      .set({
        name: stored.name,
        active: stored.active ?? false,
        workflow: stored,
        updatedAt,
        versionId,
      })
      .where(eq(embeddedWorkflows.id, id));
    if (stored.active) await this.armSchedules(id);
    return responseFromWorkflow(stored, existing.createdAt, updatedAt, versionId);
  }

  async listWorkflows(params?: {
    active?: boolean;
    tags?: string[];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: WorkflowDefinitionResponse[]; nextCursor?: string }> {
    await this.ensureSchema();
    const db = this.getDb();
    const rows = await db
      .select()
      .from(embeddedWorkflows)
      .orderBy(desc(embeddedWorkflows.updatedAt));
    const data = rows
      .map((row) => ({
        workflow: cloneJson(row.workflow),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        versionId: row.versionId,
      }))
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

  async getWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    const entry = await this.getStoredWorkflow(id);
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.ensureSchema();
    this.clearSchedules(id);
    const existing = await this.getStoredWorkflow(id);
    const db = this.getDb();
    await db.delete(embeddedWorkflows).where(eq(embeddedWorkflows.id, id));
    if (!existing) {
      throw new WorkflowApiError(`Workflow not found: ${id}`, 404);
    }
  }

  async activateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    const entry = await this.getStoredWorkflow(id);
    const db = this.getDb();
    entry.workflow.active = true;
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    await db
      .update(embeddedWorkflows)
      .set({
        active: true,
        workflow: entry.workflow,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .where(eq(embeddedWorkflows.id, id));
    await this.armSchedules(id);
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async deactivateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    const entry = await this.getStoredWorkflow(id);
    const db = this.getDb();
    entry.workflow.active = false;
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    this.clearSchedules(id);
    await db
      .update(embeddedWorkflows)
      .set({
        active: false,
        workflow: entry.workflow,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .where(eq(embeddedWorkflows.id, id));
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async updateWorkflowTags(id: string, tagIds: string[]): Promise<WorkflowTag[]> {
    const entry = await this.getStoredWorkflow(id);
    const db = this.getDb();
    const tags: WorkflowTag[] = [];
    for (const tagId of tagIds) {
      const rows = await db.select().from(embeddedTags).where(eq(embeddedTags.id, tagId)).limit(1);
      const tag = rows[0];
      if (!tag) throw new WorkflowApiError(`Tag not found: ${tagId}`, 404);
      tags.push({ id: tag.id, name: tag.name, createdAt: tag.createdAt, updatedAt: tag.updatedAt });
    }
    entry.workflow.tags = cloneJson(tags);
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    await db
      .update(embeddedWorkflows)
      .set({
        workflow: entry.workflow,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .where(eq(embeddedWorkflows.id, id));
    return cloneJson(tags);
  }

  async createCredential(credential: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowCredential> {
    await this.ensureSchema();
    const db = this.getDb();
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
    await db.insert(embeddedCredentials).values({
      id,
      name: stored.name,
      type: stored.type,
      data: cloneJson(credential.data),
      isResolvable: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const { data: _data, ...response } = stored;
    return cloneJson(response);
  }

  async deleteCredential(id: string): Promise<void> {
    await this.ensureSchema();
    await this.getDb().delete(embeddedCredentials).where(eq(embeddedCredentials.id, id));
  }

  async listExecutions(params?: {
    workflowId?: string;
    status?: WorkflowExecution['status'];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: WorkflowExecution[]; nextCursor?: string }> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(
        params?.workflowId && params?.status
          ? and(
              eq(embeddedExecutions.workflowId, params.workflowId),
              eq(embeddedExecutions.status, params.status)
            )
          : params?.workflowId
            ? eq(embeddedExecutions.workflowId, params.workflowId)
            : params?.status
              ? eq(embeddedExecutions.status, params.status)
              : undefined
      )
      .orderBy(desc(embeddedExecutions.startedAt));
    const data = rows.map((row) => cloneJson(row.execution));
    return { data: typeof params?.limit === 'number' ? data.slice(0, params.limit) : data };
  }

  async getExecution(id: string): Promise<WorkflowExecution> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(eq(embeddedExecutions.id, id))
      .limit(1);
    const execution = rows[0]?.execution;
    if (!execution) throw new WorkflowApiError(`Execution not found: ${id}`, 404);
    return cloneJson(execution);
  }

  async deleteExecution(id: string): Promise<void> {
    await this.ensureSchema();
    await this.getDb().delete(embeddedExecutions).where(eq(embeddedExecutions.id, id));
  }

  async listTags(): Promise<{ data: WorkflowTag[] }> {
    await this.ensureSchema();
    const rows = await this.getDb().select().from(embeddedTags).orderBy(embeddedTags.name);
    return { data: rows.map((row) => cloneJson(row)) };
  }

  async createTag(name: string): Promise<WorkflowTag> {
    await this.ensureSchema();
    const db = this.getDb();
    const existingRows = await db
      .select()
      .from(embeddedTags)
      .where(eq(embeddedTags.name, name))
      .limit(1);
    const existing = existingRows[0];
    if (existing) return cloneJson(existing);
    const timestamp = nowIso();
    const tag = { id: randomUUID(), name, createdAt: timestamp, updatedAt: timestamp };
    await db.insert(embeddedTags).values(tag);
    return cloneJson(tag);
  }

  async getOrCreateTag(name: string): Promise<WorkflowTag> {
    await this.ensureSchema();
    const rows = await this.getDb().select().from(embeddedTags);
    const existing = rows.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    return existing ? cloneJson(existing) : this.createTag(name);
  }

  async executeWorkflow(id: string, options: ExecuteOptions = {}): Promise<WorkflowExecution> {
    const entry = await this.getStoredWorkflow(id);
    return this.runWorkflow(entry.workflow, options.mode ?? 'manual');
  }

  async executeWebhook(
    path: string,
    payload: Record<string, unknown>,
    method = 'POST'
  ): Promise<WorkflowExecution> {
    await this.ensureSchema();
    const normalizedPath = normalizeWebhookPath(path);
    const normalizedMethod = method.toUpperCase();
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.active, true));

    for (const row of rows) {
      const workflow = cloneJson(row.workflow);
      const webhookNode = workflow.nodes.find((node) => {
        if (node.disabled || node.type !== 'workflows-nodes-base.webhook') return false;
        const nodePath = normalizeWebhookPath(node.parameters.path);
        const nodeMethod = readString(node.parameters.httpMethod, 'POST').toUpperCase();
        return nodePath === normalizedPath && nodeMethod === normalizedMethod;
      });
      if (!webhookNode) continue;
      webhookNode.parameters = {
        ...webhookNode.parameters,
        __embeddedPayload: {
          ...payload,
          headers: isRecord(payload.headers) ? payload.headers : {},
          method: normalizedMethod,
          path: normalizedPath,
        },
      };
      return this.runWorkflow(workflow, 'webhook');
    }

    throw new WorkflowApiError(`Webhook not found: ${normalizedMethod} /${normalizedPath}`, 404);
  }

  async triggerSchedulesOnce(workflowId?: string): Promise<WorkflowExecution[]> {
    const targets = workflowId ? [workflowId] : [...this.scheduleHandles.keys()];
    const executions: WorkflowExecution[] = [];
    for (const id of targets) {
      const entry = await this.getStoredWorkflow(id);
      if (!entry.workflow.active) continue;
      executions.push(await this.runWorkflow(entry.workflow, 'trigger'));
    }
    return executions;
  }

  private async getStoredWorkflow(id: string): Promise<StoredWorkflowRow> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new WorkflowApiError(`Workflow not found: ${id}`, 404);
    return {
      workflow: cloneJson(row.workflow),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      versionId: row.versionId,
    };
  }

  private assertRegisteredNodes(workflow: WorkflowDefinition): void {
    const missing = workflow.nodes
      .filter((node) => !node.disabled && !this.nodeTypes.has(node.type))
      .map((node) => `${node.name} (${node.type})`);
    if (missing.length > 0) {
      throw new WorkflowApiError(
        `Embedded workflow runtime does not support node(s): ${missing.join(', ')}`,
        400
      );
    }
  }

  private async rehydrateSchedules(): Promise<void> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.active, true));
    for (const row of rows) {
      await this.armSchedules(row.id);
    }
  }

  private async armSchedules(workflowId: string): Promise<void> {
    this.clearSchedules(workflowId);
    const entry = await this.getStoredWorkflow(workflowId);
    const scheduleNodes = entry.workflow.nodes.filter(
      (node) => !node.disabled && node.type === 'workflows-nodes-base.scheduleTrigger'
    );
    if (scheduleNodes.length === 0) return;

    const handles: ScheduleHandle[] = [];
    for (const node of scheduleNodes) {
      const intervalMs = resolveScheduleIntervalMs(node.parameters);
      const timer = setInterval(() => {
        void (async () => {
          const latest = await this.getStoredWorkflow(workflowId);
          if (latest.workflow.active) {
            await this.runWorkflow(latest.workflow, 'trigger');
          }
        })().catch((error: unknown) => {
          logger.warn(
            { src: 'plugin:workflow:embedded' },
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

  private async saveExecution(execution: WorkflowExecution): Promise<void> {
    await this.ensureSchema();
    await this.getDb()
      .insert(embeddedExecutions)
      .values({
        id: execution.id,
        workflowId: execution.workflowId,
        status: execution.status,
        mode: execution.mode,
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt ?? null,
        execution: cloneJson(execution),
      })
      .onConflictDoUpdate({
        target: embeddedExecutions.id,
        set: {
          workflowId: execution.workflowId,
          status: execution.status,
          mode: execution.mode,
          finished: execution.finished,
          startedAt: execution.startedAt,
          stoppedAt: execution.stoppedAt ?? null,
          execution: cloneJson(execution),
        },
      });
  }

  private buildIncomingConnections(
    workflowData: WorkflowDefinition
  ): Map<string, IncomingConnection[]> {
    const incoming = new Map<string, IncomingConnection[]>();
    for (const [source, outputsByType] of Object.entries(workflowData.connections ?? {})) {
      const mainOutputs = outputsByType.main ?? [];
      mainOutputs.forEach((connections, sourceOutputIndex) => {
        for (const connection of connections ?? []) {
          if (connection.type !== 'main') continue;
          const destination = incoming.get(connection.node) ?? [];
          destination.push({
            source,
            sourceOutputIndex,
            destinationInputIndex: connection.index ?? 0,
          });
          incoming.set(connection.node, destination);
        }
      });
    }
    return incoming;
  }

  private resolveStartNodes(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode,
    incoming: Map<string, IncomingConnection[]>
  ): Set<string> {
    const enabledNodes = workflowData.nodes.filter((node) => !node.disabled);
    const start = new Set<string>();

    if (mode === 'webhook') {
      for (const node of enabledNodes) {
        if (
          node.type === 'workflows-nodes-base.webhook' &&
          isRecord(node.parameters.__embeddedPayload)
        ) {
          start.add(node.name);
        }
      }
      if (start.size === 0) {
        for (const node of enabledNodes) {
          if (node.type === 'workflows-nodes-base.webhook') start.add(node.name);
        }
      }
    } else if (mode === 'trigger') {
      for (const node of enabledNodes) {
        if (node.type === 'workflows-nodes-base.scheduleTrigger') start.add(node.name);
      }
    } else {
      for (const node of enabledNodes) {
        if (node.type === 'workflows-nodes-base.manualTrigger') start.add(node.name);
      }
    }

    if (start.size === 0) {
      for (const node of enabledNodes) {
        if ((incoming.get(node.name) ?? []).length === 0) start.add(node.name);
      }
    }

    return start;
  }

  private collectInputData(
    nodeName: string,
    incoming: Map<string, IncomingConnection[]>,
    nodeOutputs: Map<string, INodeExecutionData[][]>
  ): INodeExecutionData[][] {
    const inputData: INodeExecutionData[][] = [];
    for (const connection of incoming.get(nodeName) ?? []) {
      const sourceOutputs = nodeOutputs.get(connection.source) ?? [];
      const sourceItems = sourceOutputs[connection.sourceOutputIndex] ?? [];
      inputData[connection.destinationInputIndex] = [
        ...(inputData[connection.destinationInputIndex] ?? []),
        ...sourceItems,
      ];
    }
    return inputData.length > 0 ? inputData : [[]];
  }

  private async executeNode(
    node: WorkflowNode,
    inputData: INodeExecutionData[][]
  ): Promise<INodeExecutionData[][]> {
    const nodeType = this.nodeTypes.getByNameAndVersion(node.type);
    const context: IExecuteFunctions = {
      getNode: () => node,
      getInputData: (inputIndex = 0) => inputData[inputIndex] ?? [],
    };
    const output = await nodeType.execute.call(context);
    return output.length > 0 ? output : [[]];
  }

  private async runWorkflow(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode
  ): Promise<WorkflowExecution> {
    const executionId = randomUUID();
    const startedAt = new Date();
    const pending: WorkflowExecution = {
      id: executionId,
      finished: false,
      mode,
      startedAt: startedAt.toISOString(),
      workflowId: workflowData.id ?? '',
      status: 'running',
    };
    await this.saveExecution(pending);

    try {
      const enabledNodes = workflowData.nodes.filter((node) => !node.disabled);
      const nodeByName = new Map(enabledNodes.map((node) => [node.name, node]));
      const incoming = this.buildIncomingConnections(workflowData);
      const startNodes = this.resolveStartNodes(workflowData, mode, incoming);
      const nodeOutputs = new Map<string, INodeExecutionData[][]>();
      const executed = new Set<string>();
      const runData: Record<string, unknown[]> = {};
      let lastNodeExecuted: string | undefined;

      while (executed.size < enabledNodes.length) {
        let progressed = false;

        for (const node of enabledNodes) {
          if (executed.has(node.name)) continue;

          const incomingConnections =
            incoming.get(node.name)?.filter((connection) => nodeByName.has(connection.source)) ??
            [];
          const isStartNode = startNodes.has(node.name);
          const dependenciesComplete = incomingConnections.every((connection) =>
            executed.has(connection.source)
          );

          if (!isStartNode && !dependenciesComplete) continue;

          const inputData =
            isStartNode && incomingConnections.length === 0
              ? [[]]
              : this.collectInputData(node.name, incoming, nodeOutputs);
          const hasInputItems = inputData.some((items) => items.length > 0);
          const started = Date.now();

          const outputData =
            !isStartNode && incomingConnections.length > 0 && !hasInputItems
              ? [[]]
              : await this.executeNode(node, inputData);

          nodeOutputs.set(node.name, outputData);
          runData[node.name] = [
            {
              startTime: started,
              executionTime: Date.now() - started,
              data: { main: cloneJson(outputData) },
              source: incomingConnections.map((connection) => ({
                previousNode: connection.source,
                previousNodeOutput: connection.sourceOutputIndex,
                previousNodeRun: 0,
              })),
            },
          ];
          executed.add(node.name);
          lastNodeExecuted = node.name;
          progressed = true;
        }

        if (!progressed) {
          const unresolved = enabledNodes
            .filter((node) => !executed.has(node.name))
            .map((node) => node.name)
            .join(', ');
          throw new Error(`Unable to resolve workflow execution order for node(s): ${unresolved}`);
        }
      }

      const stoppedAt = new Date();
      const execution: WorkflowExecution = {
        ...pending,
        finished: true,
        status: 'success',
        stoppedAt: stoppedAt.toISOString(),
        data: {
          resultData: {
            runData,
            lastNodeExecuted,
          },
        },
      };
      await this.saveExecution(execution);
      return cloneJson(execution);
    } catch (error) {
      const stoppedAt = new Date();
      const execution: WorkflowExecution = {
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
      await this.saveExecution(execution);
      throw error;
    }
  }
}
