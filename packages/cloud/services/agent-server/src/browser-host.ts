/** Managed-runtime composition. Private controller keys stay in this agent's encrypted store. */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  assistantPlugin,
  secretsManagerPlugin,
} from "@elizaos/plugin-assistant";
import { browserPlugin } from "@elizaos/plugin-browser";
import { restoreRemoteBrowserController } from "@elizaos/plugin-browser/remote-controller";
import { webSearchPlugin } from "@elizaos/plugin-web-search";

export function managedBrowserPlugins(encryptionConfigured: boolean): Plugin[] {
  return [
    assistantPlugin,
    browserPlugin,
    webSearchPlugin,
    ...(encryptionConfigured ? [secretsManagerPlugin] : []),
  ];
}
export async function initializeManagedBrowserHost(
  runtime: IAgentRuntime,
): Promise<void> {
  await restoreRemoteBrowserController(runtime);
}
