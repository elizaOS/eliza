import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAppAliasedEnvValue as resolveAliasedEnvValue } from "@elizaos/host/protocol";
export function resolveDefaultVaultRoot(workDir?: string): string {
  const namespace =
    resolveAliasedEnvValue("ELIZA_NAMESPACE")?.trim() || "eliza";
  return (
    workDir ??
    resolveAliasedEnvValue("ELIZA_STATE_DIR")?.trim() ??
    (process.env.XDG_STATE_HOME?.trim()
      ? join(process.env.XDG_STATE_HOME.trim(), namespace)
      : join(homedir(), ".local", "state", namespace))
  );
}
