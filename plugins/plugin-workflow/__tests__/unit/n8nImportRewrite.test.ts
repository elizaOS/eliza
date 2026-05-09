import { describe, expect, test } from 'bun:test';

// We re-implement the same rewrite shape as the embedded engine's
// rewriteN8nNodeTypes() so this test pins the contract without needing
// the full service stack (and its pglite startup).

type WorkflowNode = { type: string; [k: string]: unknown };
type WorkflowDefinition = { nodes: WorkflowNode[]; [k: string]: unknown };

function rewriteN8nNodeTypes(workflow: WorkflowDefinition): WorkflowDefinition {
  const needs = workflow.nodes.some((n) => n.type.startsWith('n8n-nodes-base.'));
  if (!needs) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) =>
      n.type.startsWith('n8n-nodes-base.')
        ? { ...n, type: `workflows-nodes-base.${n.type.slice('n8n-nodes-base.'.length)}` }
        : n
    ),
  };
}

describe('n8n input rewrite (pure)', () => {
  test('rewrites n8n-nodes-base.* node types to workflows-nodes-base.*', () => {
    const workflow = {
      name: 'imported',
      nodes: [
        { type: 'n8n-nodes-base.manualTrigger', name: 'A' },
        { type: 'n8n-nodes-base.set', name: 'B' },
      ],
      connections: {},
    };
    const out = rewriteN8nNodeTypes(workflow);
    expect(out.nodes[0]?.type).toBe('workflows-nodes-base.manualTrigger');
    expect(out.nodes[1]?.type).toBe('workflows-nodes-base.set');
    // Other fields untouched.
    expect(out.nodes[0]?.name).toBe('A');
    expect(out.name).toBe('imported');
  });

  test('returns the same object reference when no rewrite is needed', () => {
    const workflow = {
      name: 'native',
      nodes: [{ type: 'workflows-nodes-base.set', name: 'B' }],
      connections: {},
    };
    const out = rewriteN8nNodeTypes(workflow);
    expect(out).toBe(workflow);
  });

  test('does NOT rewrite langchain or other namespaces', () => {
    const workflow = {
      name: 'mixed',
      nodes: [
        { type: '@n8n/n8n-nodes-langchain.openAi', name: 'L' },
        { type: '@elizaos/n8n-nodes-agent.agent', name: 'A' },
        { type: 'n8n-nodes-base.set', name: 'S' },
      ],
      connections: {},
    };
    const out = rewriteN8nNodeTypes(workflow);
    expect(out.nodes[0]?.type).toBe('@n8n/n8n-nodes-langchain.openAi');
    expect(out.nodes[1]?.type).toBe('@elizaos/n8n-nodes-agent.agent');
    expect(out.nodes[2]?.type).toBe('workflows-nodes-base.set');
  });

  test('rewrite is idempotent', () => {
    const once = rewriteN8nNodeTypes({
      name: 'x',
      nodes: [{ type: 'n8n-nodes-base.set', name: 'S' }],
      connections: {},
    });
    const twice = rewriteN8nNodeTypes(once);
    expect(twice).toBe(once);
    expect(twice.nodes[0]?.type).toBe('workflows-nodes-base.set');
  });
});
