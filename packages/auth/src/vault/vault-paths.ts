import { homedir } from "node:os";
import { join } from "node:path";
export function resolveDefaultVaultRoot(workDir?: string): string {
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  return (
    workDir ??
    (process.env.ELIZA_STATE_DIR?.trim() ||
      (process.env.XDG_STATE_HOME?.trim()
        ? join(process.env.XDG_STATE_HOME.trim(), namespace)
        : join(homedir(), ".local", "state", namespace)))
  );
}
