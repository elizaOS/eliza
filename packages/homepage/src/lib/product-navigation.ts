/**
 * Resolves homepage authentication and managed-Cloud destinations from the
 * canonical environment contract for the browser's current hostname.
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  elizaCloudEnvironmentForHostname,
} from "@elizaos/shared/elizacloud/domain-contract";

export interface HomepageProductNavigation {
  signInUrl: string;
  dashboardUrl: string;
}

export function resolveHomepageProductNavigation(
  hostname: string,
): HomepageProductNavigation {
  const environment =
    elizaCloudEnvironmentForHostname(hostname) ?? "production";
  const cloudAppOrigin = ELIZA_DOMAIN_CONTRACTS[environment].cloudAppOrigin;

  return {
    signInUrl: `${cloudAppOrigin}/login?returnTo=%2Fcloud`,
    dashboardUrl: `${cloudAppOrigin}/cloud`,
  };
}
