/**
 * Automation-node catalog contract shared between the Node API that builds the
 * catalog (`@elizaos/app-core` automation routes) and the React client that
 * renders it (`@elizaos/ui`). Kept here so the Node side can type its route
 * handlers without importing React UI internals; `@elizaos/ui` re-exports these
 * from `api/client-types-config` for the renderer.
 */

export type AutomationNodeClass =
  | "trigger"
  | "action"
  | "context"
  | "integration"
  | "agent"
  | "flow-control";

export interface AutomationNodeDescriptor {
  id: string;
  label: string;
  description: string;
  class: AutomationNodeClass;
  source: string;
  backingCapability: string;
  ownerScoped: boolean;
  requiresSetup: boolean;
  availability: "enabled" | "disabled";
  disabledReason?: string;
}

export interface AutomationNodeCatalogResponse {
  nodes: AutomationNodeDescriptor[];
  summary: {
    total: number;
    enabled: number;
    disabled: number;
  };
}
