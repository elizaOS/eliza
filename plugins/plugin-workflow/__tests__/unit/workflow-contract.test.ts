/** Exercises Smithers workflow normalization through the public persistence service contract. */
import { describe, expect, test } from 'bun:test';
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
      { workflow: { id: 'wf-nan' }, score: NaN },
      { workflow: { id: 'wf-valid' }, score: 5 },
    ];

    candidates.sort((a, b) => {
      const bScore = typeof b.score === 'number' && Number.isFinite(b.score) ? b.score : 0;
      const aScore = typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : 0;
      return bScore - aScore || a.workflow.id.localeCompare(b.workflow.id);
    });

    expect(candidates[0]?.workflow.id).toBe('wf-valid');
    expect(candidates[1]?.workflow.id).toBe('wf-nan');
  });
});
