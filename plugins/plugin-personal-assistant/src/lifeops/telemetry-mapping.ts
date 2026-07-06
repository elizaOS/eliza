/**
 * Shared mapper from persisted `LifeOpsActivitySignal` records into
 * `LifeOpsTelemetryPayload` rows. `LifeOpsRepository.createActivitySignal`
 * calls this on writes so passive signals are mirrored into
 * `life_telemetry_events` with a dedupe-stable payload.
 *
 * This file is the canonical mapping table for current signal families; keep
 * it aligned with the shared `LifeOpsTelemetryPayload` union.
 */

import crypto from "node:crypto";
// Import the leaf module, not the `@elizaos/plugin-health` barrel: this file is
// in the data-layer graph that `lifeops/repository.ts` pulls into the keyless
// node test lane (goals.real-db), where the barrel (→ React views → @elizaos/ui)
// must never enter and has no dist entry to resolve.
import { resolveActivitySignalReliability } from "@elizaos/plugin-health/sleep/source-reliability";
import type {
  LifeOpsActivitySignal,
  LifeOpsDevicePlatform,
  LifeOpsTelemetryEvent,
  LifeOpsTelemetryMessageChannel,
  LifeOpsTelemetryPayload,
} from "@elizaos/shared";

export function deriveTelemetryDedupeKey(
  family: string,
  agentId: string,
  occurredAt: string,
  payload: LifeOpsTelemetryPayload,
): string {
  const serialized = JSON.stringify({ family, agentId, occurredAt, payload });
  return crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 48);
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function hashTelemetryValue(scope: string, value: string): string {
  return `${scope}:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function normalizeDevicePlatform(value: string): LifeOpsDevicePlatform {
  const normalized = value.toLowerCase();
  if (normalized.includes("ios") && !normalized.includes("ipad")) {
    return "ios_capacitor";
  }
  if (normalized.includes("ipad")) {
    return "ipados_capacitor";
  }
  if (normalized.includes("electrobun")) {
    return "macos_electrobun";
  }
  if (normalized.includes("macos") || normalized.includes("desktop")) {
    return "macos_desktop";
  }
  return "browser_web";
}

function normalizeMessageChannel(
  value: string,
): LifeOpsTelemetryMessageChannel {
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

function readMessageDirection(
  metadata: Record<string, unknown>,
): "inbound" | "outbound_by_owner" {
  return metadata.direction === "outbound_by_owner"
    ? "outbound_by_owner"
    : "inbound";
}

export function mapSignalToTelemetryPayload(
  signal: LifeOpsActivitySignal,
): LifeOpsTelemetryPayload | null {
  if (signal.platform === "manual_override") {
    const kind =
      signal.metadata.manualOverrideKind === "going_to_bed"
        ? "going_to_bed"
        : signal.metadata.manualOverrideKind === "just_woke_up"
          ? "just_woke_up"
          : null;
    if (!kind) return null;
    return {
      family: "manual_override_event",
      platform: "macos_desktop",
      kind,
      note:
        typeof signal.metadata.note === "string" ? signal.metadata.note : null,
    };
  }

  switch (signal.source) {
    case "app_lifecycle":
    case "page_visibility":
      return {
        family: "device_presence_event",
        platform: normalizeDevicePlatform(signal.platform),
        state: signal.state,
        deviceId: signal.platform,
        isTransition: true,
        sequence: 0,
      };
    case "desktop_interaction":
      return {
        family: "desktop_idle_sample",
        platform: "macos_desktop",
        idleSeconds: signal.idleTimeSeconds ?? 0,
        source: "iokit_hid",
        isThresholdCrossing: false,
      };
    case "desktop_power":
      return {
        family: "desktop_power_event",
        platform: "macos_desktop",
        kind:
          signal.state === "active"
            ? "system_wake"
            : signal.state === "sleeping"
              ? "system_sleep"
              : signal.state === "locked"
                ? "session_lock"
                : "session_unlock",
        batteryPercent: null,
      };
    case "imessage_outbound":
      return {
        family: "message_activity_event",
        platform: "macos_desktop",
        channel: "imessage",
        direction: "outbound_by_owner",
        externalMessageId:
          typeof signal.metadata.externalMessageId === "string"
            ? signal.metadata.externalMessageId
            : signal.id,
        senderHash: "owner",
        conversationHash: "imessage_outbound",
      };
    case "connector_activity":
      return {
        family: "message_activity_event",
        platform: normalizeDevicePlatform(signal.platform),
        channel: normalizeMessageChannel(
          readMetadataString(signal.metadata, "channel") ?? signal.platform,
        ),
        direction: readMessageDirection(signal.metadata),
        externalMessageId:
          readMetadataString(signal.metadata, "externalMessageId") ?? signal.id,
        senderHash:
          readMetadataString(signal.metadata, "senderHash") ??
          hashTelemetryValue("sender", signal.id),
        conversationHash:
          readMetadataString(signal.metadata, "conversationHash") ??
          hashTelemetryValue("conversation", signal.platform),
      };
    case "mobile_device":
      return {
        family: "mobile_device_snapshot",
        platform: "ios_capacitor",
        source: signal.platform.startsWith("macos_continuity")
          ? "macos_continuity_probe"
          : "capacitor_mobile_signals",
        locked: signal.state === "locked",
        idleTimeSeconds: signal.idleTimeSeconds,
        onBattery: signal.onBattery,
        batteryPercent: null,
        pairedDeviceId:
          typeof signal.metadata.deviceId === "string"
            ? signal.metadata.deviceId
            : null,
      };
    case "mobile_health":
      if (!signal.health) return null;
      return {
        family: "mobile_health_snapshot",
        platform: "ios_capacitor",
        signal: signal.health,
        sampleId: null,
      };
    default:
      return null;
  }
}

export function buildTelemetryEventFromSignal(
  signal: LifeOpsActivitySignal,
  nowIso: string,
): LifeOpsTelemetryEvent | null {
  const payload = mapSignalToTelemetryPayload(signal);
  if (payload === null) return null;
  const reliability = resolveActivitySignalReliability(
    signal.source,
    signal.platform,
    signal.metadata,
  );
  return {
    id: crypto.randomUUID(),
    agentId: signal.agentId,
    family: payload.family,
    occurredAt: signal.observedAt,
    ingestedAt: nowIso,
    dedupeKey: deriveTelemetryDedupeKey(
      payload.family,
      signal.agentId,
      signal.observedAt,
      payload,
    ),
    sourceReliability: reliability,
    payload,
  };
}
