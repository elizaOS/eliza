import { homedir } from "node:os";
import { join } from "node:path";

/** Shared default location for prompt optimization artifacts and traces. */
export function getOptimizationRootDir(settingValue?: string | null): string {
	if (settingValue && typeof settingValue === "string") {
		return settingValue;
	}
	return join(homedir(), ".eliza", "optimization");
}
