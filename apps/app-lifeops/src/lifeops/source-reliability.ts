import type { LifeOpsActivitySignalSource } from "@elizaos/shared/contracts/lifeops";

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
  | "milady_chat"
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
  milady_chat: 0.88,
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

export function resolveActivitySignalReliability(
  source: LifeOpsActivitySignalSource,
  platform: string,
): number {
  switch (source) {
    case "app_lifecycle":
      if (platform === "manual_override") {
        return resolveSourceReliability({ kind: "manual_override" });
      }
      return resolveSourceReliability({
        kind: "device_presence",
        transition: true,
      });
    case "page_visibility":
      return resolveSourceReliability({
        kind: "device_presence",
        transition: true,
      });
    case "desktop_power":
      return resolveSourceReliability({
        kind: "desktop_power",
        transition: "system",
      });
    case "desktop_interaction":
      return resolveSourceReliability({
        kind: "desktop_idle",
        source: "iokit_hid",
      });
    case "connector_activity":
      return resolveSourceReliability({
        kind: "message_outbound",
        channel: "gmail",
      });
    case "imessage_outbound":
      return resolveSourceReliability({
        kind: "message_outbound",
        channel: "imessage",
      });
    case "mobile_device":
      return resolveSourceReliability({
        kind: "mobile_device",
        source: "capacitor",
      });
    case "mobile_health":
      return resolveSourceReliability({
        kind: "mobile_health",
        permissionGranted: true,
      });
  }
}
