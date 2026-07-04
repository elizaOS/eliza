/**
 * Formats a workflow execution into the fields the run UI renders — per-node run
 * rows, a status label with tone, duration in the right unit, and the first
 * surfaced node error.
 */
import type { WorkflowExecution } from '../types/index';

export type WorkflowExecutionTone = 'success' | 'danger' | 'warning' | 'muted';

export interface WorkflowExecutionRunRow {
  nodeName: string;
  status: 'success' | 'error' | 'unknown';
  startTime?: number;
  executionTimeMs?: number;
  itemCount: number;
  preview: string;
  error?: string;
}

export interface WorkflowExecutionSummary {
  statusLabel: string;
  tone: WorkflowExecutionTone;
  durationLabel: string;
  nodeCount: number;
  lastNode?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function countMainItems(data: unknown): number {
  if (!isRecord(data) || !Array.isArray(data.main)) return 0;
  return data.main.reduce((total, output) => {
    if (!Array.isArray(output)) return total;
    return total + output.length;
  }, 0);
}

function previewMainData(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.main)) return 'No output';
  for (const output of data.main) {
    if (!Array.isArray(output)) continue;
    const first = output.find(isRecord);
    if (!first) continue;
    const json = isRecord(first.json) ? first.json : first;
    try {
      const preview = JSON.stringify(json);
      return preview.length > 160 ? `${preview.slice(0, 157)}...` : preview;
    } catch {
      return 'Output could not be previewed';
    }
  }
  return 'No output';
}

function getRunError(run: unknown): string | undefined {
  if (!isRecord(run)) return undefined;
  const error = run.error;
  if (isRecord(error)) {
    return readString(error.message) ?? readString(error.description);
  }
  return readString(error);
}

export function getWorkflowExecutionRunRows(
  execution: WorkflowExecution
): WorkflowExecutionRunRow[] {
  const runData = execution.data?.resultData?.runData;
  if (!runData) return [];

  return Object.entries(runData).flatMap(([nodeName, runs]) => {
    if (!Array.isArray(runs)) return [];
    return runs.map((run): WorkflowExecutionRunRow => {
      const record = isRecord(run) ? run : {};
      const error = getRunError(record);
      const data = record.data;
      return {
        nodeName,
        status: error ? 'error' : execution.status === 'success' ? 'success' : 'unknown',
        startTime: readNumber(record.startTime),
        executionTimeMs: readNumber(record.executionTime),
        itemCount: countMainItems(data),
        preview: previewMainData(data),
        error,
      };
    });
  });
}

export function getWorkflowExecutionError(execution: WorkflowExecution): string | undefined {
  const error = execution.data?.resultData?.error;
  if (error?.message) return error.message;
  for (const row of getWorkflowExecutionRunRows(execution)) {
    if (row.error) return row.error;
  }
  return undefined;
}

export function formatWorkflowExecutionDuration(
  startedAt?: string,
  stoppedAt?: string | null
): string {
  if (!startedAt) return 'Unknown';
  const startMs = Date.parse(startedAt);
  const stopMs = stoppedAt ? Date.parse(stoppedAt) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return 'Unknown';
  const durationMs = Math.max(0, stopMs - startMs);
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  return `${Math.round(durationMs / 60_000)} min`;
}

export function summarizeWorkflowExecution(execution: WorkflowExecution): WorkflowExecutionSummary {
  const rows = getWorkflowExecutionRunRows(execution);
  const status = execution.status;
  const tone: WorkflowExecutionTone =
    status === 'success'
      ? 'success'
      : status === 'error' || status === 'crashed' || status === 'canceled'
        ? 'danger'
        : status === 'running' || status === 'waiting'
          ? 'warning'
          : 'muted';
  const statusLabel =
    status === 'success'
      ? 'Succeeded'
      : status === 'error'
        ? 'Failed'
        : status === 'running'
          ? 'Running'
          : status === 'waiting'
            ? 'Waiting'
            : status.charAt(0).toUpperCase() + status.slice(1);

  return {
    statusLabel,
    tone,
    durationLabel: formatWorkflowExecutionDuration(execution.startedAt, execution.stoppedAt),
    nodeCount: rows.length,
    lastNode: execution.data?.resultData?.lastNodeExecuted,
    error: getWorkflowExecutionError(execution),
  };
}

export function formatWorkflowEngineMetrics(execution: WorkflowExecution): string | null {
  const engine = execution.data?.resultData?.engine;
  if (!engine) return null;
  const skipped = engine.skipped > 0 ? ` / ${engine.skipped} skipped` : '';
  const retries = engine.retries > 0 ? ` / ${engine.retries} retries` : '';
  return `${engine.nodes} nodes / ${engine.levels} levels / ${engine.maxConcurrency} max parallel${skipped}${retries}`;
}

export function buildWorkflowExecutionDiagnostics(execution: WorkflowExecution): string {
  const summary = summarizeWorkflowExecution(execution);
  const rows = getWorkflowExecutionRunRows(execution);
  const engineMetrics = formatWorkflowEngineMetrics(execution);
  const lines = [
    `Workflow execution ${execution.id}`,
    `Status: ${summary.statusLabel}`,
    `Workflow: ${execution.workflowId}`,
    `Mode: ${execution.mode}`,
    `Started: ${execution.startedAt}`,
    `Stopped: ${execution.stoppedAt ?? 'still running'}`,
    `Duration: ${summary.durationLabel}`,
    summary.lastNode ? `Last node: ${summary.lastNode}` : null,
    engineMetrics ? `Engine: ${engineMetrics}` : null,
    summary.error ? `Error: ${summary.error}` : null,
  ].filter((line): line is string => Boolean(line));

  if (rows.length === 0) {
    lines.push('Nodes: none recorded');
    return lines.join('\n');
  }

  lines.push('Nodes:');
  for (const row of rows) {
    const elapsed =
      typeof row.executionTimeMs === 'number' ? `${row.executionTimeMs} ms` : 'unknown';
    const result = row.error ? `error=${row.error}` : `preview=${row.preview}`;
    lines.push(
      `- ${row.nodeName}: ${row.status}; ${row.itemCount} item${
        row.itemCount === 1 ? '' : 's'
      }; ${elapsed}; ${result}`
    );
  }
  return lines.join('\n');
}
