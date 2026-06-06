/**
 * elizaOS runtime plugin for the Finances overlay app.
 *
 * Hosts the OWNER_FINANCES action (stub during migration) and the
 * `/finances` view that renders the owner finance dashboard.
 *
 * The drizzle schema (`pgSchema("app_finances")`) is registered via the
 * Plugin `schema` field so the elizaOS runtime handles migrations. Loading
 * this plugin requires @elizaos/plugin-sql (declared as a peer dep and listed
 * in `dependencies`).
 */

import type { Plugin } from "@elizaos/core";
import { ownerFinancesAction } from "./actions/finances.ts";
import * as dbSchema from "./db/index.ts";

const FINANCES_APP_NAME = "@elizaos/plugin-finances";

export const financesPlugin: Plugin = {
  name: FINANCES_APP_NAME,
  description:
    "Owner finance overlay: dashboard, transactions, and recurring charges. Hosts the OWNER_FINANCES action (migrating from plugin-lifeops) and the /finances view. Backed by drizzle pgSchema('app_finances'); requires @elizaos/plugin-sql.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [ownerFinancesAction],
  schema: dbSchema,
  views: [
    {
      id: "finances",
      label: "Finances",
      description:
        "Owner finance dashboard — balance, transactions, recurring charges",
      icon: "Wallet",
      path: "/finances",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FinancesView",
      tags: ["finances", "owner", "money"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default financesPlugin;
