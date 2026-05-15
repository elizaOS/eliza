import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { executeRawSql, parseJsonRecord, sqlText, toText } from "./sql.js";

/**
 * Local intent store (formerly called "cross-device intent sync").
 *
 * An intent is a small structured message targeted at one or more of the
 * owner's logical devices (desktop, mobile, specific device). Intents are
 * persisted in a single local database table, and any process attached to
 * that database polls its pending queue; once acknowledged they are no
 * longer returned.
 *
 * NOTE: this module is *local-only*. There is no wire-level replication
 * across machines. Two separate agent processes running on different
 * machines will NOT see each other's intents. A cross-device replication
 * bridge (e.g. Eliza Cloud device-bus) is out of scope here — if/when that
 * bridge exists, it would sit alongside this table, not inside it.
 */

export const LIFE_INTENT_KINDS = [
  "user_action_requested",
  "routine_reminder",
  "attention_request",
  "state_sync",
] as const;

export type LifeOpsIntentKind = (typeof LIFE_INTENT_KINDS)[number];

export const LIFE_INTENT_TARGETS = [
  "all",
  "desktop",
  "mobile",
  "specific",
] as const;

export type LifeOpsIntentTargetDevice = (typeof LIFE_INTENT_TARGETS)[number];

export const LIFE_INTENT_PRIORITIES = [
  "low",
  "medium",
  "high",
  "urgent",
] as const;

export type LifeOpsIntentPriority = (typeof LIFE_INTENT_PRIORITIES)[number];

export interface LifeOpsIntent {
  id: string;
  agentId: string;
  kind: LifeOpsIntentKind;
  target: LifeOpsIntentTargetDevice;
  targetDeviceId?: string;
  title: string;
  body: string;
  actionUrl?: string;
  priority: LifeOpsIntentPriority;
  createdAt: string;
  expiresAt?: string;
  acknowledgedAt?: string;
  metadata: Record<string, unknown>;
}

export interface BroadcastIntentInput {
  kind: LifeOpsIntentKind;
  target?: LifeOpsIntentTargetDevice;
  targetDeviceId?: string;
  title: string;
  body: string;
  actionUrl?: string;
  priority?: LifeOpsIntentPriority;
  expiresInMinutes?: number;
  metadata?: Record<string, unknown>;
}

function assertKnownKind(kind: string): LifeOpsIntentKind {
  if ((LIFE_INTENT_KINDS as readonly string[]).includes(kind)) {
    return kind as LifeOpsIntentKind;
  }
  throw new Error(`unknown intent kind: ${kind}`);
}

function assertKnownTarget(target: string): LifeOpsIntentTargetDevice {
  if ((LIFE_INTENT_TARGETS as readonly string[]).includes(target)) {
    return target as LifeOpsIntentTargetDevice;
  }
  throw new Error(`unknown intent target: ${target}`);
}

function assertKnownPriority(priority: string): LifeOpsIntentPriority {
  if ((LIFE_INTENT_PRIORITIES as readonly string[]).includes(priority)) {
    return priority as LifeOpsIntentPriority;
  }
  throw new Error(`unknown intent priority: ${priority}`);
}

function rowToIntent(row: Record<string, unknown>): LifeOpsIntent {
  const targetDeviceId = toText(row.target_device_id, "");
  const actionUrl = toText(row.action_url, "");
  const expiresAt = toText(row.expires_at, "");
  const acknowledgedAt = toText(row.acknowledged_at, "");
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    kind: assertKnownKind(toText(row.kind)),
    target: assertKnownTarget(toText(row.target)),
    targetDeviceId: targetDeviceId.length > 0 ? targetDeviceId : undefined,
    title: toText(row.title),
    body: toText(row.body),
    actionUrl: actionUrl.length > 0 ? actionUrl : undefined,
    priority: assertKnownPriority(toText(row.priority)),
    createdAt: toText(row.created_at),
    expiresAt: expiresAt.length > 0 ? expiresAt : undefined,
    acknowledgedAt: acknowledgedAt.length > 0 ? acknowledgedAt : undefined,
    metadata: parseJsonRecord(row.metadata_json),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMetadataString(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  let current: unknown = metadata;
  for (const key of keys) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim().length > 0
    ? current.trim()
    : null;
}

function readMetadataNumber(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  let current: unknown = metadata;
  for (const key of keys) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  if (typeof current === "number" && Number.isFinite(current)) {
    return current;
  }
  if (typeof current === "string") {
    const parsed = Number(current);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function extractIntentLadderKey(
  metadata: Record<string, unknown>,
): string | null {
  return (
    readMetadataString(metadata, ["ladderId"]) ??
    readMetadataString(metadata, ["ladderKey"]) ??
    readMetadataString(metadata, ["payload", "ladderId"]) ??
    readMetadataString(metadata, ["payload", "ladderKey"])
  );
}

function extractIntentLadderRung(
  metadata: Record<string, unknown>,
): number | null {
  return (
    readMetadataNumber(metadata, ["rungIndex"]) ??
    readMetadataNumber(metadata, ["payload", "rungIndex"])
  );
}

type PendingIntentRow = {
  id: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

async function readPendingIntentRow(
  runtime: IAgentRuntime,
  intentId: string,
): Promise<PendingIntentRow | null> {
  const selectSql = `
    SELECT id, created_at, metadata_json
    FROM app_lifeops.life_intents
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND id = ${sqlText(intentId)}
      AND acknowledged_at IS NULL
    LIMIT 1`;
  const rows = await executeRawSql(runtime, selectSql);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: toText(row.id),
    createdAt: toText(row.created_at),
    metadata: parseJsonRecord(row.metadata_json),
  };
}

async function suppressPendingLadderRungs(
  runtime: IAgentRuntime,
  currentIntent: PendingIntentRow,
  deviceId: string,
  acknowledgedAt: string,
): Promise<void> {
  const ladderKey = extractIntentLadderKey(currentIntent.metadata);
  if (!ladderKey) {
    return;
  }
  const currentRung = extractIntentLadderRung(currentIntent.metadata);
  const selectSql = `
    SELECT id, created_at, metadata_json
    FROM app_lifeops.life_intents
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND acknowledged_at IS NULL
      AND id <> ${sqlText(currentIntent.id)}`;
  const rows = await executeRawSql(runtime, selectSql);
  const relatedIds = rows
    .map((row) => ({
      id: toText(row.id),
      createdAt: toText(row.created_at),
      metadata: parseJsonRecord(row.metadata_json),
    }))
    .filter((row) => {
      if (extractIntentLadderKey(row.metadata) !== ladderKey) {
        return false;
      }
      const candidateRung = extractIntentLadderRung(row.metadata);
      if (currentRung !== null && candidateRung !== null) {
        return candidateRung > currentRung;
      }
      if (currentRung !== null) {
        return true;
      }
      return row.createdAt >= currentIntent.createdAt;
    })
    .map((row) => row.id);

  if (relatedIds.length === 0) {
    return;
  }

  const updateSql = `
    UPDATE app_lifeops.life_intents
    SET acknowledged_at = ${sqlText(acknowledgedAt)},
        acknowledged_by = ${sqlText(deviceId)}
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND acknowledged_at IS NULL
      AND id IN (${relatedIds.map((id) => sqlText(id)).join(", ")})`;
  await executeRawSql(runtime, updateSql);
}

export async function broadcastIntent(
  runtime: IAgentRuntime,
  input: BroadcastIntentInput,
): Promise<LifeOpsIntent> {
  const kind = assertKnownKind(input.kind);
  const target = assertKnownTarget(input.target ?? "all");
  if (target === "specific" && !input.targetDeviceId) {
    throw new Error("targetDeviceId is required when target = 'specific'");
  }
  const priority = assertKnownPriority(input.priority ?? "medium");

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt =
    typeof input.expiresInMinutes === "number" && input.expiresInMinutes > 0
      ? new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString()
      : null;

  const metadata = input.metadata ?? {};
  const metadataJson = JSON.stringify(metadata);

  const targetDeviceId =
    target === "specific" ? (input.targetDeviceId ?? null) : null;

  const insertSql = `
    INSERT INTO app_lifeops.life_intents (
      id, agent_id, kind, target, target_device_id,
      title, body, action_url, priority,
      created_at, expires_at, acknowledged_at, acknowledged_by, metadata_json
    ) VALUES (
      ${sqlText(id)},
      ${sqlText(runtime.agentId)},
      ${sqlText(kind)},
      ${sqlText(target)},
      ${sqlText(targetDeviceId)},
      ${sqlText(input.title)},
      ${sqlText(input.body)},
      ${sqlText(input.actionUrl ?? null)},
      ${sqlText(priority)},
      ${sqlText(createdAt)},
      ${sqlText(expiresAt)},
      NULL,
      NULL,
      ${sqlText(metadataJson)}
    )`;

  await executeRawSql(runtime, insertSql);

  return {
    id,
    agentId: runtime.agentId,
    kind,
    target,
    targetDeviceId: targetDeviceId ?? undefined,
    title: input.title,
    body: input.body,
    actionUrl: input.actionUrl,
    priority,
    createdAt,
    expiresAt: expiresAt ?? undefined,
    metadata,
  };
}

export async function receivePendingIntents(
  runtime: IAgentRuntime,
  opts?: {
    device?: LifeOpsIntentTargetDevice;
    deviceId?: string;
    limit?: number;
  },
): Promise<LifeOpsIntent[]> {
  const device = opts?.device;
  if (device !== undefined) {
    assertKnownTarget(device);
  }
  const limit =
    typeof opts?.limit === "number" && opts.limit > 0
      ? Math.min(Math.trunc(opts.limit), 500)
      : 100;
  const nowIso = new Date().toISOString();

  // An intent is pending for a device if:
  //   - acknowledged_at IS NULL
  //   - not expired
  //   - target matches: "all", the device class, or "specific" with matching id
  const deviceFilter: string[] = [`target = 'all'`];
  if (device === "desktop" || device === "mobile") {
    deviceFilter.push(`target = ${sqlText(device)}`);
  }
  if (opts?.deviceId) {
    deviceFilter.push(
      `(target = 'specific' AND target_device_id = ${sqlText(opts.deviceId)})`,
    );
  }

  const selectSql = `
    SELECT id, agent_id, kind, target, target_device_id,
           title, body, action_url, priority,
           created_at, expires_at, acknowledged_at, metadata_json
    FROM app_lifeops.life_intents
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND acknowledged_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${sqlText(nowIso)})
      AND (${deviceFilter.join(" OR ")})
    ORDER BY created_at ASC
    LIMIT ${limit}`;

  const rows = await executeRawSql(runtime, selectSql);
  return rows.map(rowToIntent);
}

export async function acknowledgeIntent(
  runtime: IAgentRuntime,
  intentId: string,
  deviceId: string,
): Promise<void> {
  if (!intentId) throw new Error("intentId is required");
  if (!deviceId) throw new Error("deviceId is required");

  const currentIntent = await readPendingIntentRow(runtime, intentId);
  const nowIso = new Date().toISOString();
  const updateSql = `
    UPDATE app_lifeops.life_intents
    SET acknowledged_at = ${sqlText(nowIso)},
        acknowledged_by = ${sqlText(deviceId)}
    WHERE id = ${sqlText(intentId)}
      AND agent_id = ${sqlText(runtime.agentId)}
      AND acknowledged_at IS NULL`;
  await executeRawSql(runtime, updateSql);
  if (currentIntent) {
    await suppressPendingLadderRungs(runtime, currentIntent, deviceId, nowIso);
  }
}

export async function pruneExpiredIntents(
  runtime: IAgentRuntime,
): Promise<{ pruned: number }> {
  const nowIso = new Date().toISOString();

  const countSql = `
    SELECT COUNT(*) AS cnt FROM app_lifeops.life_intents
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND expires_at IS NOT NULL
      AND expires_at <= ${sqlText(nowIso)}`;
  const countRows = await executeRawSql(runtime, countSql);
  const cntRaw = countRows[0]?.cnt ?? countRows[0]?.count ?? 0;
  const pruned = Number(cntRaw) || 0;

  const deleteSql = `
    DELETE FROM app_lifeops.life_intents
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND expires_at IS NOT NULL
      AND expires_at <= ${sqlText(nowIso)}`;
  await executeRawSql(runtime, deleteSql);

  return { pruned };
}

export async function escalateUnacknowledgedIntents(
  runtime: IAgentRuntime,
  opts?: { thresholdMinutes?: number },
): Promise<{ escalated: number }> {
  const threshold = opts?.thresholdMinutes ?? 5;
  const cutoffTime = new Date(Date.now() - threshold * 60_000).toISOString();

  // Find intents targeting 'desktop' that have not been acknowledged and are older than cutoff
  const selectSql = `
    SELECT id, agent_id, kind, target, target_device_id,
           title, body, action_url, priority,
           created_at, expires_at, acknowledged_at, metadata_json
    FROM app_lifeops.life_intents
    WHERE agent_id = ${sqlText(runtime.agentId)}
      AND target = 'desktop'
      AND acknowledged_at IS NULL
      AND created_at <= ${sqlText(cutoffTime)}
      AND (expires_at IS NULL OR expires_at > ${sqlText(new Date().toISOString())})`;

  const rows = await executeRawSql(runtime, selectSql);
  const unacknowledgedIntents = rows.map(rowToIntent);

  let escalated = 0;
  for (const intent of unacknowledgedIntents) {
    // Suppress the original 'desktop' intent by acknowledging it by the system
    await acknowledgeIntent(runtime, intent.id, "system-escalator");

    // Broadcast the escalated intent to 'mobile'
    const escalatedMetadata = {
      ...(intent.metadata || {}),
      escalatedFrom: intent.id,
      escalatedAt: new Date().toISOString(),
    };

    await broadcastIntent(runtime, {
      kind: intent.kind,
      target: "mobile",
      title: `[Escalated] ${intent.title}`,
      body: intent.body,
      actionUrl: intent.actionUrl,
      priority: intent.priority === "urgent" ? "urgent" : "high", // Bump priority
      metadata: escalatedMetadata,
    });
    escalated++;
  }

  return { escalated };
}
