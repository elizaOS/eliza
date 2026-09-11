/**
 * Selective production assembly for owner reminders. Hosts that need the
 * reminder action and its activity-signal contract without connector, device, finance, or
 * household domains can load this contribution instead of the full assistant.
 */

import {
  ElizaError,
  type IAgentRuntime,
  type Plugin,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { getScheduledTaskRunnerDeps } from "@elizaos/plugin-scheduling";
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
import {
  assertLifeOpsTaskWorkerMode,
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  registerLifeOpsTaskWorker,
  reserveLifeOpsSchedulerHost,
} from "./lifeops/runtime.ts";
import { registerLifeOpsScheduledTaskRunnerDeps } from "./lifeops/scheduled-task/runtime-wiring.ts";
import { lifeOpsSchema } from "./lifeops/schema.ts";

interface ReminderHost {
  active: boolean;
  ready: boolean;
  setup: Promise<void> | null;
  disposal: Promise<void> | null;
  taskId: Awaited<ReturnType<typeof ensureLifeOpsSchedulerTask>> | null;
  stopWorker: () => Promise<void>;
  releaseDeps: () => void;
  releaseAdmission: () => void;
}
const hosts = new WeakMap<IAgentRuntime, ReminderHost>();

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
    assertLifeOpsTaskWorkerMode(runtime, "reminders");
    if (hosts.has(runtime) || getScheduledTaskRunnerDeps(runtime)) {
      throw new ElizaError("Reminder assembly is already initialized", {
        code: "LIFEOPS_REMINDER_HOST_ALREADY_INITIALIZED",
        context: { agentId: runtime.agentId },
      });
    }
    const releaseAdmission = reserveLifeOpsSchedulerHost(runtime, "reminders");
    if (!getChannelRegistry(runtime)) {
      const channels = createChannelRegistry();
      registerDefaultChannelPack(channels, runtime);
      registerChannelRegistry(runtime, channels);
    }
    const disabledValue = (process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER ?? "")
      .trim()
      .toLowerCase();
    const disabled =
      disabledValue === "1" ||
      disabledValue === "true" ||
      disabledValue === "yes";
    const host: ReminderHost = {
      active: true,
      ready: false,
      setup: null,
      disposal: null,
      taskId: null,
      releaseAdmission,
      stopWorker: registerLifeOpsTaskWorker(runtime, {
        mode: "reminders",
        disabled,
        isWorkflowClaimSchemaReady: () => host.active && host.ready,
      }),
      releaseDeps: registerLifeOpsScheduledTaskRunnerDeps(runtime),
    };
    hosts.set(runtime, host);
    activateLifeOpsActivitySignals(runtime);
    void runtime.initPromise
      .then(async () => {
        if (!host.active || disabled) return;
        host.setup = (async () => {
          host.taskId = await ensureLifeOpsSchedulerTask(runtime);
          if (host.active) host.ready = true;
        })();
        await host.setup;
      })
      .catch((error) => {
        // error-policy:J1 Deferred startup reports a failed host and keeps its worker disabled.
        runtime.reportError("LifeOpsReminders.start", error);
      });
  },
  dispose: async (runtime: IAgentRuntime) => {
    const host = hosts.get(runtime);
    if (!host) return;
    if (!host.disposal) {
      host.active = false;
      host.disposal = (async () => {
        await host.stopWorker();
        if (host.setup) await Promise.allSettled([host.setup]);
        try {
          // Owner-profile writes may lazily create this row even while the host is disabled.
          // Admission remains held until cleanup finishes, so no replacement host can own it yet.
          const tasks = await runtime.getTasks({ agentIds: [runtime.agentId] });
          for (const task of tasks) {
            if (task.name === LIFEOPS_TASK_NAME && task.id)
              await runtime.deleteTask(task.id);
          }
        } finally {
          host.releaseDeps();
          deactivateLifeOpsActivitySignals(runtime);
          if (hosts.get(runtime) === host) hosts.delete(runtime);
          host.releaseAdmission();
        }
      })();
    }
    await host.disposal;
  },
};

export default personalAssistantRemindersPlugin;
