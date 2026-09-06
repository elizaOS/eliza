/** Owns activity telemetry persistence for LifeOps. Keeps domain mutations and existing transaction or claim boundaries together. */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import type { LifeOpsSleepEpisodeRecord } from "@elizaos/plugin-health/sleep/sleep-episode-types";
import type {
  LifeOpsActivitySignal,
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSession,
  LifeOpsTelemetryEvent,
  LifeOpsTelemetryFamily,
} from "../../contracts/index.js";
import { getSignalSourceRegistry } from "../registries/signal-source-registry.js";
import { publishActivitySignalToBus } from "../signals/activity-signal-publisher.js";
import { getActivitySignalBus } from "../signals/bus.js";
import {
  executeRawSql,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toNumber,
  toText,
} from "../sql.js";
import { buildTelemetryEventFromSignal } from "../telemetry-mapping.js";
import {
  type LifeOpsCircadianStateRow,
  parseActivitySignal,
  parseCircadianStateRow,
  parseScreenTimeDaily,
  parseScreenTimeSession,
  parseSleepEpisode,
  parseTelemetryEventRow,
} from "./activity-telemetry-records.js";
import { isoNow } from "./record-values.js";
export class ActivityTelemetryRepository {
  private static telemetryMirrorFailures = new Map<string, number>();
  constructor(private readonly runtime: IAgentRuntime) {}
  async createActivitySignal(signal: LifeOpsActivitySignal): Promise<void> {
    const metadata =
      signal.health !== null && signal.health !== undefined
        ? { ...signal.metadata, health: signal.health }
        : signal.metadata;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_activity_signals (
        id, agent_id, source, platform, state, observed_at, idle_state,
        idle_time_seconds, on_battery, metadata_json, created_at
      ) VALUES (
        ${sqlQuote(signal.id)},
        ${sqlQuote(signal.agentId)},
        ${sqlQuote(signal.source)},
        ${sqlQuote(signal.platform)},
        ${sqlQuote(signal.state)},
        ${sqlQuote(signal.observedAt)},
        ${sqlText(signal.idleState)},
        ${sqlInteger(signal.idleTimeSeconds)},
        ${signal.onBattery === null ? "NULL" : sqlBoolean(signal.onBattery)},
        ${sqlJson(metadata)},
        ${sqlQuote(signal.createdAt)}
      )`,
    );

    // Both the bus publish and the telemetry mirror dispatch through the
    // per-source registry. A missing registry is a boot-wiring failure, not a
    // data condition: surface it observably and skip the mirror rather than
    // fabricating a telemetry row for an unknown source.
    const signalSourceRegistry = getSignalSourceRegistry(this.runtime);
    if (signalSourceRegistry === null) {
      this.runtime.reportError(
        "lifeops.repository",
        new ElizaError(
          "SignalSourceRegistry is not registered on the runtime; activity-signal telemetry mirror skipped",
          {
            code: "LIFEOPS_SIGNAL_SOURCE_REGISTRY_MISSING",
            context: { agentId: signal.agentId, source: signal.source },
            severity: "fatal",
          },
        ),
      );
      return;
    }

    const activityBus = getActivitySignalBus(this.runtime);
    if (activityBus) {
      publishActivitySignalToBus(activityBus, signal, signalSourceRegistry);
    }

    // Mirror into the canonical telemetry store. Dedupes on
    // (agent_id, dedupe_key) so re-persists and migrator replays are safe.
    // Failures here must not block signal persistence, but they are counted,
    // logged (first + every 100th) and reported to the agent on the same bounded cadence so a sustained outage
    // remains visible without flooding the runtime error ring and event stream.
    try {
      const telemetry = buildTelemetryEventFromSignal(
        signal,
        new Date().toISOString(),
        signalSourceRegistry,
        this.runtime,
      );
      if (telemetry) {
        await this.insertTelemetryEvent(telemetry);
      }
      ActivityTelemetryRepository.telemetryMirrorFailures.delete(
        signal.agentId,
      );
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop
      const previousCount =
        ActivityTelemetryRepository.telemetryMirrorFailures.get(signal.agentId);
      const nextCount = previousCount === undefined ? 1 : previousCount + 1;
      ActivityTelemetryRepository.telemetryMirrorFailures.set(
        signal.agentId,
        nextCount,
      );
      if (nextCount === 1 || nextCount % 100 === 0) {
        logger.warn(
          {
            agentId: signal.agentId,
            source: signal.source,
            platform: signal.platform,
            consecutiveFailures: nextCount,
            error: error instanceof Error ? error.message : String(error),
          },
          "[lifeops] Telemetry mirror failed for activity signal.",
        );
        this.runtime.reportError(
          "lifeops.repository",
          new ElizaError(
            "Activity-signal telemetry mirror failed; the signal row committed without a telemetry copy",
            {
              code: "LIFEOPS_ACTIVITY_TELEMETRY_MIRROR_FAILED",
              context: {
                agentId: signal.agentId,
                source: signal.source,
                platform: signal.platform,
                consecutiveFailures: nextCount,
              },
              cause: error,
            },
          ),
        );
      }
    }
  }

  async listActivitySignals(
    agentId: string,
    args: {
      sinceAt?: string | null;
      limit?: number | null;
      states?: LifeOpsActivitySignal["state"][] | null;
    } = {},
  ): Promise<LifeOpsActivitySignal[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (args.sinceAt) {
      clauses.push(`observed_at >= ${sqlQuote(args.sinceAt)}`);
    }
    if (args.states && args.states.length > 0) {
      const stateList = args.states.map((state) => sqlQuote(state)).join(", ");
      clauses.push(`state IN (${stateList})`);
    }
    const limitClause =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${Math.trunc(args.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_activity_signals
        WHERE ${clauses.join("\n          AND ")}
        ORDER BY observed_at DESC
        ${limitClause}`,
    );
    return rows.map(parseActivitySignal);
  }

  async upsertScreenTimeSession(
    session: LifeOpsScreenTimeSession,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_screen_time_sessions (
         id, agent_id, source, identifier, display_name, start_at, end_at,
         duration_seconds, is_active, metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(session.id)},
         ${sqlQuote(session.agentId)},
         ${sqlQuote(session.source)},
         ${sqlQuote(session.identifier)},
         ${sqlQuote(session.displayName)},
         ${sqlQuote(session.startAt)},
         ${sqlText(session.endAt)},
         ${sqlInteger(session.durationSeconds)},
         ${sqlBoolean(session.isActive)},
         ${sqlJson(session.metadata)},
         ${sqlQuote(session.createdAt)},
         ${sqlQuote(session.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         source = EXCLUDED.source,
         identifier = EXCLUDED.identifier,
         display_name = EXCLUDED.display_name,
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         duration_seconds = EXCLUDED.duration_seconds,
         is_active = EXCLUDED.is_active,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getScreenTimeSession(
    agentId: string,
    id: string,
  ): Promise<LifeOpsScreenTimeSession | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_screen_time_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseScreenTimeSession(row) : null;
  }

  async finishScreenTimeSession(
    agentId: string,
    id: string,
    endAt: string,
    durationSeconds: number,
  ): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_screen_time_sessions
          SET end_at = ${sqlQuote(endAt)},
              duration_seconds = ${sqlInteger(durationSeconds)},
              is_active = ${sqlBoolean(false)},
              updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`,
    );
  }

  async listScreenTimeSessionsBetween(
    agentId: string,
    start: string,
    end: string,
    opts?: { source?: string; limit?: number },
  ): Promise<LifeOpsScreenTimeSession[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `start_at >= ${sqlQuote(start)}`,
      `start_at < ${sqlQuote(end)}`,
    ];
    if (opts?.source) {
      clauses.push(`source = ${sqlQuote(opts.source)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_screen_time_sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY start_at ASC
        ${limitClause}`,
    );
    return rows.map(parseScreenTimeSession);
  }

  async listScreenTimeSessionsOverlapping(
    agentId: string,
    start: string,
    end: string,
    opts?: { source?: string; limit?: number },
  ): Promise<LifeOpsScreenTimeSession[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `start_at < ${sqlQuote(end)}`,
      `(end_at IS NULL OR end_at > ${sqlQuote(start)})`,
    ];
    if (opts?.source) {
      clauses.push(`source = ${sqlQuote(opts.source)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_screen_time_sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY start_at ASC
        ${limitClause}`,
    );
    return rows.map(parseScreenTimeSession);
  }

  async upsertScreenTimeDaily(row: LifeOpsScreenTimeDaily): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_screen_time_daily (
         id, agent_id, source, identifier, date, total_seconds, session_count,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(row.id)},
         ${sqlQuote(row.agentId)},
         ${sqlQuote(row.source)},
         ${sqlQuote(row.identifier)},
         ${sqlQuote(row.date)},
         ${sqlInteger(row.totalSeconds)},
         ${sqlInteger(row.sessionCount)},
         ${sqlJson(row.metadata)},
         ${sqlQuote(row.createdAt)},
         ${sqlQuote(row.updatedAt)}
       )
       ON CONFLICT (agent_id, source, identifier, date) DO UPDATE SET
         total_seconds = EXCLUDED.total_seconds,
         session_count = EXCLUDED.session_count,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async insertTelemetryEvent(event: LifeOpsTelemetryEvent): Promise<boolean> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_telemetry_events (
         id, agent_id, family, occurred_at, ingested_at, dedupe_key,
         source_reliability, payload_json
       ) VALUES (
         ${sqlQuote(event.id)},
         ${sqlQuote(event.agentId)},
         ${sqlQuote(event.family)},
         ${sqlQuote(event.occurredAt)},
         ${sqlQuote(event.ingestedAt)},
         ${sqlQuote(event.dedupeKey)},
         ${sqlNumber(event.sourceReliability)},
         ${sqlJson(event.payload)}
       )
       ON CONFLICT(agent_id, dedupe_key) DO NOTHING
       RETURNING id`,
    );
    return rows.length > 0;
  }

  async listTelemetryEvents(args: {
    agentId: string;
    familyIn?: LifeOpsTelemetryFamily[];
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
  }): Promise<LifeOpsTelemetryEvent[]> {
    const clauses = [`agent_id = ${sqlQuote(args.agentId)}`];
    if (args.familyIn && args.familyIn.length > 0) {
      const inList = args.familyIn.map((family) => sqlQuote(family)).join(", ");
      clauses.push(`family IN (${inList})`);
    }
    if (args.sinceIso) {
      clauses.push(`occurred_at >= ${sqlQuote(args.sinceIso)}`);
    }
    if (args.untilIso) {
      clauses.push(`occurred_at <= ${sqlQuote(args.untilIso)}`);
    }
    const limitClause =
      typeof args.limit === "number" ? `LIMIT ${sqlInteger(args.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_telemetry_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY occurred_at ASC
        ${limitClause}`,
    );
    return rows.map(parseTelemetryEventRow);
  }

  async pruneTelemetryEvents(args: {
    agentId: string;
    retentionDays: number;
  }): Promise<{ deletedCount: number }> {
    const cutoff = new Date(
      Date.now() - args.retentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_telemetry_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND occurred_at < ${sqlQuote(cutoff)}
        RETURNING id`,
    );
    return { deletedCount: rows.length };
  }

  async upsertTelemetryDailyRollup(args: {
    agentId: string;
    sinceIso: string;
    untilIso: string;
  }): Promise<{ bucketsWritten: number }> {
    const nowIso = new Date().toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT family,
              SUBSTR(occurred_at, 1, 10) AS local_date,
              COUNT(*) AS event_count,
              MAX(occurred_at) AS last_observed_at
         FROM app_lifeops.life_telemetry_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND occurred_at >= ${sqlQuote(args.sinceIso)}
          AND occurred_at < ${sqlQuote(args.untilIso)}
        GROUP BY family, SUBSTR(occurred_at, 1, 10)`,
    );
    let bucketsWritten = 0;
    for (const row of rows) {
      const family = toText(row.family);
      const localDate = toText(row.local_date);
      const eventCount = Number(row.event_count ?? 0);
      const lastObservedAt = toText(row.last_observed_at);
      if (!family || !localDate || !lastObservedAt) continue;
      await executeRawSql(
        this.runtime,
        `INSERT INTO app_lifeops.life_telemetry_rollup_daily (
           agent_id, family, local_date, event_count,
           last_observed_at, created_at, updated_at
         ) VALUES (
           ${sqlQuote(args.agentId)},
           ${sqlQuote(family)},
           ${sqlQuote(localDate)},
           ${sqlInteger(eventCount)},
           ${sqlQuote(lastObservedAt)},
           ${sqlQuote(nowIso)},
           ${sqlQuote(nowIso)}
         )
         ON CONFLICT(agent_id, family, local_date) DO UPDATE SET
           event_count = EXCLUDED.event_count,
           last_observed_at = EXCLUDED.last_observed_at,
           updated_at = EXCLUDED.updated_at`,
      );
      bucketsWritten += 1;
    }
    return { bucketsWritten };
  }

  async readCircadianState(
    agentId: string,
  ): Promise<LifeOpsCircadianStateRow | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_circadian_states
        WHERE agent_id = ${sqlQuote(agentId)}
        LIMIT 1`,
    );
    return rows[0] ? parseCircadianStateRow(rows[0]) : null;
  }

  async upsertCircadianState(state: LifeOpsCircadianStateRow): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_circadian_states (
         agent_id, circadian_state, state_confidence, uncertainty_reason,
         entered_at, since_sleep_detected_at, since_wake_observed_at,
         since_wake_confirmed_at, evidence_refs_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(state.agentId)},
         ${sqlQuote(state.circadianState)},
         ${sqlNumber(state.stateConfidence)},
         ${sqlText(state.uncertaintyReason)},
         ${sqlQuote(state.enteredAt)},
         ${sqlText(state.sinceSleepDetectedAt)},
         ${sqlText(state.sinceWakeObservedAt)},
         ${sqlText(state.sinceWakeConfirmedAt)},
         ${sqlJson(state.evidenceRefs)},
         ${sqlQuote(state.createdAt)},
         ${sqlQuote(state.updatedAt)}
       )
       ON CONFLICT(agent_id) DO UPDATE SET
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         entered_at = EXCLUDED.entered_at,
         since_sleep_detected_at = EXCLUDED.since_sleep_detected_at,
         since_wake_observed_at = EXCLUDED.since_wake_observed_at,
         since_wake_confirmed_at = EXCLUDED.since_wake_confirmed_at,
         evidence_refs_json = EXCLUDED.evidence_refs_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async upsertSleepEpisode(episode: LifeOpsSleepEpisodeRecord): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_sleep_episodes (
         id, agent_id, start_at, end_at, source, confidence, cycle_type,
         sealed, evidence_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(episode.id)},
         ${sqlQuote(episode.agentId)},
         ${sqlQuote(episode.startAt)},
         ${sqlText(episode.endAt)},
         ${sqlQuote(episode.source)},
         ${sqlNumber(episode.confidence)},
         ${sqlQuote(episode.cycleType)},
         ${sqlBoolean(episode.sealed)},
         ${sqlJson(episode.evidence)},
         ${sqlQuote(episode.createdAt)},
         ${sqlQuote(episode.updatedAt)}
       )
       ON CONFLICT(agent_id, start_at) DO UPDATE SET
         end_at = EXCLUDED.end_at,
         source = EXCLUDED.source,
         confidence = EXCLUDED.confidence,
         cycle_type = EXCLUDED.cycle_type,
         sealed = EXCLUDED.sealed,
         evidence_json = EXCLUDED.evidence_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async listSleepEpisodesBetween(
    agentId: string,
    startAt: string,
    endAt: string,
    opts?: { includeOpen?: boolean; limit?: number },
  ): Promise<LifeOpsSleepEpisodeRecord[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `(end_at IS NULL OR end_at >= ${sqlQuote(startAt)})`,
      `start_at <= ${sqlQuote(endAt)}`,
    ];
    if (opts?.includeOpen !== true) {
      clauses.push("sealed = TRUE");
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_sleep_episodes
        WHERE ${clauses.join(" AND ")}
        ORDER BY start_at ASC
        ${limitClause}`,
    );
    return rows.map(parseSleepEpisode);
  }

  async listScreenTimeDaily(
    agentId: string,
    date: string,
    opts?: { source?: string; limit?: number },
  ): Promise<LifeOpsScreenTimeDaily[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `date = ${sqlQuote(date)}`,
    ];
    if (opts?.source) {
      clauses.push(`source = ${sqlQuote(opts.source)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_screen_time_daily
        WHERE ${clauses.join(" AND ")}
        ORDER BY total_seconds DESC
        ${limitClause}`,
    );
    return rows.map(parseScreenTimeDaily);
  }

  async aggregateScreenTimeDailyForDate(
    agentId: string,
    date: string,
  ): Promise<{ updated: number }> {
    // Sessions counted when their start_at falls within the UTC day window.
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT source,
              identifier,
              MAX(display_name) AS display_name,
              SUM(duration_seconds) AS total_seconds,
              COUNT(*) AS session_count
         FROM app_lifeops.life_screen_time_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND start_at >= ${sqlQuote(dayStart)}
          AND start_at <= ${sqlQuote(dayEnd)}
        GROUP BY source, identifier`,
    );
    const now = isoNow();
    let updated = 0;
    for (const row of rows) {
      const rollup: LifeOpsScreenTimeDaily = {
        id: crypto.randomUUID(),
        agentId,
        source: toText(row.source) as "app" | "website",
        identifier: toText(row.identifier),
        date,
        totalSeconds: toNumber(row.total_seconds, 0),
        sessionCount: toNumber(row.session_count, 0),
        metadata: {
          displayName: toText(row.display_name, toText(row.identifier)),
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.upsertScreenTimeDaily(rollup);
      updated += 1;
    }
    return { updated };
  }
}
