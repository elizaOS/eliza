/** Applies the agent server's canonical same-machine trust policy to computer-use routes. */
import type http from "node:http";
import { isTrustedLocalRequest } from "@elizaos/core/security/loopback-trust";

import { isCloudProvisionedContainer } from "@elizaos/plugin-elizacloud/cloud-config/cloud-provisioning";

export function isTrustedComputerUseLocalRequest(
  req: Pick<http.IncomingMessage, "headers"> & {
    socket?: Pick<http.IncomingMessage["socket"], "remoteAddress"> | null;
  },
): boolean {
  return isTrustedLocalRequest(req, {
    localAuthRequired: process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1",
    cloudProvisioned: isCloudProvisionedContainer(),
  });
}
