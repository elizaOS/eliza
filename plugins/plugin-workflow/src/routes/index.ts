/** Exports the native Smithers definition, execution, revision, evaluation, approval, and signal routes mounted under `/workflow/*`. */
import type { Route } from '@elizaos/core';

export { type AutomationsRouteContext, handleAutomationsRoutes } from './automations';

// Workflow CRUD is served canonically by the rawPath `/api/workflow/*` surface
// (plugin-routes.ts -> routes/workflow-routes.ts). The relative routes below
// have no rawPath twin, so they stay here.
export const workflowRoutes: Route[] = [];
