/** Monthly family operations through the single scheduled-task spine. */

import { FAMILY_MONTHLY_SYSTEM_OPERATION } from "../lifeops/family-workflows/runtime.js";
import type { DefaultPack } from "./registry-types.js";
import {
  compileTaskDefinition,
  type WatcherTaskDefinition,
} from "./task-definitions.js";

export const FAMILY_COORDINATION_PACK_KEY = "family-coordination-monthly";
export const FAMILY_COORDINATION_RECORD_IDS = {
  monthly: "default-pack:family-coordination:monthly",
} as const;

const definition: WatcherTaskDefinition = {
  definitionKind: "watcher",
  promptInstructions:
    "Run the structural monthly family coordination workflow. It checks the school calendar source and builds the owner packet; it never sends a draft.",
  trigger: {
    kind: "cron",
    expression: "0 9 1 * *",
    tz: "America/New_York",
  },
  priority: "medium",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: FAMILY_COORDINATION_PACK_KEY,
  ownerVisible: false,
  idempotencyKey: FAMILY_COORDINATION_RECORD_IDS.monthly,
  metadata: {
    packKey: FAMILY_COORDINATION_PACK_KEY,
    recordKey: "monthly-family-coordination",
    systemOperation: FAMILY_MONTHLY_SYSTEM_OPERATION,
  },
};

export const familyCoordinationPack: DefaultPack = {
  key: FAMILY_COORDINATION_PACK_KEY,
  label: "Monthly family coordination",
  description:
    "Checks the configured school calendar and prepares an owner-reviewed monthly family coordination packet at 9:00 AM America/New_York on the first day of each month.",
  defaultEnabled: true,
  requiredCapabilities: [],
  records: [compileTaskDefinition(definition)],
  uiHints: {
    summaryOnDayOne:
      "Runs monthly at 9:00 AM Eastern; prepares review artifacts and never sends automatically.",
    expectedFireCountPerDay: 0,
  },
};
