/**
 * ElizaClient extension (declaration-merged) for the native automations feed.
 * Requests go through
 * `workflowSurfaceClient` so a mobile device whose bundled runtime cannot host
 * plugin-workflow serves the surface from its linked Cloud agent instead.
 */
import { ElizaClient } from "./client-base";
import type { AutomationListResponse } from "./client-types-config";
import { workflowSurfaceClient } from "./workflow-surface-routing";

declare module "./client-base" {
  interface ElizaClient {
    listAutomations(options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<AutomationListResponse>;
  }
}

ElizaClient.prototype.listAutomations = async function (
  this: ElizaClient,
  options,
): Promise<AutomationListResponse> {
  const routed = workflowSurfaceClient(this);
  if (!options) {
    return routed.fetch<AutomationListResponse>("/api/automations");
  }
  return routed.fetch<AutomationListResponse>(
    "/api/automations",
    { signal: options.signal },
    { timeoutMs: options.timeoutMs },
  );
};
