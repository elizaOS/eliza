/** LifeOps telemetry contracts. Persisted and wire shapes are preserved. */
import type {
  LifeOpsCircadianState,
  LifeOpsHealthSignal,
  LifeOpsMobileHealthPayload,
} from "./health.js";
import type {
  LifeOpsSocialMessageChannel,
  LifeOpsTelemetryMessageChannel,
} from "./inbox.js";
import type { LifeOpsMessageDirection } from "./policy.js";

export const LIFEOPS_ACTIVITY_SIGNAL_SOURCES = [
  "app_lifecycle",
  "page_visibility",
  "desktop_power",
  "desktop_interaction",
  "connector_activity",
  "imessage_outbound",
  "mobile_device",
  "mobile_health",
] as const;

/**
 * The closed built-in passive-signal vocabulary: the eight sources whose
 * telemetry payload schema and reliability weight ship in-tree. It is the
 * discriminant for the typed built-in mappers, the reliability keys, and the
 * awake-probability model.
 */
export type LifeOpsActivitySignalSource =
  (typeof LIFEOPS_ACTIVITY_SIGNAL_SOURCES)[number];

/**
 * Open passive-signal source identifier — the built-in vocabulary plus any
 * namespaced source a plugin contributes at runtime through the
 * `SignalSourceRegistry`. Mirrors how `LifeOpsBusFamily` opens the closed
 * `LifeOpsTelemetryFamily` union: persisted signals and ingestion requests
 * carry this open type, while the built-in mapping/reliability tables keep the
 * closed `LifeOpsActivitySignalSource` discriminant. `(string & {})` preserves
 * literal autocomplete for the built-ins while admitting contributed sources.
 */
export type LifeOpsActivitySignalSourceName =
  | LifeOpsActivitySignalSource
  | (string & {});

/**
 * `true` when `source` is one of the built-in `LIFEOPS_ACTIVITY_SIGNAL_SOURCES`
 * (carries a typed payload schema + reliability weight). Callers narrow an open
 * `LifeOpsActivitySignalSourceName` to the closed union before reaching the
 * built-in mapper/reliability tables; a contributed source is dispatched
 * through its `SignalSourceRegistry` entry instead.
 */
export function isBuiltinActivitySignalSource(
  source: LifeOpsActivitySignalSourceName,
): source is LifeOpsActivitySignalSource {
  return (LIFEOPS_ACTIVITY_SIGNAL_SOURCES as readonly string[]).includes(
    source,
  );
}

export const LIFEOPS_ACTIVITY_SIGNAL_STATES = [
  "active",
  "idle",
  "background",
  "locked",
  "sleeping",
] as const;

export type LifeOpsActivitySignalState =
  (typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number];

export interface LifeOpsActivitySignal {
  id: string;
  agentId: string;
  source: LifeOpsActivitySignalSourceName;
  platform: string;
  state: LifeOpsActivitySignalState;
  observedAt: string;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  health: LifeOpsHealthSignal | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Telemetry event families (canonical store).
//
// See `eliza/plugins/plugin-personal-assistant/docs/telemetry-event-families.md` for the full
// spec. Every telemetry payload is a fully-typed discriminated-union variant
// per the no-`unknown`/no-`any` rule.
// ---------------------------------------------------------------------------

export type LifeOpsDevicePlatform =
  | "macos_desktop"
  | "macos_electrobun"
  | "ios_capacitor"
  | "ipados_capacitor"
  | "browser_web";

export interface LifeOpsDevicePresencePayload {
  family: "device_presence_event";
  platform: LifeOpsDevicePlatform;
  state: LifeOpsActivitySignalState;
  deviceId: string;
  isTransition: boolean;
  sequence: number;
}

export type LifeOpsDesktopPowerEventKind =
  | "system_wake"
  | "system_sleep"
  | "screen_wake"
  | "screen_sleep"
  | "session_lock"
  | "session_unlock"
  | "ac_plug"
  | "ac_unplug";

export interface LifeOpsDesktopPowerPayload {
  family: "desktop_power_event";
  platform: "macos_desktop" | "macos_electrobun";
  kind: LifeOpsDesktopPowerEventKind;
  batteryPercent: number | null;
}

export interface LifeOpsDesktopIdleSamplePayload {
  family: "desktop_idle_sample";
  platform: "macos_desktop" | "macos_electrobun";
  idleSeconds: number;
  source: "iokit_hid" | "cgevent" | "collector_synthesized";
  isThresholdCrossing: boolean;
}

export interface LifeOpsBrowserFocusPayload {
  family: "browser_focus_window";
  platform: "browser_web" | "macos_electrobun";
  startAt: string;
  endAt: string;
  domain: string;
  tabId: string;
  focusedSeconds: number;
}

export type LifeOpsMobileDeviceTelemetrySource =
  | "capacitor_mobile_signals"
  | "macos_continuity_probe";

export interface LifeOpsMobileDevicePayload {
  family: "mobile_device_snapshot";
  platform: "ios_capacitor" | "ipados_capacitor" | "macos_desktop";
  source: LifeOpsMobileDeviceTelemetrySource;
  locked: boolean;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  pairedDeviceId: string | null;
}

export interface LifeOpsMessageActivityPayload {
  family: "message_activity_event";
  platform: LifeOpsDevicePlatform;
  channel: LifeOpsTelemetryMessageChannel;
  direction: LifeOpsMessageDirection;
  externalMessageId: string;
  senderHash: string;
  conversationHash: string;
}

export type LifeOpsStatusPlatform = "slack" | "discord" | "telegram" | "x";

export type LifeOpsStatusTransition =
  | "online"
  | "offline"
  | "away"
  | "do_not_disturb"
  | "custom_set"
  | "custom_cleared";

export interface LifeOpsStatusActivityPayload {
  family: "status_activity_event";
  platform: LifeOpsStatusPlatform;
  transition: LifeOpsStatusTransition;
}

export interface LifeOpsChargingPayload {
  family: "charging_event";
  platform: LifeOpsDevicePlatform;
  connected: boolean;
  batteryPercent: number;
}

export interface LifeOpsScreenTimePerAppUsage {
  appBundleId: string;
  minutesUsed: number;
}

export interface LifeOpsScreenTimeSummaryPayload {
  family: "screen_time_summary";
  platform: "ios_capacitor" | "ipados_capacitor" | "macos_desktop";
  intervalStartAt: string;
  intervalEndAt: string;
  totalMinutesUsed: number;
  apps: LifeOpsScreenTimePerAppUsage[];
}

export type LifeOpsManualOverrideTelemetryKind =
  | "going_to_bed"
  | "just_woke_up";

export interface LifeOpsManualOverridePayload {
  family: "manual_override_event";
  platform: LifeOpsDevicePlatform;
  kind: LifeOpsManualOverrideTelemetryKind;
  note: string | null;
}

export type LifeOpsTelemetryPayload =
  | LifeOpsDevicePresencePayload
  | LifeOpsDesktopPowerPayload
  | LifeOpsDesktopIdleSamplePayload
  | LifeOpsBrowserFocusPayload
  | LifeOpsMobileHealthPayload
  | LifeOpsMobileDevicePayload
  | LifeOpsMessageActivityPayload
  | LifeOpsStatusActivityPayload
  | LifeOpsChargingPayload
  | LifeOpsScreenTimeSummaryPayload
  | LifeOpsManualOverridePayload;

export type LifeOpsTelemetryFamily = LifeOpsTelemetryPayload["family"];

export const LIFEOPS_TELEMETRY_FAMILIES: readonly LifeOpsTelemetryFamily[] = [
  "device_presence_event",
  "desktop_power_event",
  "desktop_idle_sample",
  "browser_focus_window",
  "mobile_health_snapshot",
  "mobile_device_snapshot",
  "message_activity_event",
  "status_activity_event",
  "charging_event",
  "screen_time_summary",
  "manual_override_event",
];

export interface LifeOpsTelemetryEnvelope {
  id: string;
  agentId: string;
  family: LifeOpsTelemetryFamily;
  occurredAt: string;
  ingestedAt: string;
  dedupeKey: string;
  sourceReliability: number;
}

export type LifeOpsTelemetryEvent = LifeOpsTelemetryEnvelope & {
  payload: LifeOpsTelemetryPayload;
};

export interface CaptureLifeOpsActivitySignalRequest {
  source: LifeOpsActivitySignalSourceName;
  platform?: string;
  state: LifeOpsActivitySignalState;
  observedAt?: string;
  idleState?: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds?: number | null;
  onBattery?: boolean | null;
  health?: LifeOpsHealthSignal | null;
  metadata?: Record<string, unknown>;
}

/**
 * User-attested circadian override. Emitted with maximum reliability weight;
 * force-transitions the state machine. See `sleep-wake-spec.md` §2 (manual
 * override row in the transition table).
 */
export const LIFEOPS_MANUAL_OVERRIDE_KINDS = [
  "going_to_bed",
  "just_woke_up",
] as const;

export type LifeOpsManualOverrideKind =
  (typeof LIFEOPS_MANUAL_OVERRIDE_KINDS)[number];

export interface CaptureLifeOpsManualOverrideRequest {
  kind: LifeOpsManualOverrideKind;
  occurredAt?: string;
  /** Optional user note capped at 500 chars. */
  note?: string;
}

export interface LifeOpsManualOverrideResult {
  accepted: true;
  kind: LifeOpsManualOverrideKind;
  occurredAt: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
}

// ── Screen time ──────────────────────────────────────────────────────────────

export interface LifeOpsScreenTimeSession {
  id: string;
  agentId: string;
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsScreenTimeDaily {
  id: string;
  agentId: string;
  source: "app" | "website";
  identifier: string;
  date: string;
  totalSeconds: number;
  sessionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LifeOpsScreenTimeSource = "app" | "website";

export type LifeOpsScreenTimeRangeKey = "today" | "this-week" | "7d" | "30d";

export const LIFEOPS_SCREEN_TIME_RANGES = [
  "today",
  "this-week",
  "7d",
  "30d",
] as const satisfies readonly LifeOpsScreenTimeRangeKey[];

export interface LifeOpsScreenTimeSummaryRequest {
  since: string;
  until: string;
  source?: LifeOpsScreenTimeSource;
  identifier?: string;
  topN?: number;
}

export interface LifeOpsScreenTimeSummaryItem {
  source: LifeOpsScreenTimeSource;
  identifier: string;
  displayName: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeSummary {
  items: LifeOpsScreenTimeSummaryItem[];
  totalSeconds: number;
}

export type LifeOpsHabitCategory =
  | "browser"
  | "communication"
  | "social"
  | "system"
  | "video"
  | "work"
  | "other";

export type LifeOpsHabitDevice =
  | "browser"
  | "computer"
  | "phone"
  | "tablet"
  | "unknown";

export interface LifeOpsScreenTimeBucket {
  key: string;
  label: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeBreakdownItem
  extends LifeOpsScreenTimeSummaryItem {
  sessionCount: number;
  category: LifeOpsHabitCategory;
  device: LifeOpsHabitDevice;
  service: string | null;
  serviceLabel: string | null;
  browser: string | null;
}

export interface LifeOpsScreenTimeBreakdown {
  items: LifeOpsScreenTimeBreakdownItem[];
  totalSeconds: number;
  bySource: LifeOpsScreenTimeBucket[];
  byCategory: LifeOpsScreenTimeBucket[];
  byDevice: LifeOpsScreenTimeBucket[];
  byService: LifeOpsScreenTimeBucket[];
  byBrowser: LifeOpsScreenTimeBucket[];
  fetchedAt: string;
}

export type LifeOpsSocialHabitDataSourceState = "live" | "partial" | "unwired";

export interface LifeOpsSocialHabitDataSource {
  id: string;
  label: string;
  state: LifeOpsSocialHabitDataSourceState;
  statusLabel: string;
  detail: string;
}

export interface LifeOpsSocialHabitSummary {
  since: string;
  until: string;
  totalSeconds: number;
  services: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  sessions: LifeOpsScreenTimeBreakdownItem[];
  messages: {
    channels: LifeOpsSocialMessageChannel[];
    inbound: number;
    outbound: number;
    opened: number;
    replied: number;
  };
  dataSources: LifeOpsSocialHabitDataSource[];
  fetchedAt: string;
}

export interface LifeOpsScreenTimeWindow {
  since: string;
  until: string;
}

export interface LifeOpsScreenTimeHistoryPoint extends LifeOpsScreenTimeWindow {
  date: string;
  label: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeDeltaMetrics {
  totalPercent: number | null;
  appPercent: number | null;
  webPercent: number | null;
  phonePercent: number | null;
  socialPercent: number | null;
  youtubePercent: number | null;
  xPercent: number | null;
  messageOpenedPercent: number | null;
}

export interface LifeOpsScreenTimeMetrics {
  totalSeconds: number;
  appSeconds: number;
  webSeconds: number;
  phoneSeconds: number;
  socialSeconds: number;
  youtubeSeconds: number;
  xSeconds: number;
  messageOpened: number;
  messageOutbound: number;
  messageInbound: number;
  deltas: LifeOpsScreenTimeDeltaMetrics | null;
}

export interface LifeOpsScreenTimeTargetBucket extends LifeOpsScreenTimeBucket {
  source: LifeOpsScreenTimeSource;
  identifier: string;
}

export interface LifeOpsScreenTimeSessionBucket
  extends LifeOpsScreenTimeBucket {
  source: LifeOpsScreenTimeSource;
  identifier: string;
}

export interface LifeOpsScreenTimeVisibleBuckets {
  categories: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  services: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  topTargets: LifeOpsScreenTimeTargetBucket[];
  sessionBuckets: LifeOpsScreenTimeSessionBucket[];
  channels: LifeOpsSocialMessageChannel[];
  setupSources: LifeOpsSocialHabitDataSource[];
  hasMessageActivity: boolean;
  hasUsage: boolean;
}

export interface LifeOpsScreenTimeHistoryResponse {
  range: LifeOpsScreenTimeRangeKey;
  label: string;
  window: LifeOpsScreenTimeWindow;
  priorWindow: LifeOpsScreenTimeWindow | null;
  breakdown: LifeOpsScreenTimeBreakdown;
  social: LifeOpsSocialHabitSummary;
  history: LifeOpsScreenTimeHistoryPoint[];
  metrics: LifeOpsScreenTimeMetrics;
  visible: LifeOpsScreenTimeVisibleBuckets;
  fetchedAt: string;
}
