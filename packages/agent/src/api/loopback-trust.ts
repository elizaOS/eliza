/** Agent host environment policy for strict same-machine request classification. */

import { readAliasedEnv } from "@elizaos/core";
import { isTrustedLocalRequest as classifyLocalRequest } from "@elizaos/core/security/loopback-trust";
import { isCloudProvisionedContainer } from "@elizaos/plugin-elizacloud/cloud-config/cloud-provisioning";

export {
  isLoopbackRemoteAddress,
  isRemoteAddressInCidrList,
  proxyClientHeaderBlocksLocalTrust,
} from "@elizaos/core/security/loopback-trust";
export interface LoopbackTrustOptions {
  /**
   * When true, deny local trust if `ELIZA_REQUIRE_LOCAL_AUTH === "1"`. On-device
   * local agents (Android) set this flag alongside a per-boot API token because
   * the loopback interface is shared with every other app on the device, so
   * loopback alone is NOT a trust signal there.
   */
  requireLocalAuthEnv: boolean;
  /**
   * When true, `ELIZA_DEV_AUTH_BYPASS === "1"` in a development `NODE_ENV`
   * overrides {@link requireLocalAuthEnv}, restoring local trust for the dev
   * dashboard. Only app honours this; the agent never does.
   */
  devAuthBypassEnv: boolean;
  /**
   * Cloud-container detection strategy. `"env"` trusts the raw
   * `ELIZA_CLOUD_PROVISIONED` flag; `"container"` requires the flag AND a
   * provisioning token (see {@link isCloudProvisionedContainer}). These are
   * DIFFERENT semantics — do not swap them between consumers.
   */
  cloudCheck: "env" | "container";
}

function cloudBlocksLocalTrust(cloudCheck: "env" | "container"): boolean {
  if (cloudCheck === "container") return isCloudProvisionedContainer();
  return readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1";
}

function localAuthRequired(options: LoopbackTrustOptions): boolean {
  if (!options.requireLocalAuthEnv) return false;
  if (
    options.devAuthBypassEnv &&
    process.env.ELIZA_DEV_AUTH_BYPASS === "1" &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev")
  ) {
    return false;
  }
  return process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1";
}

export function isTrustedLocalRequest(
  req: Parameters<typeof classifyLocalRequest>[0],
  options: LoopbackTrustOptions,
): boolean {
  return classifyLocalRequest(req, {
    localAuthRequired: localAuthRequired(options),
    cloudProvisioned: cloudBlocksLocalTrust(options.cloudCheck),
  });
}
