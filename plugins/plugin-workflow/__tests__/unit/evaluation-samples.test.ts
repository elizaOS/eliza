/** Unit tests for `buildWorkflowEvaluationSuite` JSONL sampling from executions (deterministic). */
import { describe, expect, test } from 'bun:test';
import { buildWorkflowEvaluationSuite } from '../../src/utils/evaluation-samples';
import { createExecution, createWorkflowResponse } from '../fixtures/workflows';

describe('buildWorkflowEvaluationSuite', () => {
  test('builds Smithers JSONL samples from successful workflow executions', () => {
    const workflow = createWorkflowResponse({
      id: 'wf-cerebras',
      versionId: 'version-1',
      name: 'Cerebras review workflow',
    });
    const execution = createExecution({
      id: 'exec-success',
      workflowId: 'wf-cerebras',
      mode: 'trigger',
      customData: {
        triggerData: {
          model: 'cerebras/gpt-oss-120b',
          prompt: 'Review this workflow.',
        },
      },
      data: {
        resultData: {
          lastNodeExecuted: 'Add Review Fields',
          engine: {
            provider: 'smithers',
            nodes: 2,
            levels: 2,
            maxConcurrency: 1,
            started: 2,
            finished: 2,
            failed: 0,
            skipped: 0,
            retries: 0,
          },
          runData: {
            'Add Review Fields': [
              {
                executionTime: 8,
                data: {
                  main: [[{ json: { source: 'cerebras', verified: true } }]],
                },
              },
            ],
          },
        },
      },
    });

    const suite = buildWorkflowEvaluationSuite(workflow, [execution], {
      generatedAt: '2026-06-20T12:00:00.000Z',
    });
    const sample = JSON.parse(suite.jsonl) as (typeof suite.samples)[number];

    expect(suite.sampleCount).toBe(1);
    expect(suite.optimizer.engine).toBe('smithers-gepa');
    expect(suite.optimizer.caseFile).toBe('evals/cerebras-review-workflow.jsonl');
    expect(suite.optimizer.suiteName).toBe('cerebras-review-workflow');
    expect(suite.optimizer.recommendedCommand).toContain('smithers-orchestrator eval');
    expect(suite.optimizer.recommendedEvalCommand).toContain(
      '--cases evals/cerebras-review-workflow.jsonl --suite cerebras-review-workflow'
    );
    expect(suite.optimizer.recommendedOptimizeCommand).toBe('bunx smithers-orchestrator optimize');
    expect(suite.optimizer.recommendedObservabilityCommand).toBe(
      'bunx smithers-orchestrator observability --detach'
    );
    expect(suite.optimizer.recommendedMetricsCommand).toBe(
      'bunx smithers-orchestrator up <workflow.tsx> --serve --metrics'
    );
    expect(sample.input.triggerData?.model).toBe('cerebras/gpt-oss-120b');
    expect(sample.expected.passed).toBe(true);
    expect(sample.expected.engine?.provider).toBe('smithers');
    expect(sample.expected.nodes[0]).toEqual(
      expect.objectContaining({
        name: 'Add Review Fields',
        status: 'success',
        itemCount: 1,
        preview: '{"source":"cerebras","verified":true}',
      })
    );
    expect(sample.score).toEqual({
      pass: true,
      value: 1,
      reason: 'Execution completed successfully.',
    });
  });

  test('preserves failed executions as regression samples', () => {
    const workflow = createWorkflowResponse({ id: 'wf-fail' });
    const execution = createExecution({
      id: 'exec-fail',
      workflowId: 'wf-fail',
      status: 'error',
      data: {
        resultData: {
          error: { message: 'HTTP request failed' },
          runData: {
            'HTTP Request': [
              {
                executionTime: 12,
                error: { message: 'HTTP request failed' },
                data: { main: [[]] },
              },
            ],
          },
        },
      },
    });

    const suite = buildWorkflowEvaluationSuite(workflow, [execution]);

    expect(suite.samples[0].expected.error).toBe('HTTP request failed');
    expect(suite.samples[0].expected.nodes[0]).toEqual(
      expect.objectContaining({
        name: 'HTTP Request',
        status: 'error',
        error: 'HTTP request failed',
      })
    );
    expect(suite.samples[0].score).toEqual({
      pass: false,
      value: 0,
      reason: 'Execution failed: HTTP request failed',
    });
  });

  test('limits samples for compact clipboard exports', () => {
    const workflow = createWorkflowResponse();
    const executions = [
      createExecution({ id: 'exec-1' }),
      createExecution({ id: 'exec-2' }),
      createExecution({ id: 'exec-3' }),
    ];

    const suite = buildWorkflowEvaluationSuite(workflow, executions, { limit: 2 });

    expect(suite.sampleCount).toBe(2);
    expect(suite.samples.map((sample) => sample.executionId)).toEqual(['exec-1', 'exec-2']);
    expect(suite.jsonl.split('\n')).toHaveLength(2);
  });
});
