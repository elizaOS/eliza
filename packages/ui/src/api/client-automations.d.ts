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
//# sourceMappingURL=client-automations.d.ts.map
