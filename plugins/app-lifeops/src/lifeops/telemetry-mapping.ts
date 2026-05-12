/**
 * Shared mapper from a persisted `LifeOpsActivitySignal` into a
 * `LifeOpsTelemetryPayload`. Used by the live writer in
 * `LifeOpsRepository.createActivitySignal` so every signal is mirrored into
 * the canonical `life_telemetry_events` store with a dedupe-stable payload.
 *
 * See `eliza/plugins/app-lifeops/docs/telemetry-event-families.md` §8 for the
 * canonical mapping table.
 */

import crypto from "node:crypto";
import { resolveActivitySignalReliability } from "@elizaos/plugin-health";
import type {
  LifeOpsActivitySignal,
  LifeOpsTelemetryEvent,
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
        platform: "macos_desktop",
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
        platform: "macos_desktop",
        channel: "gmail",
        direction:
          signal.metadata.direction === "outbound_by_owner"
            ? "outbound_by_owner"
            : "inbound",
        externalMessageId:
          typeof signal.metadata.externalMessageId === "string"
            ? signal.metadata.externalMessageId
            : signal.id,
        senderHash: "owner",
        conversationHash:
          typeof signal.metadata.conversationHash === "string"
            ? signal.metadata.conversationHash
            : "connector",
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
