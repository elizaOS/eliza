/** Owns brief engagement attribution, finalization, and reward leases over the LifeOps ledger. Transaction handles stay with the complete attribution operation. */

import crypto from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  type LifeOpsBriefEngagementEventType,
  type LifeOpsBriefItemEngagementSummary,
  type LifeOpsBriefItemSource,
  summarizeBriefEngagementRows,
} from "../briefing/editorial-judgment.js";
import type { LifeOpsDatabaseContext } from "../sql.js";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";
import {
  briefRewardMarkerId,
  type LifeOpsBriefItemEngagementRecord,
  type LifeOpsBriefItemEngagementWrite,
  parseBriefItemEngagement,
} from "./brief-engagement-records.js";
import { isoNow } from "./record-values.js";
export class BriefEngagementRepository {
  constructor(private readonly runtime: LifeOpsDatabaseContext) {}
  async recordBriefItemEngagement(
    input: LifeOpsBriefItemEngagementWrite,
    tx?: TransactionalDb,
  ): Promise<LifeOpsBriefItemEngagementRecord> {
    const createdAt = input.createdAt ?? isoNow();
    const domainEventId =
      typeof input.metadata.domainEventId === "string"
        ? input.metadata.domainEventId
        : null;
    const id =
      input.id ??
      `brief_eng_${crypto
        .createHash("sha256")
        .update(
          domainEventId
            ? [
                input.agentId,
                input.briefingId,
                input.itemId,
                input.source,
                input.sourceId,
                input.eventType,
                domainEventId,
              ].join("\0")
            : [
                input.agentId,
                input.briefingId,
                input.itemId,
                input.eventType,
                input.eventAt,
                "",
              ].join("\0"),
        )
        .digest("hex")
        .slice(0, 20)}`;
    const insertSql = `INSERT INTO app_lifeops.life_brief_item_engagements (
        id, agent_id, briefing_id, item_id, source, kind, source_id,
        item_class, event_type, event_at, weight, metadata_json, created_at
      ) VALUES (
        ${sqlQuote(id)},
        ${sqlQuote(input.agentId)},
        ${sqlQuote(input.briefingId)},
        ${sqlQuote(input.itemId)},
        ${sqlQuote(input.source)},
        ${sqlQuote(input.kind)},
        ${sqlQuote(input.sourceId)},
        ${sqlQuote(input.itemClass)},
        ${sqlQuote(input.eventType)},
        ${sqlQuote(input.eventAt)},
        ${sqlNumber(input.weight)},
        ${sqlJson(input.metadata)},
        ${sqlQuote(createdAt)}
      )
      ON CONFLICT (id)
      DO UPDATE SET
        source = EXCLUDED.source,
        kind = EXCLUDED.kind,
        source_id = EXCLUDED.source_id,
        item_class = EXCLUDED.item_class,
        weight = EXCLUDED.weight,
        metadata_json = EXCLUDED.metadata_json
      WHERE app_lifeops.life_brief_item_engagements.agent_id = EXCLUDED.agent_id`;
    if (tx) await executeRawSqlTx(tx, insertSql);
    else await executeRawSql(this.runtime, insertSql);
    const selectSql = `SELECT *
         FROM app_lifeops.life_brief_item_engagements
        WHERE agent_id = ${sqlQuote(input.agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`;
    const rows = tx
      ? await executeRawSqlTx(tx, selectSql)
      : await executeRawSql(this.runtime, selectSql);
    const row = rows[0] ? parseBriefItemEngagement(rows[0]) : null;
    if (!row) {
      throw new ElizaError(
        "[LifeOpsRepository] Failed to reload brief engagement",
        {
          code: "LIFEOPS_BRIEF_ENGAGEMENT_RELOAD_FAILED",
          context: {
            agentId: input.agentId,
            briefingId: input.briefingId,
            itemId: input.itemId,
            eventType: input.eventType,
            eventAt: input.eventAt,
          },
          severity: "fatal",
        },
      );
    }
    return row;
  }

  async getBriefItemEngagement(
    agentId: string,
    id: string,
  ): Promise<LifeOpsBriefItemEngagementRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_brief_item_engagements
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBriefItemEngagement(row) : null;
  }

  async listBriefItemEngagements(
    agentId: string,
    options: {
      briefingId?: string;
      itemClass?: string;
      sinceIso?: string;
      untilIso?: string;
      includeOperational?: boolean;
    } = {},
  ): Promise<LifeOpsBriefItemEngagementRecord[]> {
    const where = [`agent_id = ${sqlQuote(agentId)}`];
    if (options.briefingId) {
      where.push(`briefing_id = ${sqlQuote(options.briefingId)}`);
    }
    if (options.itemClass) {
      where.push(`item_class = ${sqlQuote(options.itemClass)}`);
    }
    if (options.sinceIso) {
      where.push(`event_at >= ${sqlQuote(options.sinceIso)}`);
    }
    if (options.untilIso) {
      where.push(`event_at <= ${sqlQuote(options.untilIso)}`);
    }
    if (!options.includeOperational) {
      where.push("event_type <> 'rewarded'");
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_brief_item_engagements
        WHERE ${where.join(" AND ")}
        ORDER BY event_at ASC, created_at ASC`,
    );
    return rows.map(parseBriefItemEngagement);
  }

  async listPendingBriefEngagementRewards(
    agentId: string,
    options: { limit?: number; nowIso?: string } = {},
  ): Promise<LifeOpsBriefItemEngagementRecord[]> {
    const limit = options.limit ?? 250;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new ElizaError(
        "[LifeOpsRepository] Invalid pending reward batch limit",
        {
          code: "LIFEOPS_BRIEF_REWARD_BATCH_LIMIT_INVALID",
          context: { limit },
        },
      );
    }
    const requestedNowIso = options.nowIso ?? isoNow();
    const parsedNow = Date.parse(requestedNowIso);
    if (!Number.isFinite(parsedNow)) {
      throw new ElizaError(
        "[LifeOpsRepository] Invalid pending reward scan time",
        {
          code: "LIFEOPS_BRIEF_REWARD_SCAN_TIME_INVALID",
          context: { nowIso: requestedNowIso },
        },
      );
    }
    const nowIso = new Date(parsedNow).toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT outcome.*
         FROM app_lifeops.life_brief_item_engagements outcome
        WHERE outcome.agent_id = ${sqlQuote(agentId)}
          AND outcome.event_type IN (
            'opened', 'replied', 'completed', 'rescheduled', 'kept',
            'dismissed', 'ignored'
          )
          AND outcome.weight <> 0
          AND NULLIF(BTRIM(outcome.metadata_json::jsonb ->> 'trajectoryId'), '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM app_lifeops.life_brief_item_engagements receipt
             WHERE receipt.agent_id = outcome.agent_id
               AND receipt.event_type = 'rewarded'
               AND receipt.metadata_json::jsonb ->> 'engagementEventId' = outcome.id
               AND CASE receipt.metadata_json::jsonb ->> 'rewardState'
                 WHEN 'released' THEN FALSE
                 WHEN 'claimed' THEN receipt.event_at::timestamptz >
                   ${sqlQuote(nowIso)}::timestamptz
                 ELSE TRUE
               END
          )
        ORDER BY COALESCE(
          (
            SELECT MAX(retry_order.created_at::timestamptz)
              FROM app_lifeops.life_brief_item_engagements retry_order
             WHERE retry_order.agent_id = outcome.agent_id
               AND retry_order.event_type = 'rewarded'
               AND retry_order.metadata_json::jsonb ->> 'engagementEventId' = outcome.id
          ),
          outcome.event_at::timestamptz
        ) ASC,
        outcome.event_at::timestamptz ASC,
        outcome.created_at::timestamptz ASC,
        outcome.id ASC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseBriefItemEngagement);
  }

  async summarizeBriefItemEngagements(
    agentId: string,
    options: {
      sinceIso?: string;
      untilIso?: string;
    } = {},
  ): Promise<readonly LifeOpsBriefItemEngagementSummary[]> {
    return summarizeBriefEngagementRows(
      await this.listBriefItemEngagements(agentId, options),
    );
  }

  async attributeBriefItemEngagement(input: {
    agentId: string;
    source: LifeOpsBriefItemSource;
    sourceId: string;
    eventType: Extract<
      LifeOpsBriefEngagementEventType,
      "opened" | "replied" | "completed" | "rescheduled" | "kept"
    >;
    eventAt: string;
    domainEventId: string;
    weight: number;
    metadata?: Record<string, unknown>;
    windowHours?: number;
  }): Promise<LifeOpsBriefItemEngagementRecord | null> {
    const eventMs = Date.parse(input.eventAt);
    if (!Number.isFinite(eventMs)) {
      throw new ElizaError(
        "[LifeOpsRepository] Invalid brief engagement time",
        {
          code: "LIFEOPS_BRIEF_ENGAGEMENT_TIME_INVALID",
          context: {
            eventAt: input.eventAt,
            domainEventId: input.domainEventId,
          },
        },
      );
    }
    const windowHours = input.windowHours ?? 24;
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      throw new ElizaError("[LifeOpsRepository] Invalid engagement window", {
        code: "LIFEOPS_BRIEF_ENGAGEMENT_WINDOW_INVALID",
        context: { windowHours },
      });
    }
    const windowStart = new Date(
      eventMs - windowHours * 60 * 60 * 1_000,
    ).toISOString();
    return withTransaction(this.runtime, async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `SELECT *
           FROM app_lifeops.life_brief_item_engagements
          WHERE agent_id = ${sqlQuote(input.agentId)}
            AND source = ${sqlQuote(input.source)}
            AND source_id = ${sqlQuote(input.sourceId)}
            AND event_type = 'rendered'
            AND event_at > ${sqlQuote(windowStart)}
            AND event_at <= ${sqlQuote(input.eventAt)}
          ORDER BY event_at DESC, created_at DESC
          LIMIT 1 FOR UPDATE`,
      );
      const rendered = rows[0] ? parseBriefItemEngagement(rows[0]) : null;
      if (!rendered) return null;
      const ignored = await executeRawSqlTx(
        tx,
        `SELECT id
           FROM app_lifeops.life_brief_item_engagements
          WHERE agent_id = ${sqlQuote(input.agentId)}
            AND briefing_id = ${sqlQuote(rendered.briefingId)}
            AND item_id = ${sqlQuote(rendered.itemId)}
            AND event_type = 'ignored'
          LIMIT 1`,
      );
      if (ignored.length > 0) return null;
      return this.recordBriefItemEngagement(
        {
          agentId: input.agentId,
          briefingId: rendered.briefingId,
          itemId: rendered.itemId,
          source: rendered.source,
          kind: rendered.kind,
          sourceId: rendered.sourceId,
          itemClass: rendered.itemClass,
          eventType: input.eventType,
          eventAt: input.eventAt,
          weight: input.weight,
          metadata: {
            ...rendered.metadata,
            ...(input.metadata ?? {}),
            domainEventId: input.domainEventId,
            attributedRenderedEventId: rendered.id,
          },
        },
        tx,
      );
    });
  }

  async finalizeExpiredBriefItemEngagements(
    agentId: string,
    options: { asOfIso?: string; windowHours?: number } = {},
  ): Promise<number> {
    const asOfIso = options.asOfIso ?? isoNow();
    const windowHours = options.windowHours ?? 24;
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      throw new ElizaError("[LifeOpsRepository] Invalid engagement window", {
        code: "LIFEOPS_BRIEF_ENGAGEMENT_WINDOW_INVALID",
        context: { windowHours },
      });
    }
    const cutoffIso = new Date(
      Date.parse(asOfIso) - windowHours * 60 * 60 * 1_000,
    ).toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT rendered.*
         FROM app_lifeops.life_brief_item_engagements rendered
        WHERE rendered.agent_id = ${sqlQuote(agentId)}
          AND rendered.event_type = 'rendered'
          AND rendered.event_at <= ${sqlQuote(cutoffIso)}
          AND NOT EXISTS (
            SELECT 1
              FROM app_lifeops.life_brief_item_engagements outcome
             WHERE outcome.agent_id = rendered.agent_id
               AND outcome.briefing_id = rendered.briefing_id
               AND outcome.item_id = rendered.item_id
               AND outcome.event_type IN (
                 'opened', 'replied', 'completed', 'rescheduled', 'kept',
                 'dismissed', 'ignored'
               )
               AND outcome.event_at >= rendered.event_at
               AND outcome.event_at::timestamptz <=
                 rendered.event_at::timestamptz +
                 (${sqlNumber(windowHours)} * INTERVAL '1 hour')
          )
        ORDER BY rendered.event_at ASC, rendered.id ASC`,
    );
    let finalized = 0;
    for (const raw of rows) {
      const rendered = parseBriefItemEngagement(raw);
      const expiryAt = new Date(
        Date.parse(rendered.eventAt) + windowHours * 60 * 60 * 1_000,
      ).toISOString();
      const inserted = await withTransaction(this.runtime, async (tx) => {
        const locked = await executeRawSqlTx(
          tx,
          `SELECT id
             FROM app_lifeops.life_brief_item_engagements
            WHERE agent_id = ${sqlQuote(agentId)}
              AND id = ${sqlQuote(rendered.id)}
            LIMIT 1 FOR UPDATE`,
        );
        if (locked.length === 0) return false;
        const outcomes = await executeRawSqlTx(
          tx,
          `SELECT id
             FROM app_lifeops.life_brief_item_engagements
            WHERE agent_id = ${sqlQuote(agentId)}
              AND briefing_id = ${sqlQuote(rendered.briefingId)}
              AND item_id = ${sqlQuote(rendered.itemId)}
              AND event_type IN (
                'opened', 'replied', 'completed', 'rescheduled', 'kept',
                'dismissed', 'ignored'
              )
              AND event_at >= ${sqlQuote(rendered.eventAt)}
              AND event_at::timestamptz <=
                ${sqlQuote(rendered.eventAt)}::timestamptz +
                (${sqlNumber(windowHours)} * INTERVAL '1 hour')
            LIMIT 1`,
        );
        if (outcomes.length > 0) return false;
        await this.recordBriefItemEngagement(
          {
            agentId,
            briefingId: rendered.briefingId,
            itemId: rendered.itemId,
            source: rendered.source,
            kind: rendered.kind,
            sourceId: rendered.sourceId,
            itemClass: rendered.itemClass,
            eventType: "ignored",
            eventAt: expiryAt,
            weight: -0.25,
            metadata: {
              ...rendered.metadata,
              attributedRenderedEventId: rendered.id,
              finalizationWindowHours: windowHours,
            },
          },
          tx,
        );
        return true;
      });
      if (inserted) finalized += 1;
    }
    return finalized;
  }

  async claimBriefEngagementReward(
    engagement: LifeOpsBriefItemEngagementRecord,
    options: { nowIso?: string; leaseSeconds?: number } = {},
  ): Promise<string | null> {
    const id = briefRewardMarkerId(engagement.agentId, engagement.id);
    const requestedNowIso = options.nowIso ?? isoNow();
    const parsedNow = Date.parse(requestedNowIso);
    const leaseSeconds = options.leaseSeconds ?? 60;
    const leaseExpiresMs = parsedNow + leaseSeconds * 1_000;
    if (
      !Number.isFinite(parsedNow) ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds <= 0 ||
      leaseSeconds > 3_600 ||
      !Number.isFinite(new Date(leaseExpiresMs).getTime())
    ) {
      throw new ElizaError("[LifeOpsRepository] Invalid reward lease", {
        code: "LIFEOPS_BRIEF_REWARD_LEASE_INVALID",
        context: { nowIso: requestedNowIso, leaseSeconds },
      });
    }
    const nowIso = new Date(parsedNow).toISOString();
    const leaseExpiresAt = new Date(leaseExpiresMs).toISOString();
    const claimToken = crypto.randomUUID();
    const claimMetadata = {
      engagementEventId: engagement.id,
      rewardState: "claimed",
      claimToken,
      leaseExpiresAt,
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_brief_item_engagements (
        id, agent_id, briefing_id, item_id, source, kind, source_id,
        item_class, event_type, event_at, weight, metadata_json, created_at
      ) VALUES (
        ${sqlQuote(id)}, ${sqlQuote(engagement.agentId)},
        ${sqlQuote(engagement.briefingId)}, ${sqlQuote(engagement.itemId)},
        ${sqlQuote(engagement.source)}, ${sqlQuote(engagement.kind)},
        ${sqlQuote(engagement.sourceId)}, ${sqlQuote(engagement.itemClass)},
        'rewarded', ${sqlQuote(leaseExpiresAt)},
        ${sqlNumber(engagement.weight)},
        ${sqlJson(claimMetadata)}, ${sqlQuote(nowIso)}
      ) ON CONFLICT (id) DO UPDATE SET
        event_at = EXCLUDED.event_at,
        metadata_json = EXCLUDED.metadata_json,
        created_at = EXCLUDED.created_at
      WHERE app_lifeops.life_brief_item_engagements.agent_id = EXCLUDED.agent_id
        AND CASE app_lifeops.life_brief_item_engagements.metadata_json::jsonb ->> 'rewardState'
          WHEN 'released' THEN TRUE
          WHEN 'claimed' THEN
            app_lifeops.life_brief_item_engagements.event_at::timestamptz <=
              ${sqlQuote(nowIso)}::timestamptz
          ELSE FALSE
        END
      RETURNING id`,
    );
    return rows.length === 1 ? claimToken : null;
  }

  async completeBriefEngagementRewardClaim(
    engagement: LifeOpsBriefItemEngagementRecord,
    claimToken: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_brief_item_engagements
          SET metadata_json = ${sqlJson({
            engagementEventId: engagement.id,
            rewardState: "completed",
            trajectoryRewardKey: `brief-engagement:${engagement.id}`,
          })}
        WHERE id = ${sqlQuote(briefRewardMarkerId(engagement.agentId, engagement.id))}
          AND agent_id = ${sqlQuote(engagement.agentId)}
          AND metadata_json LIKE ${sqlQuote(`%"claimToken":"${claimToken}"%`)}`,
    );
  }

  async releaseBriefEngagementRewardClaim(
    engagement: LifeOpsBriefItemEngagementRecord,
    claimToken: string,
  ): Promise<void> {
    const releasedAt = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_brief_item_engagements AS reward
          SET event_at = ${sqlQuote(releasedAt)},
              created_at = GREATEST(
                ${sqlQuote(releasedAt)}::timestamptz,
                reward.created_at::timestamptz + INTERVAL '1 microsecond',
                COALESCE(
                  (
                    SELECT MAX(peer.created_at::timestamptz) + INTERVAL '1 microsecond'
                      FROM app_lifeops.life_brief_item_engagements peer
                     WHERE peer.agent_id = reward.agent_id
                       AND peer.event_type = 'rewarded'
                       AND peer.id <> reward.id
                  ),
                  '-infinity'::timestamptz
                )
              )::text,
              metadata_json = ${sqlJson({
                engagementEventId: engagement.id,
                rewardState: "released",
              })}
        WHERE id = ${sqlQuote(briefRewardMarkerId(engagement.agentId, engagement.id))}
          AND agent_id = ${sqlQuote(engagement.agentId)}
          AND metadata_json LIKE ${sqlQuote(`%"claimToken":"${claimToken}"%`)}`,
    );
  }
}
