/**
 * Builds compact evaluation suites from a workflow's past executions — sampling
 * node inputs/outputs into bounded JSONL cases for the Smithers eval / GEPA
 * optimize flows. Preview and depth/size limits keep each case small.
 */
import type {
  WorkflowDefinitionResponse,
  WorkflowEvaluationSample,
  WorkflowEvaluationSampleNode,
  WorkflowEvaluationSuite,
  WorkflowExecution,
} from '../types/index';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_PREVIEW_LENGTH = 240;
const MAX_SAMPLE_VALUE_DEPTH = 4;
const MAX_SAMPLE_OBJECT_KEYS = 20;
const MAX_SAMPLE_ARRAY_ITEMS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

function truncate(value: string, maxLength = MAX_PREVIEW_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncate(value, MAX_PREVIEW_LENGTH);
  }
  if (depth >= MAX_SAMPLE_VALUE_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SAMPLE_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
  }
  if (!isRecord(value)) {
    return String(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_SAMPLE_OBJECT_KEYS)
      .map(([key, item]) => [key, compactValue(item, depth + 1)])
  );
}

function compactRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const compacted = compactValue(value);
  return isRecord(compacted) ? compacted : undefined;
}

function countMainItems(data: unknown): number {
  if (!isRecord(data) || !Array.isArray(data.main)) return 0;
  return data.main.reduce((total, output) => {
    if (!Array.isArray(output)) return total;
    return total + output.length;
  }, 0);
}

function previewMainData(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.main)) return undefined;
  for (const output of data.main) {
    if (!Array.isArray(output)) continue;
    const first = output.find(isRecord);
    if (!first) continue;
    const json = isRecord(first.json) ? first.json : first;
    try {
      return truncate(JSON.stringify(compactValue(json)));
    } catch {
      return 'Output could not be previewed';
    }
  }
  return undefined;
}

function readRunError(run: unknown): string | undefined {
  if (!isRecord(run)) return undefined;
  const error = run.error;
  if (isRecord(error)) {
    return readString(error.message) ?? readString(error.description);
  }
  return readString(error);
}

function readExecutionError(execution: WorkflowExecution): string | undefined {
  const error = execution.data?.resultData?.error;
  if (error?.message) return error.message;
  for (const node of collectNodeSamples(execution)) {
    if (node.error) return node.error;
  }
  return undefined;
}

function collectNodeSamples(execution: WorkflowExecution): WorkflowEvaluationSampleNode[] {
  const runData = execution.data?.resultData?.runData;
  if (!runData) return [];

  return Object.entries(runData).flatMap(([name, runs]) => {
    if (!Array.isArray(runs)) return [];
    return runs.map((run): WorkflowEvaluationSampleNode => {
      const record = isRecord(run) ? run : {};
      const error = readRunError(record);
      const preview = previewMainData(record.data);
      return {
        name,
        status: error ? 'error' : execution.status === 'success' ? 'success' : 'unknown',
        itemCount: countMainItems(record.data),
        ...(readNumber(record.executionTime) !== undefined
          ? { executionTimeMs: readNumber(record.executionTime) }
          : {}),
        ...(error ? { error } : {}),
        ...(preview ? { preview } : {}),
      };
    });
  });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function buildSample(
  workflow: WorkflowDefinitionResponse,
  execution: WorkflowExecution
): WorkflowEvaluationSample {
  const passed = execution.status === 'success';
  const workflowId = workflow.id;
  const triggerData = compactRecord(execution.customData?.triggerData);
  const error = readExecutionError(execution);
  const nodes = collectNodeSamples(execution);
  const scoreReason = passed
    ? 'Execution completed successfully.'
    : error
      ? `Execution failed: ${error}`
      : `Execution finished with status ${execution.status}.`;

  return {
    id: `${workflowId}:${execution.id}`,
    workflowId,
    workflowName: workflow.name,
    workflowVersionId: workflow.versionId,
    executionId: execution.id,
    createdAt: execution.stoppedAt ?? execution.startedAt,
    input: {
      mode: execution.mode,
      ...(triggerData ? { triggerData } : {}),
    },
    expected: {
      status: execution.status,
      passed,
      ...(execution.data?.resultData?.lastNodeExecuted
        ? { lastNodeExecuted: execution.data.resultData.lastNodeExecuted }
        : {}),
      ...(execution.data?.resultData?.engine ? { engine: execution.data.resultData.engine } : {}),
      ...(error ? { error } : {}),
      nodes,
    },
    score: {
      pass: passed,
      value: passed ? 1 : 0,
      reason: scoreReason,
    },
    tags: [
      'smithers',
      'workflow-eval',
      `workflow:${workflowId}`,
      `status:${execution.status}`,
      `mode:${execution.mode}`,
    ],
  };
}

export function buildWorkflowEvaluationSuite(
  workflow: WorkflowDefinitionResponse,
  executions: WorkflowExecution[],
  options?: { limit?: number; generatedAt?: string }
): WorkflowEvaluationSuite {
  const limit = clampLimit(options?.limit);
  const samples = executions.slice(0, limit).map((execution) => buildSample(workflow, execution));
  const safeName = slugify(workflow.name) || slugify(workflow.id) || 'workflow';
  const suiteName = safeName;
  const caseFile = `evals/${suiteName}.jsonl`;
  const recommendedEvalCommand = `bunx smithers-orchestrator eval <workflow.tsx> --cases ${caseFile} --suite ${suiteName}`;
  const recommendedOptimizeCommand = 'bunx smithers-orchestrator optimize';
  const recommendedObservabilityCommand = 'bunx smithers-orchestrator observability --detach';
  const recommendedMetricsCommand =
    'bunx smithers-orchestrator up <workflow.tsx> --serve --metrics';
  const jsonl = samples.map((sample) => JSON.stringify(sample)).join('\n');
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersionId: workflow.versionId,
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    sampleCount: samples.length,
    samples,
    jsonl,
    optimizer: {
      engine: 'smithers-gepa',
      target: 'workflow-generation',
      suiteName,
      caseFile,
      recommendedCommand: recommendedEvalCommand,
      recommendedEvalCommand,
      recommendedOptimizeCommand,
      recommendedObservabilityCommand,
      recommendedMetricsCommand,
      notes: [
        `Copy jsonl to ${caseFile} before running eval.`,
        'Run GEPA optimization after the eval suite is configured; Smithers writes an optimized prompt artifact only when score improves.',
        'Use the observability and metrics commands when inspecting long-running or flaky workflows.',
        'Successful executions are positive examples; failed executions remain useful regression cases.',
        'Samples are generated from persisted workflow executions and compact large payloads.',
      ],
    },
  };
}
