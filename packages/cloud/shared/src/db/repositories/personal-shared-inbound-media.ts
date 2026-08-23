/**
 * Atomic admission and idempotency authority for pooled-key vision descriptions
 * of inbound Personal Shared media. One primary-database transaction claims
 * the connector message id (the enrichment idempotency record) and consumes
 * the sender and connector per-day image ceilings; a denied ceiling rolls the
 * claim back, so a provider call is only ever reachable behind a committed
 * claim plus committed quota. The injectable database keeps the production
 * queries testable against an isolated PostgreSQL-compatible engine.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  type PersonalSharedInboundMediaPlatform,
  type PersonalSharedInboundMediaQuotaScope,
  personalSharedInboundMediaDescriptions,
  personalSharedInboundMediaQuotas,
} from "../schemas/personal-shared-inbound-media";
import { readPostLockDatabaseNow } from "./primary-database-clock";

/**
 * Longer than the gateway's 90s media-turn budget and the helper's fetch +
 * vision timeouts: a live execution always finishes (or fails) inside this
 * lease, so only a dead claimant's row is ever reclaimed.
 */
export const INBOUND_MEDIA_DESCRIPTION_LEASE_MS = 120_000;

export interface InboundMediaDescriptionIdentity {
  platform: PersonalSharedInboundMediaPlatform;
  project: string;
  connectorAccountId: string;
  /** The connector message id the gateway forwards as the turn's clientMessageId. */
  sourceMessageId: string;
}

export interface InboundMediaDescriptionCeilings {
  /** Images per UTC day for the resolved sending account (organization). */
  senderDailyImages: number;
  /** Images per UTC day across every sender of one connector account. */
  connectorDailyImages: number;
}

export interface AdmitInboundMediaDescriptionInput extends InboundMediaDescriptionIdentity {
  organizationId: string;
  userId: string;
  /** Digest of the exact media URL list; a reuse only matches the same digest. */
  mediaDigest: string;
  imageCount: number;
  ceilings: InboundMediaDescriptionCeilings;
}

export interface InboundMediaDescriptionClaim {
  id: string;
  claimToken: string;
  attempt: number;
}

export type InboundMediaDescriptionAdmission =
  | { kind: "claimed"; claim: InboundMediaDescriptionClaim }
  | { kind: "reused"; description: string }
  | { kind: "in_flight" }
  | { kind: "previously_failed"; reason: string }
  | { kind: "media_mismatch" }
  | {
      kind: "exhausted";
      scope: PersonalSharedInboundMediaQuotaScope;
      limit: number;
      used: number;
      requested: number;
    };

class QuotaExhaustedSignal extends Error {
  constructor(readonly denial: Extract<InboundMediaDescriptionAdmission, { kind: "exhausted" }>) {
    super(`Inbound media ${denial.scope} ceiling exhausted`);
    this.name = "QuotaExhaustedSignal";
  }
}

function storageFailure(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE",
    severity: "fatal",
    context,
  });
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Inbound media admission ${field} must be a positive integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Inbound media admission ${field} must be a non-negative integer`);
  }
}

function identityPredicate(identity: InboundMediaDescriptionIdentity) {
  return and(
    eq(personalSharedInboundMediaDescriptions.platform, identity.platform),
    eq(personalSharedInboundMediaDescriptions.project, identity.project),
    eq(personalSharedInboundMediaDescriptions.connector_account_id, identity.connectorAccountId),
    eq(personalSharedInboundMediaDescriptions.source_message_id, identity.sourceMessageId),
  );
}

export function inboundMediaConnectorQuotaKey(
  identity: Pick<InboundMediaDescriptionIdentity, "platform" | "project" | "connectorAccountId">,
): string {
  return `${identity.platform}:${identity.project}:${identity.connectorAccountId}`;
}

export class PersonalSharedInboundMediaRepository {
  constructor(private readonly database: Database) {}

  /**
   * Claims the connector message id and consumes both per-day ceilings in one
   * transaction. Every non-`claimed` outcome leaves the ledger untouched and
   * must keep the turn un-enriched: a stored description is reused, a live
   * claim or an earlier failure is never retried, and an exhausted ceiling
   * rolls the fresh claim back.
   */
  async admit(input: AdmitInboundMediaDescriptionInput): Promise<InboundMediaDescriptionAdmission> {
    assertPositiveSafeInteger(input.imageCount, "imageCount");
    assertNonNegativeSafeInteger(input.ceilings.senderDailyImages, "senderDailyImages");
    assertNonNegativeSafeInteger(input.ceilings.connectorDailyImages, "connectorDailyImages");
    if (!input.mediaDigest || !input.organizationId || !input.userId) {
      throw new TypeError("Inbound media admission identity is incomplete");
    }
    try {
      return await this.database.transaction(async (tx) => {
        const now = await readPostLockDatabaseNow(tx);
        const claimToken = crypto.randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + INBOUND_MEDIA_DESCRIPTION_LEASE_MS);
        const [inserted] = await tx
          .insert(personalSharedInboundMediaDescriptions)
          .values({
            platform: input.platform,
            project: input.project,
            connector_account_id: input.connectorAccountId,
            source_message_id: input.sourceMessageId,
            organization_id: input.organizationId,
            user_id: input.userId,
            media_digest: input.mediaDigest,
            image_count: input.imageCount,
            state: "pending",
            claim_token: claimToken,
            lease_expires_at: leaseExpiresAt,
            created_at: now,
            updated_at: now,
          })
          .onConflictDoNothing({
            target: [
              personalSharedInboundMediaDescriptions.platform,
              personalSharedInboundMediaDescriptions.project,
              personalSharedInboundMediaDescriptions.connector_account_id,
              personalSharedInboundMediaDescriptions.source_message_id,
            ],
          })
          .returning({
            id: personalSharedInboundMediaDescriptions.id,
            attempt_count: personalSharedInboundMediaDescriptions.attempt_count,
          });
        let claim: InboundMediaDescriptionClaim;
        if (inserted) {
          claim = { id: inserted.id, claimToken, attempt: inserted.attempt_count };
        } else {
          // The conflicting row is locked for the rest of the transaction, so
          // a concurrent redelivery observes either this claim or its outcome.
          const [existing] = await tx
            .select()
            .from(personalSharedInboundMediaDescriptions)
            .where(identityPredicate(input))
            .for("update");
          if (!existing) {
            throw storageFailure("Inbound media description claim vanished under lock", {
              sourceMessageId: input.sourceMessageId,
            });
          }
          if (existing.state === "described") {
            if (existing.media_digest !== input.mediaDigest) {
              return { kind: "media_mismatch" };
            }
            if (existing.description === null) {
              throw storageFailure("Described inbound media row carries no description", {
                id: existing.id,
              });
            }
            return { kind: "reused", description: existing.description };
          }
          if (existing.state === "failed") {
            return { kind: "previously_failed", reason: existing.failure_reason ?? "unknown" };
          }
          if (existing.lease_expires_at.getTime() > now.getTime()) {
            return { kind: "in_flight" };
          }
          // The previous claimant is dead (its lease lapsed without a terminal
          // state); take the claim over under a fresh token and attempt count.
          const [reclaimed] = await tx
            .update(personalSharedInboundMediaDescriptions)
            .set({
              organization_id: input.organizationId,
              user_id: input.userId,
              media_digest: input.mediaDigest,
              image_count: input.imageCount,
              claim_token: claimToken,
              lease_expires_at: leaseExpiresAt,
              attempt_count: sql`${personalSharedInboundMediaDescriptions.attempt_count} + 1`,
              updated_at: now,
            })
            .where(
              and(
                eq(personalSharedInboundMediaDescriptions.id, existing.id),
                eq(personalSharedInboundMediaDescriptions.state, "pending"),
              ),
            )
            .returning({ attempt_count: personalSharedInboundMediaDescriptions.attempt_count });
          if (!reclaimed) {
            throw storageFailure("Expired inbound media claim could not be reclaimed", {
              id: existing.id,
            });
          }
          claim = { id: existing.id, claimToken, attempt: reclaimed.attempt_count };
        }
        const day = now.toISOString().slice(0, 10);
        await consumeQuota(tx, {
          scope: "sender",
          scopeKey: input.organizationId,
          day,
          now,
          requested: input.imageCount,
          limit: input.ceilings.senderDailyImages,
        });
        await consumeQuota(tx, {
          scope: "connector",
          scopeKey: inboundMediaConnectorQuotaKey(input),
          day,
          now,
          requested: input.imageCount,
          limit: input.ceilings.connectorDailyImages,
        });
        return { kind: "claimed", claim };
      });
    } catch (error) {
      if (error instanceof QuotaExhaustedSignal) {
        // The transaction rolled back with the signal, so the claim row and
        // any sender increment never became visible.
        return error.denial;
      }
      throw error;
    }
  }

  /** Persists the description for a live claim; false when the claim was lost. */
  async complete(claim: InboundMediaDescriptionClaim, description: string): Promise<boolean> {
    if (!description) {
      throw new TypeError("Inbound media description completion requires a description");
    }
    return this.settle(claim, { state: "described", description, failure_reason: null });
  }

  /** Records a terminal failure for a live claim; false when the claim was lost. */
  async fail(claim: InboundMediaDescriptionClaim, reason: string): Promise<boolean> {
    if (!reason) {
      throw new TypeError("Inbound media description failure requires a reason");
    }
    return this.settle(claim, { state: "failed", description: null, failure_reason: reason });
  }

  private async settle(
    claim: InboundMediaDescriptionClaim,
    outcome:
      | { state: "described"; description: string; failure_reason: null }
      | { state: "failed"; description: null; failure_reason: string },
  ): Promise<boolean> {
    const now = new Date();
    const [settled] = await this.database
      .update(personalSharedInboundMediaDescriptions)
      .set({ ...outcome, completed_at: now, updated_at: now })
      .where(
        and(
          eq(personalSharedInboundMediaDescriptions.id, claim.id),
          eq(personalSharedInboundMediaDescriptions.claim_token, claim.claimToken),
          eq(personalSharedInboundMediaDescriptions.state, "pending"),
        ),
      )
      .returning({ id: personalSharedInboundMediaDescriptions.id });
    return settled !== undefined;
  }
}

async function consumeQuota(
  tx: DbTransaction,
  input: {
    scope: PersonalSharedInboundMediaQuotaScope;
    scopeKey: string;
    day: string;
    now: Date;
    requested: number;
    limit: number;
  },
): Promise<void> {
  const quotas = personalSharedInboundMediaQuotas;
  const used = async (): Promise<number> => {
    const [row] = await sqlRows<{ image_count: number | string }>(
      tx,
      sql`SELECT ${quotas.image_count} AS image_count FROM ${quotas}
        WHERE ${quotas.scope} = ${input.scope}
          AND ${quotas.scope_key} = ${input.scopeKey}
          AND ${quotas.day} = ${input.day}`,
    );
    return row ? Number(row.image_count) : 0;
  };
  if (input.requested > input.limit) {
    throw new QuotaExhaustedSignal({
      kind: "exhausted",
      scope: input.scope,
      limit: input.limit,
      used: await used(),
      requested: input.requested,
    });
  }
  // The conditional upsert is the atomic ceiling check: the conflicting row is
  // locked while the predicate runs, so concurrent claimants serialize here.
  const consumed = await sqlRows<{ image_count: number | string }>(
    tx,
    sql`INSERT INTO ${quotas} (scope, scope_key, day, image_count, updated_at)
      VALUES (${input.scope}, ${input.scopeKey}, ${input.day}, ${input.requested}, ${input.now})
      ON CONFLICT (scope, scope_key, day) DO UPDATE SET
        image_count = ${quotas.image_count} + EXCLUDED.image_count,
        updated_at = EXCLUDED.updated_at
      WHERE ${quotas.image_count} + EXCLUDED.image_count <= ${input.limit}
      RETURNING ${quotas.image_count} AS image_count`,
  );
  if (consumed.length === 0) {
    throw new QuotaExhaustedSignal({
      kind: "exhausted",
      scope: input.scope,
      limit: input.limit,
      used: await used(),
      requested: input.requested,
    });
  }
}

export const personalSharedInboundMediaRepository = new PersonalSharedInboundMediaRepository(
  dbWrite,
);
