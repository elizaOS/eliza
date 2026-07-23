/**
 * ElizaClient extension (declaration-merged) for the automations feed: list
 * workflows and fetch the node catalog. Requests go through
 * `workflowSurfaceClient` so a mobile device whose bundled runtime cannot host
 * plugin-workflow serves the surface from its linked Cloud agent instead.
 */
import { ElizaClient } from "./client-base";
import type {
  AutomationListResponse,
  AutomationNodeCatalogResponse,
} from "./client-types-config";
import { workflowSurfaceClient } from "./workflow-surface-routing";

declare module "./client-base" {
  interface ElizaClient {
    listAutomations(): Promise<AutomationListResponse>;
    getAutomationNodeCatalog(): Promise<AutomationNodeCatalogResponse>;
  }
}

ElizaClient.prototype.listAutomations = async function (
  this: ElizaClient,
): Promise<AutomationListResponse> {
  return workflowSurfaceClient(this).fetch<AutomationListResponse>(
    "/api/automations",
  );
};

ElizaClient.prototype.getAutomationNodeCatalog = async function (
  this: ElizaClient,
): Promise<AutomationNodeCatalogResponse> {
  return workflowSurfaceClient(this).fetch<AutomationNodeCatalogResponse>(
    "/api/automations/nodes",
  );
};
