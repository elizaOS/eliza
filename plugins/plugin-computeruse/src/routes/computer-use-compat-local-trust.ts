/** Applies the agent server's canonical same-machine trust policy to computer-use routes. */
import type http from "node:http";
import { isTrustedLocalRequest } from "@elizaos/shared";

export function isTrustedComputerUseLocalRequest(
  req: Pick<http.IncomingMessage, "headers"> & {
    socket?: Pick<http.IncomingMessage["socket"], "remoteAddress"> | null;
  },
): boolean {
  return isTrustedLocalRequest(req, {
    requireLocalAuthEnv: true,
    devAuthBypassEnv: false,
    cloudCheck: "container",
  });
}
