/**
 * @elizaos/plugin-goals — life direction plugin.
 *
 * Decomposed out of @elizaos/plugin-personal-assistant. Owns owner-set long-horizon
 * goals, recurring routines, reminders, alarms, daily check-ins, and the
 * self-care / mood / journal surface. The corresponding @elizaos/plugin-personal-assistant
 * source still exists during the migration and is referenced by TODO(migrate)
 * comments in each stub.
 */

import type { Plugin } from "@elizaos/core";

import { ownerAlarmsAction } from "./actions/alarms.ts";
import { ownerGoalsAction } from "./actions/goals.ts";
import { ownerRemindersAction } from "./actions/reminders.ts";
import { ownerRoutinesAction } from "./actions/routines.ts";
import * as dbSchema from "./db/index.ts";
import { GoalsCheckinService } from "./services/checkin.ts";
import { GoalsMigrationService } from "./services/migration.ts";

const GOALS_PLUGIN_NAME = "@elizaos/plugin-goals";

export const goalsPlugin: Plugin = {
  name: GOALS_PLUGIN_NAME,
  description:
    "Life direction: owner-set long-horizon goals, recurring routines, reminders, alarms, daily check-ins, and a self-care / mood / journal panel. Decomposed out of @elizaos/plugin-personal-assistant.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [
    ownerGoalsAction,
    ownerRoutinesAction,
    ownerRemindersAction,
    ownerAlarmsAction,
  ],
  services: [GoalsCheckinService, GoalsMigrationService],
  schema: dbSchema,
  views: [
    {
      id: "goals",
      label: "Goals",
      description:
        "Life goals, routines, today's reminders and alarms, self-care check-in.",
      icon: "Target",
      path: "/goals",
      bundlePath: "dist/views/bundle.js",
      componentExport: "GoalsView",
      tags: ["goals", "routines", "reminders", "self-care", "owner"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime) {
    const svc = runtime.getService<GoalsCheckinService>(
      GoalsCheckinService.serviceType,
    );
    await svc?.stop();
  },
};

export default goalsPlugin;
