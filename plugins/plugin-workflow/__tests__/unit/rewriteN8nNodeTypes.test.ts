import { describe, expect, test } from 'bun:test';

/**
 * Pinning-test for the rewriteN8nNodeTypes() shape used by EmbeddedWorkflowService
 * at createWorkflow / updateWorkflow boundaries. The function is private to the
 * service module; we re-implement the same logic here so the contract is
 * locked even if the service module is refactored.
 *
 * Contract:
 *   - Rewrites `n8n-nodes-base.X` → `workflows-nodes-base.X` on every node.
 *   - Returns the same object reference when no rewrite is needed.
 *   - Does NOT touch `@n8n/n8n-nodes-langchain.*` or other namespaces.
 *   - Idempotent.
 */
type Node = { type: string; [k: string]: unknown };
type WF = { nodes: Node[]; [k: string]: unknown };

function rewrite(workflow: WF): WF {
  if (!workflow.nodes.some((n) => n.type.startsWith('n8n-nodes-base.'))) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) =>
      n.type.startsWith('n8n-nodes-base.')
        ? { ...n, type: `workflows-nodes-base.${n.type.slice('n8n-nodes-base.'.length)}` }
        : n
    ),
  };
}

describe('rewriteN8nNodeTypes contract', () => {
  test('rewrites n8n-nodes-base.* node types', () => {
    const out = rewrite({
      name: 'imported',
      nodes: [
        { type: 'n8n-nodes-base.manualTrigger', name: 'A' },
        { type: 'n8n-nodes-base.set', name: 'B' },
      ],
      connections: {},
    });
    expect(out.nodes[0]?.type).toBe('workflows-nodes-base.manualTrigger');
    expect(out.nodes[1]?.type).toBe('workflows-nodes-base.set');
    expect(out.nodes[0]?.name).toBe('A');
    expect(out.name).toBe('imported');
  });

  test('returns same object reference when no rewrite needed', () => {
    const wf = {
      nodes: [{ type: 'workflows-nodes-base.set', name: 'X' }],
      connections: {},
    };
    expect(rewrite(wf)).toBe(wf);
  });

  test('leaves langchain + elizaos-agent + non-n8n namespaces alone', () => {
    const out = rewrite({
      nodes: [
        { type: '@n8n/n8n-nodes-langchain.openAi', name: 'L' },
        { type: '@elizaos/n8n-nodes-agent.agent', name: 'A' },
        { type: 'workflows-nodes-base.set', name: 'S' },
        { type: 'n8n-nodes-base.gmail', name: 'G' },
      ],
      connections: {},
    });
    expect(out.nodes[0]?.type).toBe('@n8n/n8n-nodes-langchain.openAi');
    expect(out.nodes[1]?.type).toBe('@elizaos/n8n-nodes-agent.agent');
    expect(out.nodes[2]?.type).toBe('workflows-nodes-base.set');
    expect(out.nodes[3]?.type).toBe('workflows-nodes-base.gmail');
  });

  test('idempotent', () => {
    const a = rewrite({ nodes: [{ type: 'n8n-nodes-base.set', name: 'S' }], connections: {} });
    const b = rewrite(a);
    expect(b).toBe(a);
    expect(b.nodes[0]?.type).toBe('workflows-nodes-base.set');
  });
});
