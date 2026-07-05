/**
 * elizaOS runtime plugin for the Finances overlay app.
 *
 * Registers the `/finances` view (the owner finance dashboard), the
 * `app_finances` drizzle schema, and the `FinancesMigrationService`. The
 * OWNER_FINANCES umbrella action and the `/api/lifeops/money/*` routes are
 * registered by `@elizaos/plugin-personal-assistant`, which delegates the
 * payments back-end (FinancesService / FinancesRepository) here.
 *
 * The drizzle schema (`pgSchema("app_finances")`) is registered via the Plugin
 * `schema` field so the elizaOS runtime handles migrations; loading this plugin
 * requires @elizaos/plugin-sql (declared as a peer dep and in `dependencies`).
 */

import type { Plugin } from "@elizaos/core";
import { financesDbSchema } from "./db/schema.ts";
import { FinancesMigrationService } from "./services/migration.ts";

const FINANCES_APP_NAME = "@elizaos/plugin-finances";

export const financesPlugin: Plugin = {
  name: FINANCES_APP_NAME,
  description:
    "Owner finance overlay: dashboard, transactions, recurring charges, and the /finances view. Owns the FinancesService / FinancesRepository payments back-end (sources, CSV import, transactions, spending, recurring charges, email bills, Plaid / PayPal bridges). The OWNER_FINANCES umbrella action + the /api/lifeops/money/* routes are registered by @elizaos/plugin-personal-assistant, which delegates the payments back-end here. Backed by drizzle pgSchema('app_finances'); requires @elizaos/plugin-sql.",
  dependencies: ["@elizaos/plugin-sql"],
  services: [FinancesMigrationService],
  schema: financesDbSchema,
  views: [
    {
      id: "finances",
      label: "Finances",
      description:
        "Owner finance dashboard — balance, transactions, recurring charges",
      icon: "Wallet",
      path: "/finances",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "FinancesView",
      tags: ["finances", "owner", "money"],
      relatedActions: ["OWNER_FINANCES"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default financesPlugin;
