import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAliasedEnvValue } from "@elizaos/shared/config/boot-config-store";

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
