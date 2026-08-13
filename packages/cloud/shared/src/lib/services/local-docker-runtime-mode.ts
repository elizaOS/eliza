/**
 * Enforces platform-owned runtime markers for loopback-bound local Docker agents.
 */

export function applyLocalDockerRuntimeMode(
  environmentVars: Record<string, string>,
): Record<string, string> {
  const pgliteDataDir = environmentVars.PGLITE_DATA_DIR?.replace(/^\/root(?=\/|$)/, "/home/agent");
  return {
    ...environmentVars,
    ...(pgliteDataDir ? { PGLITE_DATA_DIR: pgliteDataDir } : {}),
    ELIZA_CLOUD_PROVISIONED: "1",
    ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
  };
}
