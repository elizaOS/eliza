import type {
  LifeOpsActivitySignal,
  LifeOpsActivitySignalSource,
  LifeOpsActivitySignalState,
  LifeOpsHealthSignal,
  LifeOpsHealthSignalSource,
} from "@elizaos/shared";
import {
  LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
} from "@elizaos/shared";

/**
 * Presence-day fixture for the lifeops-presence mockoon environment.
 *
 * Encodes a deterministic 24-hour weekday trace anchored at
 * `LIFEOPS_PRESENCE_DAY_ANCHOR_ISO`. Each hour emits exactly one
 * activity signal (so consumers get a 24-sample stream for assertion).
 * Every value of `LIFEOPS_ACTIVITY_SIGNAL_SOURCES` is represented at
 * least once across the day, and every value of
 * `LIFEOPS_HEALTH_SIGNAL_SOURCES` is represented in the parallel
 * health-signal map. The presence-coverage contract test enforces
 * that parity.
 */

export const LIFEOPS_PRESENCE_DAY_VERSION = "2026-05-03" as const;

export const LIFEOPS_PRESENCE_DAY_ANCHOR_ISO =
  "2026-04-22T07:00:00.000Z" as const;

const ANCHOR_MS = Date.parse(LIFEOPS_PRESENCE_DAY_ANCHOR_ISO);
const HOUR_MS = 60 * 60 * 1_000;
const AGENT_ID = "agent-presence-day";

function isoAtHour(hourOffset: number): string {
  return new Date(ANCHOR_MS + hourOffset * HOUR_MS).toISOString();
}

export interface LifeOpsPresenceHourSample {
  hour: number;
  source: LifeOpsActivitySignalSource;
  platform: string;
  state: LifeOpsActivitySignalState;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  transition: "wake" | "active" | "idle" | "background" | "locked" | "sleep";
  note: string;
}

/**
 * Hand-authored 24-hour trace. Hour 0 corresponds to
 * `LIFEOPS_PRESENCE_DAY_ANCHOR_ISO` (07:00 UTC). The sequence walks
 * through wake -> morning standup -> deep work -> lunch idle ->
 * afternoon collab -> gym -> wind-down -> sleep, exercising every
 * activity-signal source at least once.
 */
export const LIFEOPS_PRESENCE_DAY_SAMPLES: readonly LifeOpsPresenceHourSample[] =
  [
    {
      hour: 0,
      source: "mobile_health",
      platform: "ios_capacitor",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 0,
      onBattery: true,
      transition: "wake",
      note: "HealthKit wake observed; iPhone unlocks on alarm.",
    },
    {
      hour: 1,
      source: "mobile_device",
      platform: "ios_capacitor",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 30,
      onBattery: true,
      transition: "active",
      note: "iPhone foreground after wake; messages and weather check.",
    },
    {
      hour: 2,
      source: "desktop_power",
      platform: "macos_electrobun",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 5,
      onBattery: false,
      transition: "wake",
      note: "macOS resume from sleep; battery on AC.",
    },
    {
      hour: 3,
      source: "desktop_interaction",
      platform: "macos_desktop",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 1,
      onBattery: false,
      transition: "active",
      note: "HID idle ~1s during morning standup typing.",
    },
    {
      hour: 4,
      source: "connector_activity",
      platform: "slack",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 12,
      onBattery: false,
      transition: "active",
      note: "Inbound Slack DM evaluated by presence-signal-bridge-service.",
    },
    {
      hour: 5,
      source: "app_lifecycle",
      platform: "browser_web",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 3,
      onBattery: false,
      transition: "active",
      note: "Web dashboard tab focused (visibilitychange=visible).",
    },
    {
      hour: 6,
      source: "page_visibility",
      platform: "browser_web",
      state: "background",
      idleState: "active",
      idleTimeSeconds: 0,
      onBattery: false,
      transition: "background",
      note: "Dashboard tab moved to background; Chrome reports hidden.",
    },
    {
      hour: 7,
      source: "imessage_outbound",
      platform: "macos_desktop",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 8,
      onBattery: false,
      transition: "active",
      note: "Owner sent iMessage from this Mac (chat.db row id 18421).",
    },
    {
      hour: 8,
      source: "desktop_interaction",
      platform: "macos_desktop",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 2,
      onBattery: false,
      transition: "active",
      note: "Heads-down VS Code session; HID idle near zero.",
    },
    {
      hour: 9,
      source: "desktop_power",
      platform: "macos_electrobun",
      state: "idle",
      idleState: "idle",
      idleTimeSeconds: 540,
      onBattery: false,
      transition: "idle",
      note: "9-minute idle window over lunch; pmset still on AC.",
    },
    {
      hour: 10,
      source: "mobile_device",
      platform: "ios_capacitor",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 14,
      onBattery: true,
      transition: "active",
      note: "iPhone foreground during lunch walk.",
    },
    {
      hour: 11,
      source: "connector_activity",
      platform: "discord",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 22,
      onBattery: false,
      transition: "active",
      note: "Discord channel reply; runtime emits MESSAGE_SENT.",
    },
    {
      hour: 12,
      source: "desktop_interaction",
      platform: "macos_desktop",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 4,
      onBattery: false,
      transition: "active",
      note: "Afternoon collab block; PR review.",
    },
    {
      hour: 13,
      source: "app_lifecycle",
      platform: "macos_electrobun",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 6,
      onBattery: false,
      transition: "active",
      note: "Electrobun shell raised after notification.",
    },
    {
      hour: 14,
      source: "page_visibility",
      platform: "browser_web",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 9,
      onBattery: false,
      transition: "active",
      note: "Dashboard tab visible during planning review.",
    },
    {
      hour: 15,
      source: "connector_activity",
      platform: "gmail",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 18,
      onBattery: false,
      transition: "active",
      note: "Outbound Gmail send from owner-authored draft.",
    },
    {
      hour: 16,
      source: "mobile_health",
      platform: "ios_capacitor",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 0,
      onBattery: true,
      transition: "active",
      note: "HealthKit workout start (run); HR 132 bpm sample.",
    },
    {
      hour: 17,
      source: "mobile_device",
      platform: "ios_capacitor",
      state: "background",
      idleState: "active",
      idleTimeSeconds: 0,
      onBattery: true,
      transition: "background",
      note: "iPhone in pocket during workout; foreground = lock screen.",
    },
    {
      hour: 18,
      source: "desktop_power",
      platform: "macos_electrobun",
      state: "locked",
      idleState: "locked",
      idleTimeSeconds: 1800,
      onBattery: false,
      transition: "locked",
      note: "Screen locked after gym; CGSession reports locked.",
    },
    {
      hour: 19,
      source: "imessage_outbound",
      platform: "macos_desktop",
      state: "active",
      idleState: "active",
      idleTimeSeconds: 12,
      onBattery: false,
      transition: "active",
      note: "Owner unlocked Mac, sent dinner-plans iMessage.",
    },
    {
      hour: 20,
      source: "desktop_interaction",
      platform: "macos_desktop",
      state: "idle",
      idleState: "idle",
      idleTimeSeconds: 1200,
      onBattery: true,
      transition: "idle",
      note: "Wind-down: reading on couch; 20-minute HID idle.",
    },
    {
      hour: 21,
      source: "app_lifecycle",
      platform: "ios_capacitor",
      state: "background",
      idleState: "active",
      idleTimeSeconds: 0,
      onBattery: true,
      transition: "background",
      note: "Web app sent to background as iPhone screen dims.",
    },
    {
      hour: 22,
      source: "mobile_device",
      platform: "ios_capacitor",
      state: "locked",
      idleState: "locked",
      idleTimeSeconds: 600,
      onBattery: true,
      transition: "locked",
      note: "iPhone locked, placed on charger.",
    },
    {
      hour: 23,
      source: "mobile_health",
      platform: "ios_capacitor",
      state: "sleeping",
      idleState: null,
      idleTimeSeconds: null,
      onBattery: true,
      transition: "sleep",
      note: "HealthKit sleep stage transitions: in_bed -> core.",
    },
  ];

if (LIFEOPS_PRESENCE_DAY_SAMPLES.length !== 24) {
  throw new Error(
    `LIFEOPS_PRESENCE_DAY_SAMPLES must contain 24 hourly samples, got ${LIFEOPS_PRESENCE_DAY_SAMPLES.length}`,
  );
}

function buildHealthSignal(
  source: LifeOpsHealthSignalSource,
  observedAt: string,
  isSleeping: boolean,
): LifeOpsHealthSignal {
  return {
    source,
    permissions: { sleep: true, biometrics: true },
    sleep: {
      available: true,
      isSleeping,
      asleepAt: isSleeping ? observedAt : "2026-04-21T23:30:00.000Z",
      awakeAt: isSleeping ? null : "2026-04-22T07:15:00.000Z",
      durationMinutes: isSleeping ? null : 7 * 60 + 45,
      stage: isSleeping ? "core" : "awake",
    },
    biometrics: {
      sampleAt: observedAt,
      heartRateBpm: isSleeping ? 54 : 68,
      restingHeartRateBpm: 54,
      heartRateVariabilityMs: 71,
      respiratoryRate: 13,
      bloodOxygenPercent: 97,
    },
    warnings: [],
  };
}

/**
 * Per-source health-signal fixtures. Each entry of
 * `LIFEOPS_HEALTH_SIGNAL_SOURCES` is realized exactly once so the
 * presence-coverage contract test can assert parity by source key.
 */
export const LIFEOPS_PRESENCE_DAY_HEALTH_SIGNALS: Readonly<
  Record<LifeOpsHealthSignalSource, LifeOpsHealthSignal>
> = {
  healthkit: buildHealthSignal("healthkit", isoAtHour(23), true),
  health_connect: buildHealthSignal("health_connect", isoAtHour(0), false),
  strava: buildHealthSignal("strava", isoAtHour(16), false),
  fitbit: buildHealthSignal("fitbit", isoAtHour(7), false),
  withings: buildHealthSignal("withings", isoAtHour(2), false),
  oura: buildHealthSignal("oura", isoAtHour(23), true),
};

function buildActivitySignal(
  sample: LifeOpsPresenceHourSample,
): LifeOpsActivitySignal {
  const observedAt = isoAtHour(sample.hour);
  const health =
    sample.source === "mobile_health"
      ? LIFEOPS_PRESENCE_DAY_HEALTH_SIGNALS.healthkit
      : null;
  return {
    id: `presence-day-${String(sample.hour).padStart(2, "0")}`,
    agentId: AGENT_ID,
    source: sample.source,
    platform: sample.platform,
    state: sample.state,
    observedAt,
    idleState: sample.idleState,
    idleTimeSeconds: sample.idleTimeSeconds,
    onBattery: sample.onBattery,
    health,
    metadata: {
      transition: sample.transition,
      note: sample.note,
      hourOffset: sample.hour,
    },
    createdAt: observedAt,
  };
}

export const LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS: readonly LifeOpsActivitySignal[] =
  LIFEOPS_PRESENCE_DAY_SAMPLES.map(buildActivitySignal);

export interface LifeOpsPresenceDayCoverage {
  activitySources: readonly LifeOpsActivitySignalSource[];
  healthSources: readonly LifeOpsHealthSignalSource[];
}

export function lifeOpsPresenceDayCoverage(): LifeOpsPresenceDayCoverage {
  const activitySources = new Set<LifeOpsActivitySignalSource>(
    LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS.map((signal) => signal.source),
  );
  const healthSources = new Set<LifeOpsHealthSignalSource>(
    Object.keys(
      LIFEOPS_PRESENCE_DAY_HEALTH_SIGNALS,
    ) as LifeOpsHealthSignalSource[],
  );
  return {
    activitySources: [
      ...activitySources,
    ].sort() as readonly LifeOpsActivitySignalSource[],
    healthSources: [
      ...healthSources,
    ].sort() as readonly LifeOpsHealthSignalSource[],
  };
}

export const LIFEOPS_PRESENCE_DAY_REQUIRED_ACTIVITY_SOURCES: readonly LifeOpsActivitySignalSource[] =
  [
    ...LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  ].sort() as readonly LifeOpsActivitySignalSource[];

export const LIFEOPS_PRESENCE_DAY_REQUIRED_HEALTH_SOURCES: readonly LifeOpsHealthSignalSource[] =
  [
    ...LIFEOPS_HEALTH_SIGNAL_SOURCES,
  ].sort() as readonly LifeOpsHealthSignalSource[];
