import type { Plugin, Provider } from "@elizaos/core";
import type { AzzleManifest, AzzleWalletClient } from "./client.js";
import { AzzleClient } from "./client.js";
import {
  createAzzleLifecycleAction,
  type AzzleClientFactory,
} from "./actions/lifecycle.js";

export interface AzzlePluginOptions {
  manifest: AzzleManifest;
  rpcUrl: string;
  wallet: AzzleWalletClient;
}

export function createAzzlePlugin(options: AzzlePluginOptions): Plugin {
  const createClient: AzzleClientFactory = () =>
    new AzzleClient(options.manifest, options.rpcUrl, options.wallet);
  const statusProvider: Provider = {
    name: "AZZLE_TASK_STATUS",
    description: "Current status for a canonical AZZLE V2 task ID in the message.",
    get: async (_runtime, message) => {
      const taskId = message.content.taskId;
      if (typeof taskId !== "string") return { text: "" };
      try {
        return { text: JSON.stringify(await createClient().status(taskId)) };
      } catch (error) {
        return { text: `AZZLE task status unavailable: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };

  return {
    name: "azzle",
    description: "AZZLE V2 task lifecycle actions for Base.",
    actions: [
      createAzzleLifecycleAction("post", createClient),
      createAzzleLifecycleAction("claim", createClient),
      createAzzleLifecycleAction("fund", createClient),
      createAzzleLifecycleAction("markDelivered", createClient),
      createAzzleLifecycleAction("release", createClient),
      createAzzleLifecycleAction("complete", createClient),
    ],
    providers: [statusProvider],
  };
}

export { AzzleClient } from "./client.js";
export type { AzzleManifest, AzzleWalletClient } from "./client.js";
export { createAzzleLifecycleAction } from "./actions/lifecycle.js";
export default createAzzlePlugin;
