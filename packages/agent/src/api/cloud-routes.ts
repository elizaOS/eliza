/** Lazy host adapters for cloud routes; implementation belongs to plugin-elizacloud. */
import type {
  AgentCloudBillingRouteHandler,
  AgentCloudCompatRouteHandler,
  AgentCloudRouteHandler,
} from "./cloud-route-contracts.ts";

export interface CloudConfigLike {
  apiKey?: string | null;
  baseUrl?: string | null;
  [key: string]: unknown;
}
type CloudUrlValidator = (value: string) => Promise<string | null>;
type ElizaCloudRoutesModule = {
  handleCloudBillingRoute: AgentCloudBillingRouteHandler;
  handleCloudCompatRoute: AgentCloudCompatRouteHandler;
  handleCloudRoute: AgentCloudRouteHandler;
  validateCloudBaseUrl: CloudUrlValidator;
};
async function loadElizaCloudRoutes(): Promise<ElizaCloudRoutesModule> {
  return import(
    "@elizaos/plugin-elizacloud"
  ) as Promise<ElizaCloudRoutesModule>;
}
export const handleCloudBillingRoute: AgentCloudBillingRouteHandler = async (
  ...args
) => {
  const { handleCloudBillingRoute } = await loadElizaCloudRoutes();
  return handleCloudBillingRoute(...args);
};
export const handleCloudCompatRoute: AgentCloudCompatRouteHandler = async (
  ...args
) => {
  const { handleCloudCompatRoute } = await loadElizaCloudRoutes();
  return handleCloudCompatRoute(...args);
};
export const handleCloudRoute: AgentCloudRouteHandler = async (...args) => {
  const { handleCloudRoute } = await loadElizaCloudRoutes();
  return handleCloudRoute(...args);
};
export async function validateCloudBaseUrl(
  value: string,
): Promise<string | null> {
  const { validateCloudBaseUrl } = await loadElizaCloudRoutes();
  return validateCloudBaseUrl(value);
}
