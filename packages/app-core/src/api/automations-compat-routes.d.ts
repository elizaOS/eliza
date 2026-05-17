/**
 * Automations node-catalog endpoint.
 *
 * The full Automations list/CRUD surface (`GET /api/automations` etc.) lives in
 * `@elizaos/plugin-workflow` (`src/routes/automations.ts`) — the workflow
 * plugin owns the unified workflow + trigger model.
 *
 * This file remains in app-core because the node catalog (`/api/automations/nodes`)
 * is multi-domain: it enumerates runtime actions/providers, static automation
 * specs, and dynamically-registered contributors via
 * `listAutomationNodeContributors()`. Other plugins (LifeOps, etc.) register
 * contributors here, so the registry must live where it can be loaded by all
 * consumers without a workflow plugin dependency.
 */
import type http from "node:http";
import type { CompatRuntimeState } from "./compat-route-shared";
export declare function handleAutomationsCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
//# sourceMappingURL=automations-compat-routes.d.ts.map
