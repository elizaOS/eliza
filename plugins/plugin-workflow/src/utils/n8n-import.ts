import type { WorkflowDefinition } from '../types/index';

/**
 * One-way input rewrite for upstream n8n workflows.
 *
 * When a user imports an upstream n8n workflow JSON (with `n8n-nodes-base.*`
 * node-type identifiers), the embedded engine rewrites those node types to
 * canonical `workflows-nodes-base.*` so the persisted form is always our
 * internal shape. We do not maintain round-trip portability back to upstream
 * n8n — disk holds workflows-nodes-base.* only.
 *
 * langchain nodes (`@n8n/n8n-nodes-langchain.*`) are intentionally NOT
 * rewritten — that surface is dropped. Workflows that reference langchain
 * nodes will be rejected by the unsupported-node guard with their original
 * identifier in the error message.
 *
 * The function is pure and idempotent: applying it twice is a no-op,
 * applying it to a workflow that has no `n8n-nodes-base.*` nodes returns
 * the same object reference unchanged.
 */
export function rewriteN8nNodeTypes(workflow: WorkflowDefinition): WorkflowDefinition {
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
