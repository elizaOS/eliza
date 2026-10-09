import {
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import { DeviceActionError } from "@elizaos/plugin-assistant";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
/** Bind local OWNER enrollment to the canonical workflow scope without changing
 * the authenticated subject used by phone approvals. No request fields choose it. */
export function workflowDeviceOwner(
  runtime: IAgentRuntime,
  authorization: AgentHttpRequestAuthorization | undefined,
  subjectUserId: string,
): string {
  if (
    !authorization?.ok ||
    !["USER", "ADMIN", "OWNER"].includes(authorization.role) ||
    (authorization.identityId ??
      (authorization.principal
        ? `gateway:${authorization.principal}`
        : undefined)) !== subjectUserId
  )
    throw new DeviceActionError("Verified device subject required");
  return authorization.role === "OWNER" && !authorization.externalIdentity
    ? resolveOwnerEntityIdOrDefault(runtime)
    : subjectUserId;
}
