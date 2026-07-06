/**
 * Built-in mapper from persisted `LifeOpsActivitySignal` records into
 * `LifeOpsTelemetryPayload` rows, plus the registration that publishes those
 * mappers (and their reliability weights) into the `SignalSourceRegistry`.
 * `LifeOpsRepository.createActivitySignal` mirrors passive signals into
 * `life_telemetry_events` by dispatching through the registry, so the switch
 * below is the *built-in* half only — contributed sources bring their own
 * mapper. Keep the switch aligned with the shared `LifeOpsTelemetryPayload`
 * discriminated union.
 */

import crypto from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
// Import the leaf module, not the `@elizaos/plugin-health` barrel: this file is
// in the data-layer graph that `lifeops/repository.ts` pulls into the keyless
// node test lane (goals.real-db), where the barrel (→ React views → @elizaos/ui)
// must never enter and has no dist entry to resolve.
import { resolveActivitySignalReliability } from "@elizaos/plugin-health/sleep/source-reliability";
import {
  LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  type LifeOpsActivitySignal,
  type LifeOpsDevicePlatform,
  type LifeOpsTelemetryEvent,
  type LifeOpsTelemetryMessageChannel,
  type LifeOpsTelemetryPayload,
} from "@elizaos/shared";
import type {
  SignalSourceContribution,
  SignalSourceRegistry,
} from "./registries/signal-source-registry.js";

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

/**
 * Reliability weight for a built-in source, read straight from the health
 * reliability table. Contributed sources register their own resolver.
 */
function builtinSignalReliability(signal: LifeOpsActivitySignal): number {
  return resolveActivitySignalReliability(
    signal.source,
    signal.platform,
    signal.metadata,
  );
}

/**
 * Register the eight built-in passive-signal sources. All share the typed
 * built-in mapper (which dispatches on `signal.source`/`signal.platform`) and
 * the health reliability table; a plugin contributes a new source by calling
 * `registry.register` with its own `telemetryMapper` + `reliability`.
 */
export function registerBuiltinSignalSources(
  registry: SignalSourceRegistry,
): void {
  for (const source of LIFEOPS_ACTIVITY_SIGNAL_SOURCES) {
    const contribution: SignalSourceContribution = {
      source,
      description: `LifeOps built-in passive signal source: ${source}`,
      contributor: "app-lifeops",
      telemetryMapper: mapSignalToTelemetryPayload,
      reliability: builtinSignalReliability,
    };
    registry.register(contribution);
  }
}

/**
 * Build the canonical telemetry event for a persisted signal by dispatching
 * through the `SignalSourceRegistry`. An *unregistered* source is a broken
 * pipeline — it is surfaced via `runtime.reportError` (RECENT_ERRORS provider +
 * owner escalation) rather than silently dropped, which is what the old
 * `default: return null` switch branch did. A registered source whose mapper
 * returns `null` for this instance (e.g. `mobile_health` with no payload)
 * legitimately produces no row and returns quietly.
 */
export function buildTelemetryEventFromSignal(
  signal: LifeOpsActivitySignal,
  nowIso: string,
  registry: SignalSourceRegistry,
  runtime: IAgentRuntime,
): LifeOpsTelemetryEvent | null {
  const contribution = registry.get(signal.source);
  if (contribution === null) {
    runtime.reportError(
      "lifeops.telemetry-mapping",
      new ElizaError(
        `No SignalSourceRegistry entry for source "${signal.source}"; telemetry row dropped`,
        {
          code: "LIFEOPS_UNREGISTERED_SIGNAL_SOURCE",
          context: {
            source: signal.source,
            platform: signal.platform,
            agentId: signal.agentId,
          },
          severity: "ephemeral",
        },
      ),
    );
    return null;
  }
  const payload = contribution.telemetryMapper(signal);
  if (payload === null) return null;
  const reliability = contribution.reliability(signal);
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
