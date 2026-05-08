/**
 * The plugin no longer registers any actions. The single `WORKFLOW` umbrella
 * action lives in `@elizaos/agent` (packages/agent/src/actions/workflow/),
 * and dispatches all n8n + trigger ops via op-based routing. The plugin
 * provides the routes/services/providers that WORKFLOW reaches into.
 */
export {};
