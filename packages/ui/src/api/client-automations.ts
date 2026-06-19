import { ElizaClient } from "./client-base";
import type {
  AutomationListResponse,
  AutomationNodeCatalogResponse,
} from "./client-types-config";

declare module "./client-base" {
  interface ElizaClient {
    listAutomations(): Promise<AutomationListResponse>;
    getAutomationNodeCatalog(): Promise<AutomationNodeCatalogResponse>;
  }
}

ElizaClient.prototype.listAutomations = async function (
  this: ElizaClient,
): Promise<AutomationListResponse> {
  return this.fetch<AutomationListResponse>("/api/automations");
};

ElizaClient.prototype.getAutomationNodeCatalog = async function (
  this: ElizaClient,
): Promise<AutomationNodeCatalogResponse> {
  return this.fetch<AutomationNodeCatalogResponse>("/api/automations/nodes");
};
