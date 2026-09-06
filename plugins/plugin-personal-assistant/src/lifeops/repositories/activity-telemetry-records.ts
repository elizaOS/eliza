/** Defines and parses activity telemetry records for the LifeOps persistence boundary, preserving public factory and row contracts. */

import crypto from "node:crypto";
import type { LifeOpsSleepEpisodeRecord } from "@elizaos/plugin-health/sleep/sleep-episode-types";
import type {
  LifeOpsActivitySignal,
  LifeOpsCircadianState,
  LifeOpsHealthSignal,
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSession,
  LifeOpsSleepCycleEvidence,
  LifeOpsTelemetryEvent,
  LifeOpsTelemetryFamily,
  LifeOpsTelemetryPayload,
  LifeOpsUnclearReason,
} from "../../contracts/index.js";
import {
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";
import { isoNow } from "./record-values.js";

export function parseOptionalFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function parseHealthSignal(value: unknown): LifeOpsHealthSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sleepRecord =
    record.sleep &&
    typeof record.sleep === "object" &&
    !Array.isArray(record.sleep)
      ? (record.sleep as Record<string, unknown>)
      : null;
  const biometricsRecord =
    record.biometrics &&
    typeof record.biometrics === "object" &&
    !Array.isArray(record.biometrics)
      ? (record.biometrics as Record<string, unknown>)
      : null;
  const permissionsRecord =
    record.permissions &&
    typeof record.permissions === "object" &&
    !Array.isArray(record.permissions)
      ? (record.permissions as Record<string, unknown>)
      : null;

  const source = toText(record.source, "healthkit");
  const normalizedSource: LifeOpsHealthSignal["source"] =
    source === "health_connect" ||
    source === "strava" ||
    source === "fitbit" ||
    source === "withings" ||
    source === "oura"
      ? source
      : "healthkit";

  return {
    source: normalizedSource,
    permissions: {
      sleep: toBoolean(permissionsRecord?.sleep ?? false),
      biometrics: toBoolean(permissionsRecord?.biometrics ?? false),
    },
    sleep: {
      available: toBoolean(sleepRecord?.available ?? false),
      isSleeping: toBoolean(sleepRecord?.isSleeping ?? false),
      asleepAt: sleepRecord?.asleepAt ? toText(sleepRecord.asleepAt) : null,
      awakeAt: sleepRecord?.awakeAt ? toText(sleepRecord.awakeAt) : null,
      durationMinutes: parseOptionalFiniteNumber(sleepRecord?.durationMinutes),
      stage: sleepRecord?.stage ? toText(sleepRecord.stage) : null,
    },
    biometrics: {
      sampleAt: biometricsRecord?.sampleAt
        ? toText(biometricsRecord.sampleAt)
        : null,
      heartRateBpm: parseOptionalFiniteNumber(biometricsRecord?.heartRateBpm),
      restingHeartRateBpm: parseOptionalFiniteNumber(
        biometricsRecord?.restingHeartRateBpm,
      ),
      heartRateVariabilityMs: parseOptionalFiniteNumber(
        biometricsRecord?.heartRateVariabilityMs,
      ),
      respiratoryRate: parseOptionalFiniteNumber(
        biometricsRecord?.respiratoryRate,
      ),
      bloodOxygenPercent: parseOptionalFiniteNumber(
        biometricsRecord?.bloodOxygenPercent,
      ),
    },
    warnings: Array.isArray(record.warnings)
      ? record.warnings
          .map((warning) => toText(warning))
          .filter((warning) => warning.length > 0)
      : [],
  };
}

export function parseActivitySignal(
  row: Record<string, unknown>,
): LifeOpsActivitySignal {
  const metadata = parseJsonRecord(row.metadata_json);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as LifeOpsActivitySignal["source"],
    platform: toText(row.platform),
    state: toText(row.state) as LifeOpsActivitySignal["state"],
    observedAt: toText(row.observed_at),
    idleState: row.idle_state
      ? (toText(row.idle_state) as LifeOpsActivitySignal["idleState"])
      : null,
    idleTimeSeconds:
      row.idle_time_seconds === null || row.idle_time_seconds === undefined
        ? null
        : toNumber(row.idle_time_seconds, 0),
    onBattery:
      row.on_battery === null || row.on_battery === undefined
        ? null
        : toBoolean(row.on_battery),
    health: parseHealthSignal(metadata.health),
    metadata,
    createdAt: toText(row.created_at),
  };
}

export function parseScreenTimeSession(
  row: Record<string, unknown>,
): LifeOpsScreenTimeSession {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as "app" | "website",
    identifier: toText(row.identifier),
    displayName: toText(row.display_name, toText(row.identifier)),
    startAt: toText(row.start_at),
    endAt: row.end_at ? toText(row.end_at) : null,
    durationSeconds: toNumber(row.duration_seconds, 0),
    isActive: toBoolean(row.is_active),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseScreenTimeDaily(
  row: Record<string, unknown>,
): LifeOpsScreenTimeDaily {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as "app" | "website",
    identifier: toText(row.identifier),
    date: toText(row.date),
    totalSeconds: toNumber(row.total_seconds, 0),
    sessionCount: toNumber(row.session_count, 0),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseTelemetryEventRow(
  row: Record<string, unknown>,
): LifeOpsTelemetryEvent {
  const payload = parseJsonValue<LifeOpsTelemetryPayload>(row.payload_json, {
    family: "manual_override_event",
    platform: "macos_desktop",
    kind: "going_to_bed",
    note: null,
  });
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    family: toText(row.family) as LifeOpsTelemetryFamily,
    occurredAt: toText(row.occurred_at),
    ingestedAt: toText(row.ingested_at),
    dedupeKey: toText(row.dedupe_key),
    sourceReliability: toNumber(row.source_reliability, 0.5),
    payload,
  };
}

export interface LifeOpsCircadianStateRow {
  agentId: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  enteredAt: string;
  sinceSleepDetectedAt: string | null;
  sinceWakeObservedAt: string | null;
  sinceWakeConfirmedAt: string | null;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export function parseCircadianStateRow(
  row: Record<string, unknown>,
): LifeOpsCircadianStateRow {
  return {
    agentId: toText(row.agent_id),
    circadianState: toText(row.circadian_state) as LifeOpsCircadianState,
    stateConfidence: toNumber(row.state_confidence, 0),
    uncertaintyReason: row.uncertainty_reason
      ? (toText(row.uncertainty_reason) as LifeOpsUnclearReason)
      : null,
    enteredAt: toText(row.entered_at),
    sinceSleepDetectedAt: row.since_sleep_detected_at
      ? toText(row.since_sleep_detected_at)
      : null,
    sinceWakeObservedAt: row.since_wake_observed_at
      ? toText(row.since_wake_observed_at)
      : null,
    sinceWakeConfirmedAt: row.since_wake_confirmed_at
      ? toText(row.since_wake_confirmed_at)
      : null,
    evidenceRefs: parseJsonArray<string>(row.evidence_refs_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseSleepEpisode(
  row: Record<string, unknown>,
): LifeOpsSleepEpisodeRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    startAt: toText(row.start_at),
    endAt: row.end_at ? toText(row.end_at) : null,
    source: toText(row.source) as LifeOpsSleepEpisodeRecord["source"],
    confidence: toNumber(row.confidence, 0),
    cycleType: toText(
      row.cycle_type,
      "unknown",
    ) as LifeOpsSleepEpisodeRecord["cycleType"],
    sealed: toBoolean(row.sealed, false),
    evidence: parseJsonArray<LifeOpsSleepCycleEvidence>(row.evidence_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

// createLifeOpsSubscriptionAudit / Candidate / Cancellation moved to
// @elizaos/plugin-finances along with the finance tables. The subscriptions
// mixin imports them from there directly.

export function createLifeOpsActivitySignal(
  params: Omit<LifeOpsActivitySignal, "id" | "createdAt">,
): LifeOpsActivitySignal {
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: isoNow(),
  };
}
