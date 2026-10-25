/** Carries a verified host session into plugin disclosure checks without promoting guest sessions to owner authority. */
import {
  type AccessContext,
  ElizaError,
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
  stringToUuid,
  validateUuid,
} from "@elizaos/core";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";

export function resolveHostSessionAccessContext(
  authorization: AgentHttpRequestAuthorization,
  runtime: IAgentRuntime,
): AccessContext | undefined {
  if (!authorization.ok) return undefined;
  if (authorization.role === "OWNER") {
    return {
      requesterEntityId: resolveOwnerEntityIdOrDefault(runtime),
      role: "OWNER",
      isOwner: true,
      source: "host-session",
    };
  }
  const principal = authorization.identityId ?? authorization.principal;
  if (!principal) {
    throw new ElizaError(
      "Authenticated plugin access requires a stable session identity",
      {
        code: "HTTP_SESSION_PRINCIPAL_REQUIRED",
        context: { role: authorization.role },
      },
    );
  }
  return {
    requesterEntityId:
      validateUuid(principal) ?? stringToUuid(`host-session:${principal}`),
    role: authorization.role === "USER" ? "USER" : "GUEST",
    isOwner: false,
    source: "host-session",
  };
}
