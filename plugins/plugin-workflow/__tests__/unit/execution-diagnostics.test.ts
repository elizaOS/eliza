// Exercises workflow engine unit behavior and credential handling.
import { describe, expect, it } from 'bun:test';
import type { WorkflowExecution } from '../../src/types/index';
import {
  formatWorkflowExecutionDuration,
  getWorkflowExecutionError,
  summarizeWorkflowExecution,
} from '../../src/utils/execution-diagnostics';

/**
 * Workflow execution diagnostics drive the run UI. Duration formatting picks the
 * right unit, error extraction surfaces the first failure, and status → tone/
 * label mapping must match the engine states a run can be in.
 */

const exec = (over: Partial<WorkflowExecution>): WorkflowExecution =>
  ({ status: 'success', data: { resultData: {} }, ...over }) as unknown as WorkflowExecution;

describe('formatWorkflowExecutionDuration', () => {
  it('picks ms/s/min units, Unknown on missing/invalid', () => {
    expect(formatWorkflowExecutionDuration(undefined)).toBe('Unknown');
    expect(
      formatWorkflowExecutionDuration('2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.500Z')
    ).toBe('500 ms');
    expect(
      formatWorkflowExecutionDuration('2026-06-23T00:00:00.000Z', '2026-06-23T00:00:05.000Z')
    ).toBe('5.0 s');
    expect(
      formatWorkflowExecutionDuration('2026-06-23T00:00:00.000Z', '2026-06-23T00:02:00.000Z')
    ).toBe('2 min');
    expect(formatWorkflowExecutionDuration('not-a-date', '2026-06-23T00:00:00Z')).toBe('Unknown');
  });
});

describe('getWorkflowExecutionError', () => {
  it('returns the result error message, else undefined', () => {
    expect(
      getWorkflowExecutionError(
        exec({ data: { resultData: { error: { message: 'boom' } } } as never })
      )
    ).toBe('boom');
    expect(getWorkflowExecutionError(exec({}))).toBeUndefined();
  });
});

describe('summarizeWorkflowExecution', () => {
  it('maps status to tone + label', () => {
    expect(summarizeWorkflowExecution(exec({ status: 'success' }))).toMatchObject({
      tone: 'success',
      statusLabel: 'Succeeded',
    });
    expect(summarizeWorkflowExecution(exec({ status: 'error' }))).toMatchObject({
      tone: 'danger',
      statusLabel: 'Failed',
    });
    expect(summarizeWorkflowExecution(exec({ status: 'running' }))).toMatchObject({
      tone: 'warning',
      statusLabel: 'Running',
    });
    expect(summarizeWorkflowExecution(exec({ status: 'crashed' as never }))).toMatchObject({
      tone: 'danger',
      statusLabel: 'Crashed',
    });
  });
});
