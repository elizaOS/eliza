/**
 * Default pack: `inbox-triage-starter`.
 *
 * Opt-in starter. If a Gmail-capable connector is registered (capability
 * `google.gmail.read`), schedules a daily 9am triage `ScheduledTask`.
 * Otherwise the pack is offered at customize time but its record is NOT seeded.
 */

import type {
  ConnectorRegistryStub,
  ScheduledTaskSeed,
} from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export const INBOX_TRIAGE_STARTER_PACK_KEY = "inbox-triage-starter";

export const INBOX_TRIAGE_RECORD_IDS = {
  daily: "default-pack:inbox-triage-starter:daily-9am",
} as const;

const dailyTriageRecord: ScheduledTaskSeed = {
  kind: "recap",
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
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: INBOX_TRIAGE_STARTER_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: INBOX_TRIAGE_RECORD_IDS.daily,
  metadata: {
    packKey: INBOX_TRIAGE_STARTER_PACK_KEY,
    recordKey: "daily-9am",
    requiredCapability: "google.gmail.read",
  },
};

export const INBOX_TRIAGE_REQUIRED_CAPABILITIES = ["google.gmail.read"];

export const inboxTriageStarterPack: DefaultPack = {
  key: INBOX_TRIAGE_STARTER_PACK_KEY,
  label: "Daily inbox triage",
  description:
    "If Gmail is connected, deliver a 9am morning email triage: unread, grouped by sender, important/needs-reply surfaced. Auto-enabled when capability is present; offered otherwise.",
  // The pack itself ships defaultEnabled=true, but `requiredCapabilities`
  // gates auto-seeding via `isEligibleForAutoSeed`. If Gmail isn't connected,
  // first-run defaults skip it; customize still offers it.
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
  registry: ConnectorRegistryStub | undefined | null,
): boolean {
  if (!registry) return false;
  const candidates = registry.byCapability("google.gmail.read");
  return candidates.length > 0;
}
