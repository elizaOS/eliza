import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved optimization root directory for disk traces / artifacts.
 *
 * **Why a tiny module (not re-exported only from a fat optimization barrel)?**
 * After moving the optimizer into `@elizaos/plugin-promptopt`, core still needs one
 * stable helper for `AgentRuntime.getOptimizationDir()` and for trajectory JSONL
 * paths so operators can point `OPTIMIZATION_DIR` once and every consumer agrees.
 *
 * **Why default under `~/.eliza/optimization`?** Predictable location for local dev;
 * production should set `OPTIMIZATION_DIR` explicitly when mounting volumes.
 */
export function getOptimizationRootDir(settingValue?: string | null): string {
	if (settingValue && typeof settingValue === "string") {
		return settingValue;
	}
	return join(homedir(), ".eliza", "optimization");
}
