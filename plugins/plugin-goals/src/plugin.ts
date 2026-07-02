/**
 * @elizaos/plugin-goals — life direction plugin.
 *
 * Decomposed out of @elizaos/plugin-personal-assistant. Owns owner-set long-horizon
 * goals plus the goals/routines/reminders view and schema. Routines,
 * reminders, alarms, and daily check-in handlers still run through
 * @elizaos/plugin-personal-assistant during the migration and are referenced
 * by TODO(migrate) comments in their scaffold files.
 */

import type { Plugin } from "@elizaos/core";

import { ownerGoalsAction } from "./actions/goals.ts";
import * as dbSchema from "./db/index.ts";
import { GoalsCheckinService } from "./services/checkin.ts";
import { GoalsMigrationService } from "./services/migration.ts";

const GOALS_PLUGIN_NAME = "@elizaos/plugin-goals";

export const goalsPlugin: Plugin = {
  name: GOALS_PLUGIN_NAME,
  description:
    "Life direction: owner-set long-horizon goals with per-goal check-ins on the scheduling spine, goals/routines/reminders schema, and a self-care / mood / journal panel. Routines, reminders, and alarms are still host-adapted by @elizaos/plugin-personal-assistant during migration.",
  dependencies: ["@elizaos/plugin-sql", "@elizaos/plugin-scheduling"],
  // Only OWNER_GOALS has been fully migrated into this standalone package.
  // Routines/reminders/alarms remain host-adapted PA actions for now; do not
  // register their scaffold handlers here.
  actions: [ownerGoalsAction],
  services: [GoalsCheckinService, GoalsMigrationService],
  schema: dbSchema,
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single GoalsView
    // spatial source. `modalities` is a plain literal here (plugin.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build.
    {
      id: "goals",
      label: "Goals",
      description:
        "Life goals, routines, today's reminders and alarms, self-care check-in.",
      icon: "Target",
      path: "/goals",
      modalities: ["gui", "xr", "tui"],
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
