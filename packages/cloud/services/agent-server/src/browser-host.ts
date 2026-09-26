/** Managed-runtime composition. Private controller keys stay in this agent's encrypted store. */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  assistantPlugin,
  secretsManagerPlugin,
} from "@elizaos/plugin-assistant";
import { browserPlugin } from "@elizaos/plugin-browser";
import { webSearchPlugin } from "@elizaos/plugin-web-search";
import { restoreRemoteBrowserController } from "@elizaos/remote-control-host";

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
