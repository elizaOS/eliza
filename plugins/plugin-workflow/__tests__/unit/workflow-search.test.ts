// Exercises workflow engine unit behavior and credential handling.
import { describe, expect, test } from 'bun:test';
import {
  rankWorkflowsByQuery,
  scoreWorkflowMatch,
  tokenizeWorkflowSearchQuery,
} from '../../src/services/workflow-service';

/**
 * Unit coverage for the WORKFLOW `search` op ranking (#8913).
 */
function wf(overrides: Record<string, unknown>) {
  return {
    id: String(overrides.id ?? 'id'),
    name: 'untitled',
    nodes: [],
    createdAt: '',
    updatedAt: '',
    versionId: 'v1',
    ...overrides,
  } as never;
}

describe('scoreWorkflowMatch', () => {
  test('ranks an exact name match above a prefix above a substring', () => {
    const exact = scoreWorkflowMatch(wf({ name: 'slack' }), 'slack');
    const prefix = scoreWorkflowMatch(wf({ name: 'slack notifier' }), 'slack');
    const sub = scoreWorkflowMatch(wf({ name: 'my slack thing' }), 'slack');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(0);
  });

  test('matches node type and description, name still wins', () => {
    const byNode = scoreWorkflowMatch(
      wf({ name: 'x', nodes: [{ type: 'n8n-nodes-base.slack' }] }),
      'slack'
    );
    const byDesc = scoreWorkflowMatch(wf({ name: 'x', description: 'posts to slack' }), 'slack');
    const byName = scoreWorkflowMatch(wf({ name: 'slack' }), 'slack');
    expect(byNode).toBeGreaterThan(0);
    expect(byDesc).toBeGreaterThan(0);
    expect(byName).toBeGreaterThan(byNode);
  });

  test('no match scores zero', () => {
    expect(scoreWorkflowMatch(wf({ name: 'gmail digest' }), 'slack')).toBe(0);
  });

  test('matches a sentence query by meaningful tokens', () => {
    const score = scoreWorkflowMatch(
      wf({
        name: 'Team notifications',
        nodes: [{ type: 'workflows-nodes-base.slack', name: 'Slack' }],
      }),
      'find the workflow that posts to Slack'
    );

    expect(score).toBeGreaterThan(0);
  });
});

describe('rankWorkflowsByQuery', () => {
  const workflows = [
    wf({ id: 'a', name: 'Gmail digest' }),
    wf({ id: 'b', name: 'Slack notifier' }),
    wf({ id: 'c', name: 'Daily report', description: 'sends a slack summary' }),
  ];

  test('returns only matches, best first', () => {
    const ranked = rankWorkflowsByQuery(workflows, 'slack');
    expect(ranked.map((w) => w.id)).toEqual(['b', 'c']);
  });

  test('sentence query uses per-token OR scoring', () => {
    const ranked = rankWorkflowsByQuery(workflows, 'find the workflow that posts to Slack');
    expect(ranked.map((w) => w.id)).toEqual(['b', 'c']);
  });

  test('generic workflow query returns the input unchanged', () => {
    const ranked = rankWorkflowsByQuery(workflows, 'what workflows do I have?');
    expect(ranked.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  test('empty query returns the input unchanged', () => {
    const ranked = rankWorkflowsByQuery(workflows, '   ');
    expect(ranked.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('tokenizeWorkflowSearchQuery', () => {
  test('keeps useful terms and drops workflow/search boilerplate', () => {
    expect(tokenizeWorkflowSearchQuery('find the workflow that posts to Slack')).toEqual([
      'post',
      'slack',
    ]);
  });
});
