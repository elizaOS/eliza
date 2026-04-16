import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved optimization root directory for disk traces / artifacts.
 *
 * Core exposes this helper so `AgentRuntime.getOptimizationDir()` and plugins
 * agree on a single default when `OPTIMIZATION_DIR` is unset.
 */
export function getOptimizationRootDir(settingValue?: string | null): string {
	if (settingValue && typeof settingValue === "string") {
		return settingValue;
	}
	return join(homedir(), ".eliza", "optimization");
}
