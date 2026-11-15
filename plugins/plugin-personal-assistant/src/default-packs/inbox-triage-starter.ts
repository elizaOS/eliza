/**
 * Default pack: `inbox-triage-starter`.
 *
 * Opt-in starter: a daily 9am Gmail triage `ScheduledTask`, gated on the
 * `google.gmail.triage` capability. Boot registers the catalog without a
 * connector registry, so this pack is offered at customize time and never
 * seeded automatically.
 */

import type { ConnectorRegistryContract } from "./contract-types.js";
import type { DefaultPack } from "./registry-types.js";
import {
  compileTaskDefinition,
  type RecapTaskDefinition,
} from "./task-definitions.js";

export const INBOX_TRIAGE_STARTER_PACK_KEY = "inbox-triage-starter";

export const INBOX_TRIAGE_RECORD_IDS = {
  daily: "default-pack:inbox-triage-starter:daily-9am",
} as const;

const dailyTriageDefinition: RecapTaskDefinition = {
  definitionKind: "recap",
  promptInstructions:
    "Run a Gmail triage: scan unread mail, group by sender, surface anything important or likely-needs-reply, and send the owner a short triage list. Use the LifeOps Gmail triage feed; do not invent senders or summaries.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
  },
  // Daily 9am owner-local. Tz applied at trigger evaluation by the runner.
  trigger: {
    kind: "cron",
    expression: "0 9 * * *",
    tz: "owner_local",
  },
  priority: "medium",
  output: {
    destination: "in_app_card",
    fallback: {
      title: "Inbox triage",
      body: "Your inbox triage is ready, but I couldn't summarize it on this device.",
    },
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: INBOX_TRIAGE_STARTER_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: INBOX_TRIAGE_RECORD_IDS.daily,
  metadata: {
    packKey: INBOX_TRIAGE_STARTER_PACK_KEY,
    recordKey: "daily-9am",
    requiredCapability: "google.gmail.triage",
  },
};

const dailyTriageRecord = compileTaskDefinition(dailyTriageDefinition);

export const INBOX_TRIAGE_REQUIRED_CAPABILITIES = ["google.gmail.triage"];

export const inboxTriageStarterPack: DefaultPack = {
  key: INBOX_TRIAGE_STARTER_PACK_KEY,
  label: "Daily inbox triage",
  description:
    "If Gmail is connected, deliver a 9am morning email triage: unread, grouped by sender, important/needs-reply surfaced. Offered at setup; not turned on automatically.",
  // The pack ships defaultEnabled=true, but `requiredCapabilities` gates
  // seeding on a connector registry, which boot does not pass: the Google
  // connector is always registered, so it would say nothing about whether
  // Gmail is connected. Customize still offers the pack.
  defaultEnabled: true,
  requiredCapabilities: INBOX_TRIAGE_REQUIRED_CAPABILITIES,
  records: [dailyTriageRecord],
  uiHints: {
    summaryOnDayOne:
      "If Gmail is connected: one 9am triage. Otherwise: nothing until you connect.",
    expectedFireCountPerDay: 1,
  },
};

/**
 * Capability check used by the registry to decide whether to auto-seed the
 * pack on the defaults path. If the registry is undefined or no
 * Gmail-capable connector is registered, the pack is offered but not
 * auto-seeded.
 */
export function isInboxTriageEligible(
  registry: ConnectorRegistryContract | undefined | null,
): boolean {
  if (!registry) return false;
  const candidates = registry.byCapability("google.gmail.triage");
  return candidates.length > 0;
}
