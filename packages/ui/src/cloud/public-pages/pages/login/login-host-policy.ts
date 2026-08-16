/**
 * Decides whether a public login route authenticates on its current origin or
 * hands a dedicated managed-agent host to the paired Cloud SSO origin.
 */
import { isElizaDedicatedAgentHostname } from "@elizaos/shared/elizacloud";

export type LoginHostMode = "same-origin" | "sso-handoff";

export function resolveLoginHostMode(hostname: string): LoginHostMode {
  return isElizaDedicatedAgentHostname(hostname)
    ? "sso-handoff"
    : "same-origin";
}
