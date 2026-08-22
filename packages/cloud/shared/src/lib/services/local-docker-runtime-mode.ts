/**
 * Enforces platform-owned runtime markers for loopback-bound local Docker agents.
 */

export function applyLocalDockerRuntimeMode(
  environmentVars: Record<string, string>,
  pairingAllowedPeerCidrs: string,
): Record<string, string> {
  return {
    ...environmentVars,
    ELIZA_CLOUD_PROVISIONED: "1",
    ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
    ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: pairingAllowedPeerCidrs,
  };
}
