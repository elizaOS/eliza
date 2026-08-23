/** Exercises Smithers workflow normalization through the public persistence service contract. */
import { describe, expect, test } from 'bun:test';
import { compareWorkflowSearchCandidates } from '../../src/services/workflow-service.js';
import { validateSmithersSource } from '../../src/services/smithers-runtime';
import type { WorkflowDefinition } from '../../src/types/index';

function workflow(): WorkflowDefinition {
  return {
    name: 'Review issues',
    description: 'Reviews repository issues with an elizaOS-routed agent.',
    language: 'tsx',
    source: `import { createSmithers } from 'smthrs/create';
const api = createSmithers({}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
export default api.smithers(() => api.Workflow({ name: 'Review issues' }));`,
    steps: [
      { id: 'fetch', label: 'Fetch issues', kind: 'task', agent: 'elizaOS' },
      {
        id: 'review',
        label: 'Review issues',
        kind: 'task',
        dependsOn: ['fetch'],
        agent: 'elizaOS',
      },
    ],
    widgets: [{ id: 'issues', title: 'Issues', surface: 'both', component: 'issue-list' }],
  };
}

describe('workflow contract', () => {
  test('keeps executable source, visual steps, and widgets in one artifact', () => {
    const definition = workflow();
    validateSmithersSource(definition.source);
    expect(definition.steps?.[1]?.dependsOn).toEqual(['fetch']);
    expect(definition.widgets?.[0]?.surface).toBe('both');
    expect('nodes' in definition).toBe(false);
    expect('connections' in definition).toBe(false);
  });

  test('sorts searched workflow candidates safely when score contains NaN', () => {
    const candidates = [
      { workflow: { id: 'wf-nan' } as unknown as import('../../src/types/index.js').WorkflowDefinitionResponse, score: NaN },
      { workflow: { id: 'wf-valid' } as unknown as import('../../src/types/index.js').WorkflowDefinitionResponse, score: 5 },
    ];

    candidates.sort(compareWorkflowSearchCandidates);

    expect(candidates[0]?.workflow.id).toBe('wf-valid');
    expect(candidates[1]?.workflow.id).toBe('wf-nan');
  });

  test('tie-breaks candidates with equal scores by workflow id', () => {
    const candidates = [
      { workflow: { id: 'z-wf' } as unknown as import('../../src/types/index.js').WorkflowDefinitionResponse, score: 5 },
      { workflow: { id: 'a-wf' } as unknown as import('../../src/types/index.js').WorkflowDefinitionResponse, score: 5 },
    ];

    candidates.sort(compareWorkflowSearchCandidates);

    expect(candidates[0]?.workflow.id).toBe('a-wf');
    expect(candidates[1]?.workflow.id).toBe('z-wf');
  });
});
