/**
 * One-shot migrator from legacy per-source tables into the unified
 * `life_telemetry_events` store. Runs idempotently: the dedupe_key on the
 * destination table ensures re-runs are safe.
 *
 * See `eliza/apps/app-lifeops/docs/telemetry-event-families.md` section 8 for
 * the canonical mapping of source table to telemetry family.
 *
 * Scope (intentionally conservative):
 *  - `life_activity_signals` to `device_presence_event` / `desktop_idle_sample`
 *    / `desktop_power_event` / `message_activity_event` / `mobile_device_snapshot`
 *    / `mobile_health_snapshot` / `manual_override_event`
 *  - `life_activity_events` to `browser_focus_window` via paired activate/
 *    deactivate rows is future work; this migrator only handles signals.
 */

import crypto from "node:crypto";
import type {
  LifeOpsActivitySignal,
  LifeOpsTelemetryEvent,
  LifeOpsTelemetryPayload,
} from "@elizaos/shared/contracts/lifeops";
import type { LifeOpsRepository } from "./repository.js";
import { resolveActivitySignalReliability } from "./source-reliability.js";

function deriveDedupeKey(family: string, payload: unknown): string {
  const serialized = JSON.stringify({ family, payload });
  return crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 48);
}

function mapSignalToPayload(
  signal: LifeOpsActivitySignal,
): LifeOpsTelemetryPayload | null {
  // Manual override to manual_override_event.
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

export async function migrateActivitySignalsToTelemetry(args: {
  repository: LifeOpsRepository;
  agentId: string;
  sinceIso?: string;
  batchSize?: number;
}): Promise<{ migratedCount: number; skippedCount: number }> {
  const batchSize = args.batchSize ?? 500;
  const signals = await args.repository.listActivitySignals(args.agentId, {
    sinceAt: args.sinceIso ?? null,
    limit: batchSize,
  });
  let migratedCount = 0;
  let skippedCount = 0;
  const nowIso = new Date().toISOString();
  for (const signal of signals) {
    const payload = mapSignalToPayload(signal);
    if (payload === null) {
      skippedCount += 1;
      continue;
    }
    const reliability = resolveActivitySignalReliability(
      signal.source,
      signal.platform,
    );
    const event: LifeOpsTelemetryEvent = {
      id: crypto.randomUUID(),
      agentId: signal.agentId,
      family: payload.family,
      occurredAt: signal.observedAt,
      ingestedAt: nowIso,
      dedupeKey: deriveDedupeKey(payload.family, payload),
      sourceReliability: reliability,
      payload,
    };
    const inserted = await args.repository.insertTelemetryEvent(event);
    if (inserted) {
      migratedCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  return { migratedCount, skippedCount };
}

const DEFAULT_RETENTION_DAYS = 60;

export async function runTelemetryRetention(args: {
  repository: LifeOpsRepository;
  agentId: string;
  retentionDays?: number;
}): Promise<{ deletedCount: number }> {
  const retentionDays = args.retentionDays ?? DEFAULT_RETENTION_DAYS;
  return args.repository.pruneTelemetryEvents({
    agentId: args.agentId,
    retentionDays,
  });
}
