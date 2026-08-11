/**
 * Enforces the platform-owned pairing mode for remotely hosted agent
 * containers at each environment handoff and immediately before Docker.
 */

export function applyRemoteDockerRuntimeMode(
  environmentVars: Record<string, string>,
): Record<string, string> {
  return {
    ...environmentVars,
    ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
  };
}
