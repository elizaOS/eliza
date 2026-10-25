/** Fixed first-party origins for credentialed deployed-browser smoke tests. */
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";

export function cloudLiveDeployedRendererOrigin(
  environment: string | undefined,
): string {
  if (environment === "production")
    return ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin;
  if (!environment || environment === "staging") {
    return "https://staging.eliza-app.pages.dev";
  }
  throw new Error("Unsupported deployed Cloud smoke environment");
}
