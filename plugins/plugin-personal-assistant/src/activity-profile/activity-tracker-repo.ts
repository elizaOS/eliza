/**
 * Repository helpers for the collector-owned activity event and idle-signal
 * tables in `app_lifeops`.
 *
 * Writes are append-only (one row per `activate` / `deactivate`). Reads
 * derive per-app dwell time by pairing consecutive `activate` events (the
 * collector always emits exactly one activate per focused app, and emits a
 * synthetic activate on startup so the first window has an anchor).
 */

import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { executeRawSql, sqlQuote, sqlText, toText } from "../lifeops/sql.js";

export interface ActivityEventRow {
  id: string;
  agentId: string;
  observedAt: string;
  eventKind: "activate" | "deactivate";
  bundleId: string;
  appName: string;
  windowTitle: string | null;
}

export interface ActivitySignalRow {
  id: string;
  agentId: string;
  source: string;
  state: string;
  observedAt: string;
  idleState: string | null;
  idleTimeSeconds: number | null;
}

/** Create collector-owned tables without booting every LifeOps domain. */
export async function bootstrapActivityEventSchema(
  runtime: IAgentRuntime,
): Promise<void> {
  await executeRawSql(runtime, "CREATE SCHEMA IF NOT EXISTS app_lifeops");
  await executeRawSql(
    runtime,
    `CREATE TABLE IF NOT EXISTS app_lifeops.life_activity_events (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      observed_at text NOT NULL,
      event_kind text NOT NULL,
      bundle_id text NOT NULL,
      app_name text NOT NULL,
      window_title text,
      metadata_json text NOT NULL DEFAULT '{}',
      created_at text NOT NULL
    )`,
  );
  await executeRawSql(
    runtime,
    `CREATE TABLE IF NOT EXISTS app_lifeops.life_activity_signals (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      source text NOT NULL,
      platform text NOT NULL DEFAULT '',
      state text NOT NULL,
      observed_at text NOT NULL,
      idle_state text,
      idle_time_seconds integer,
      on_battery boolean,
      metadata_json text NOT NULL DEFAULT '{}',
      created_at text NOT NULL
    )`,
  );
  await executeRawSql(
    runtime,
    `CREATE INDEX IF NOT EXISTS idx_life_activity_signals_agent
     ON app_lifeops.life_activity_signals (agent_id, observed_at)`,
  );
}

function mapRow(row: Record<string, unknown>): ActivityEventRow | null {
  const kindRaw = toText(row.event_kind, "");
  if (kindRaw !== "activate" && kindRaw !== "deactivate") return null;
  const id = toText(row.id, "");
  const agentId = toText(row.agent_id, "");
  const observedAt = toText(row.observed_at, "");
  const bundleId = toText(row.bundle_id, "");
  const appName = toText(row.app_name, "");
  if (!id || !agentId || !observedAt || !bundleId) return null;
  const windowTitleRaw = row.window_title;
  const windowTitle =
    typeof windowTitleRaw === "string" ? windowTitleRaw : null;
  return {
    id,
    agentId,
    observedAt,
    eventKind: kindRaw,
    bundleId,
    appName,
    windowTitle,
  };
}

export async function insertActivityEvent(
  runtime: IAgentRuntime,
  event: {
    agentId: string;
    observedAt: string;
    eventKind: "activate" | "deactivate";
    bundleId: string;
    appName: string;
    windowTitle: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await executeRawSql(
    runtime,
    `INSERT INTO app_lifeops.life_activity_events (
      id, agent_id, observed_at, event_kind, bundle_id, app_name,
      window_title, metadata_json, created_at
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(event.agentId)},
      ${sqlQuote(event.observedAt)},
      ${sqlQuote(event.eventKind)},
      ${sqlQuote(event.bundleId)},
      ${sqlQuote(event.appName)},
      ${sqlText(null)},
      ${sqlQuote("{}")},
      ${sqlQuote(createdAt)}
    )`,
  );
  return id;
}

export async function listActivityEvents(
  runtime: IAgentRuntime,
  agentId: string,
  sinceIso: string,
): Promise<ActivityEventRow[]> {
  const rows = await executeRawSql(
    runtime,
    `SELECT id, agent_id, observed_at, event_kind, bundle_id, app_name, window_title
     FROM app_lifeops.life_activity_events
     WHERE agent_id = ${sqlQuote(agentId)}
       AND observed_at >= ${sqlQuote(sinceIso)}
     ORDER BY observed_at ASC`,
  );
  return rows
    .map(mapRow)
    .filter((row): row is ActivityEventRow => row !== null);
}

/** List the complete agent-owned log for exact scenario baseline capture. */
export async function listAllActivityEvents(
  runtime: IAgentRuntime,
  agentId: string,
): Promise<ActivityEventRow[]> {
  const rows = await executeRawSql(
    runtime,
    `SELECT id, agent_id, observed_at, event_kind, bundle_id, app_name, window_title
     FROM app_lifeops.life_activity_events
     WHERE agent_id = ${sqlQuote(agentId)}
     ORDER BY observed_at ASC`,
  );
  return rows
    .map(mapRow)
    .filter((row): row is ActivityEventRow => row !== null);
}

/** List collector-originated idle signals for evidence and baseline capture. */
export async function listAllActivitySignals(
  runtime: IAgentRuntime,
  agentId: string,
): Promise<ActivitySignalRow[]> {
  const rows = await executeRawSql(
    runtime,
    `SELECT id, agent_id, source, state, observed_at, idle_state, idle_time_seconds
     FROM app_lifeops.life_activity_signals
     WHERE agent_id = ${sqlQuote(agentId)}
     ORDER BY observed_at ASC`,
  );
  return rows.flatMap((row): ActivitySignalRow[] => {
    const id = toText(row.id, "");
    const rowAgentId = toText(row.agent_id, "");
    const source = toText(row.source, "");
    const state = toText(row.state, "");
    const observedAt = toText(row.observed_at, "");
    if (!id || !rowAgentId || !source || !state || !observedAt) return [];
    const idleTimeRaw = row.idle_time_seconds;
    const idleTimeSeconds =
      typeof idleTimeRaw === "number"
        ? idleTimeRaw
        : typeof idleTimeRaw === "bigint"
          ? Number(idleTimeRaw)
          : null;
    return [
      {
        id,
        agentId: rowAgentId,
        source,
        state,
        observedAt,
        idleState: typeof row.idle_state === "string" ? row.idle_state : null,
        idleTimeSeconds,
      },
    ];
  });
}

/** Remove signals appended after one agent's captured scenario baseline. */
export async function restoreActivitySignalBaseline(
  runtime: IAgentRuntime,
  agentId: string,
  baselineIds: readonly string[],
): Promise<void> {
  const keep = baselineIds.map(sqlQuote).join(", ");
  await executeRawSql(
    runtime,
    `DELETE FROM app_lifeops.life_activity_signals
     WHERE agent_id = ${sqlQuote(agentId)}
       ${keep ? `AND id NOT IN (${keep})` : ""}`,
  );
}

/** Restore one agent's activity rows to an exact captured baseline. */
export async function restoreActivityEventBaseline(
  runtime: IAgentRuntime,
  agentId: string,
  baselineIds: readonly string[],
): Promise<void> {
  const keep = baselineIds.map(sqlQuote).join(", ");
  await executeRawSql(
    runtime,
    `DELETE FROM app_lifeops.life_activity_events
     WHERE agent_id = ${sqlQuote(agentId)}
       ${keep ? `AND id NOT IN (${keep})` : ""}`,
  );
}
