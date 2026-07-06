/**
 * Per-source confidence weights for activity signals. `resolveSourceReliability`
 * and `resolveActivitySignalReliability` rank manual overrides, mobile-health,
 * desktop-power, and message-channel evidence when inferring sleep/wake.
 */
import { ElizaError } from "@elizaos/core";
import {
  isBuiltinActivitySignalSource,
  type LifeOpsActivitySignalSource,
  type LifeOpsActivitySignalSourceName,
} from "../contracts/health.js";

export type LifeOpsReliabilityKey =
  | { kind: "manual_override" }
  | { kind: "mobile_health"; permissionGranted: boolean }
  | { kind: "desktop_power"; transition: "system" | "screen" | "session" }
  | { kind: "message_outbound"; channel: LifeOpsMessageReliabilityChannel }
  | { kind: "message_inbound" }
  | { kind: "status_activity" }
  | { kind: "desktop_idle"; source: "iokit_hid" | "cgevent" }
  | { kind: "browser_focus" }
  | { kind: "device_presence"; transition: boolean }
  | { kind: "mobile_device"; source: "capacitor" | "continuity_probe" }
  | { kind: "charging" }
  | { kind: "screen_time_summary" }
  | { kind: "prior_baseline" };

export type LifeOpsMessageReliabilityChannel =
  | "imessage"
  | "eliza_chat"
  | "gmail"
  | "x_dm"
  | "discord"
  | "telegram"
  | "signal"
  | "whatsapp"
  | "sms";

const MESSAGE_CHANNEL_WEIGHTS: Record<
  LifeOpsMessageReliabilityChannel,
  number
> = {
  imessage: 0.88,
  eliza_chat: 0.88,
  gmail: 0.8,
  x_dm: 0.8,
  discord: 0.8,
  telegram: 0.8,
  signal: 0.8,
  whatsapp: 0.8,
  sms: 0.8,
};

export function resolveSourceReliability(key: LifeOpsReliabilityKey): number {
  switch (key.kind) {
    case "manual_override":
      return 1.0;
    case "mobile_health":
      return key.permissionGranted ? 0.95 : 0;
    case "desktop_power":
      return key.transition === "system"
        ? 0.92
        : key.transition === "screen"
          ? 0.92
          : 0.85;
    case "message_outbound":
      return MESSAGE_CHANNEL_WEIGHTS[key.channel];
    case "message_inbound":
      return 0.15;
    case "status_activity":
      return 0.6;
    case "desktop_idle":
      return key.source === "iokit_hid" ? 0.8 : 0.75;
    case "browser_focus":
      return 0.7;
    case "device_presence":
      return key.transition ? 0.7 : 0.3;
    case "mobile_device":
      return key.source === "capacitor" ? 0.7 : 0.5;
    case "charging":
      return 0.4;
    case "screen_time_summary":
      return 0.55;
    case "prior_baseline":
      return 0.4;
  }
}

/**
 * Default reliability key for each activity-signal source. Cross-axis signal
 * sources (`app_lifecycle`, connector messages) are handled inline because the
 * source alone is not enough to derive confidence.
 */
const SOURCE_RELIABILITY_KEYS: Record<
  Exclude<LifeOpsActivitySignalSource, "connector_activity">,
  LifeOpsReliabilityKey
> = {
  app_lifecycle: { kind: "device_presence", transition: true },
  page_visibility: { kind: "device_presence", transition: true },
  desktop_power: { kind: "desktop_power", transition: "system" },
  desktop_interaction: { kind: "desktop_idle", source: "iokit_hid" },
  imessage_outbound: { kind: "message_outbound", channel: "imessage" },
  mobile_device: { kind: "mobile_device", source: "capacitor" },
  mobile_health: { kind: "mobile_health", permissionGranted: true },
};

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeMessageReliabilityChannel(
  value: string,
): LifeOpsMessageReliabilityChannel {
  const normalized = value.toLowerCase();
  if (normalized.includes("telegram")) return "telegram";
  if (normalized.includes("discord")) return "discord";
  if (normalized.includes("imessage")) return "imessage";
  if (normalized.includes("whatsapp")) return "whatsapp";
  if (normalized.includes("signal")) return "signal";
  if (normalized.includes("sms") || normalized.includes("twilio")) {
    return "sms";
  }
  if (normalized.includes("x_dm") || normalized === "x") return "x_dm";
  if (normalized.includes("gmail") || normalized.includes("email")) {
    return "gmail";
  }
  return "eliza_chat";
}

function connectorActivityReliabilityKey(
  platform: string,
  metadata?: Record<string, unknown>,
): LifeOpsReliabilityKey {
  if (metadata?.direction !== "outbound_by_owner") {
    return { kind: "message_inbound" };
  }
  return {
    kind: "message_outbound",
    channel: normalizeMessageReliabilityChannel(
      readMetadataString(metadata, "channel") ?? platform,
    ),
  };
}

/**
 * Built-in reliability weight for one of the closed
 * `LIFEOPS_ACTIVITY_SIGNAL_SOURCES`. Contributed (non-built-in) sources supply
 * their own weight through their `SignalSourceRegistry` entry and never reach
 * here — so an unknown source is a dispatch bug, not a data value: it throws
 * rather than fabricating a confidence number.
 */
export function resolveActivitySignalReliability(
  source: LifeOpsActivitySignalSourceName,
  platform: string,
  metadata?: Record<string, unknown>,
): number {
  if (!isBuiltinActivitySignalSource(source)) {
    throw new ElizaError(
      `resolveActivitySignalReliability: no built-in reliability weight for contributed source "${source}"; resolve it through the SignalSourceRegistry entry`,
      {
        code: "LIFEOPS_UNKNOWN_SIGNAL_SOURCE_RELIABILITY",
        context: { source, platform },
        severity: "fatal",
      },
    );
  }
  if (source === "app_lifecycle" && platform === "manual_override") {
    return resolveSourceReliability({ kind: "manual_override" });
  }
  if (source === "connector_activity") {
    return resolveSourceReliability(
      connectorActivityReliabilityKey(platform, metadata),
    );
  }
  return resolveSourceReliability(SOURCE_RELIABILITY_KEYS[source]);
}
