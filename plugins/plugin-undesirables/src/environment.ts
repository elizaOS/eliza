import type { IAgentRuntime } from "@elizaos/core";
import * as fs from "fs";
import * as path from "path";

/**
 * Validates that the Undesirables plugin has all required configuration.
 * Called during plugin init.
 */
export function validateUndesirableConfig(
  runtime: IAgentRuntime
): { valid: boolean; error?: string; workspacePath?: string } {
  const workspacePath =
    (runtime.getSetting?.("UNDESIRABLES_WORKSPACE") as string) ||
    process.env.UNDESIRABLES_WORKSPACE ||
    "";

  if (!workspacePath) {
    return {
      valid: false,
      error:
        "UNDESIRABLES_WORKSPACE is required. Set it in your character.json settings " +
        "or as an environment variable. Point it to the absolute path of your downloaded soul workspace folder.",
    };
  }

  if (!fs.existsSync(workspacePath)) {
    return {
      valid: false,
      error: `UNDESIRABLES_WORKSPACE path does not exist: "${workspacePath}". ` +
        "Make sure you've downloaded and unzipped your soul workspace.",
    };
  }

  const soulPath = path.join(workspacePath, "SOUL.md");
  if (!fs.existsSync(soulPath)) {
    return {
      valid: false,
      error: `No SOUL.md found in workspace: "${workspacePath}". ` +
        "This doesn't look like a valid soul workspace. Download one from the-undesirables.com/soul",
    };
  }

  return { valid: true, workspacePath };
}
