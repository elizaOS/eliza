/**
 * Selective production assembly for owner reminders. Hosts that need the
 * reminder action and its activity-signal contract without connector, device, finance, or
 * household domains can load this contribution instead of the full assistant.
 */

import {
  type IAgentRuntime,
  type Plugin,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { ownerRemindersAction } from "./actions/owner-surfaces.ts";
import { ownerPrivateAction } from "./lifeops/access.ts";
import {
  activateLifeOpsActivitySignals,
  deactivateLifeOpsActivitySignals,
} from "./lifeops/activity-signal-lifecycle.ts";
import {
  createChannelRegistry,
  getChannelRegistry,
  registerChannelRegistry,
  registerDefaultChannelPack,
} from "./lifeops/channels/index.ts";
import { registerLifeOpsScheduledTaskRunnerDeps } from "./lifeops/scheduled-task/runtime-wiring.ts";
import { lifeOpsSchema } from "./lifeops/schema.ts";

export const personalAssistantRemindersPlugin: Plugin = {
  name: "@elizaos/plugin-personal-assistant/reminders-plugin",
  description:
    "Owner reminder CRUD and production scheduled-task delivery without unrelated connector or device contributions.",
  dependencies: [
    "@elizaos/plugin-scheduling",
    "@elizaos/plugin-reminders",
    "@elizaos/plugin-goals",
  ],
  schema: lifeOpsSchema,
  actions:
    promoteSubactionsToActions(ownerRemindersAction).map(ownerPrivateAction),
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    if (!getChannelRegistry(runtime)) {
      const channels = createChannelRegistry();
      registerDefaultChannelPack(channels, runtime);
      registerChannelRegistry(runtime, channels);
    }
    registerLifeOpsScheduledTaskRunnerDeps(runtime);
    activateLifeOpsActivitySignals(runtime);
  },
  dispose: async (runtime: IAgentRuntime) => {
    deactivateLifeOpsActivitySignals(runtime);
  },
};

export default personalAssistantRemindersPlugin;
