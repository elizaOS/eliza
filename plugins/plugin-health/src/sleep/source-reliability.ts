import type { LifeOpsActivitySignalSource } from "../contracts/health.js";

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
 * Default reliability key for each activity-signal source. The special-case
 * for `app_lifecycle` + `manual_override` platform is handled inline because
 * it's the only cross-axis override.
 */
const SOURCE_RELIABILITY_KEYS: Record<
  LifeOpsActivitySignalSource,
  LifeOpsReliabilityKey
> = {
  app_lifecycle: { kind: "device_presence", transition: true },
  page_visibility: { kind: "device_presence", transition: true },
  desktop_power: { kind: "desktop_power", transition: "system" },
  desktop_interaction: { kind: "desktop_idle", source: "iokit_hid" },
  connector_activity: { kind: "message_outbound", channel: "gmail" },
  imessage_outbound: { kind: "message_outbound", channel: "imessage" },
  mobile_device: { kind: "mobile_device", source: "capacitor" },
  mobile_health: { kind: "mobile_health", permissionGranted: true },
};

export function resolveActivitySignalReliability(
  source: LifeOpsActivitySignalSource,
  platform: string,
): number {
  if (source === "app_lifecycle" && platform === "manual_override") {
    return resolveSourceReliability({ kind: "manual_override" });
  }
  return resolveSourceReliability(SOURCE_RELIABILITY_KEYS[source]);
}
