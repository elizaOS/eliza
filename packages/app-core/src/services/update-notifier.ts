/**
 * Fire-and-forget background update check. Prints a one-line notice
 * to stderr if a newer version is available (like npm's update-notifier).
 */

import {
  checkForUpdate,
  loadElizaConfig,
  resolveChannel,
} from "@elizaos/agent";
import { theme } from "/shared";

let notified = false;

export function scheduleUpdateNotification(): void {
  if (notified) return;
  notified = true;

  let config: Partial<ReturnType<typeof loadElizaConfig>> = {};
  try {
    config = loadElizaConfig();
  } catch {
    // Keep behavior resilient to malformed config files: continue with defaults.
  }
  if (config.update?.checkOnStart === false) return;
  if (process.env.CI || !process.stderr.isTTY) return;

  void checkForUpdate()
    .then((result) => {
      if (!result.updateAvailable || !result.latestVersion) return;

      const channel = resolveChannel(config.update);
      const suffix = channel !== "stable" ? ` (${channel})` : "";

      process.stderr.write(
        `\n${theme.accent("Update available:")} ${theme.muted(result.currentVersion)} -> ${theme.success(result.latestVersion)}${theme.muted(suffix)}\n` +
          `${theme.muted("Run")} ${theme.command("eliza update")} ${theme.muted("to install")}\n\n`,
      );
    })
    .catch(() => {});
}
