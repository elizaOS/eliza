/**
 * Repository helpers for T8d `app_lifeops.life_activity_events`.
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

/**
 * The newest event strictly before `beforeIso`. A report window reads it to
 * learn which app was already in front when the window opened.
 *
 * Rows that {@link mapRow} drops (no bundle id) are skipped, as reports skip
 * them inside a window. On a shared stamp the activate is the newer event: an
 * app switch closes the old app and opens the new one in the same millisecond.
 */
export async function getLatestActivityEventBefore(
  runtime: IAgentRuntime,
  agentId: string,
  beforeIso: string,
): Promise<ActivityEventRow | null> {
  const rows = await executeRawSql(
    runtime,
    `SELECT id, agent_id, observed_at, event_kind, bundle_id, app_name, window_title
     FROM app_lifeops.life_activity_events
     WHERE agent_id = ${sqlQuote(agentId)}
       AND observed_at < ${sqlQuote(beforeIso)}
       AND event_kind IN ('activate', 'deactivate')
       AND bundle_id <> ''
     ORDER BY observed_at DESC,
       CASE event_kind WHEN 'activate' THEN 1 ELSE 0 END DESC
     LIMIT 1`,
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
