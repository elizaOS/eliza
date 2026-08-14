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
    listAutomations(): Promise<AutomationListResponse>;
  }
}

ElizaClient.prototype.listAutomations = async function (
  this: ElizaClient,
): Promise<AutomationListResponse> {
  return workflowSurfaceClient(this).fetch<AutomationListResponse>(
    "/api/automations",
  );
};
