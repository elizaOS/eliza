/** Persists durable deletion receipts and generation-fenced worker state transitions. */

import { and, asc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AccountDeletionRequest,
  accountDeletionRequests,
  type NewAccountDeletionRequest,
} from "../schemas/account-deletion-requests";

export class AccountDeletionRequestsRepository {
  async findOpenByUserId(
    userId: string,
    readFromPrimary = false,
  ): Promise<AccountDeletionRequest | undefined> {
    const database = readFromPrimary ? dbWrite : dbRead;
    const [request] = await database
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.user_id, userId),
          isNull(accountDeletionRequests.completed_at),
        ),
      )
      .limit(1);
    return request;
  }

  async findById(id: string): Promise<AccountDeletionRequest | undefined> {
    const [request] = await dbRead
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, id))
      .limit(1);
    return request;
  }

  async createIdempotent(data: NewAccountDeletionRequest): Promise<AccountDeletionRequest> {
    const [created] = await dbWrite
      .insert(accountDeletionRequests)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    if (!data.user_id) {
      throw new Error("Account deletion request requires a user ID");
    }
    const existing = await this.findOpenByUserId(data.user_id, true);
    if (!existing) {
      throw new Error("Account deletion request conflicted but no open request was found");
    }
    return existing;
  }

  async update(
    id: string,
    data: Partial<NewAccountDeletionRequest>,
  ): Promise<AccountDeletionRequest | undefined> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({ ...data, updated_at: new Date() })
      .where(eq(accountDeletionRequests.id, id))
      .returning();
    return updated;
  }

  async claimDue(limit: number, now = new Date()): Promise<AccountDeletionRequest[]> {
    return await dbWrite.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.status, "scheduled"),
            lte(accountDeletionRequests.execute_after, now),
          ),
        )
        .orderBy(asc(accountDeletionRequests.execute_after))
        .for("update", { skipLocked: true })
        .limit(limit);
      if (due.length === 0) return [];
      const claimedAt = now;
      return await tx
        .update(accountDeletionRequests)
        .set({
          status: "processing",
          processing_started_at: claimedAt,
          updated_at: claimedAt,
        })
        .where(
          inArray(
            accountDeletionRequests.id,
            due.map((request) => request.id),
          ),
        )
        .returning();
    });
  }

  async recoverStaleProcessing(startedBefore: Date): Promise<number> {
    const recovered = await dbWrite
      .update(accountDeletionRequests)
      .set({ status: "scheduled", processing_started_at: null, updated_at: new Date() })
      .where(
        and(
          eq(accountDeletionRequests.status, "processing"),
          lt(accountDeletionRequests.processing_started_at, startedBefore),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    return recovered.length;
  }

  /** Parks only the exact worker generation that still owns the processing claim. */
  async markActionRequired(
    id: string,
    processingStartedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({
        status: "action_required",
        processing_started_at: null,
        last_error_code: errorCode,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(accountDeletionRequests.id, id),
          eq(accountDeletionRequests.status, "processing"),
          eq(accountDeletionRequests.processing_started_at, processingStartedAt),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    return updated !== undefined;
  }

  async recordPurgeFailure(
    id: string,
    processingStartedAt: Date,
    errorCode: string,
  ): Promise<AccountDeletionRequest | undefined> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({
        attempts: sql`${accountDeletionRequests.attempts} + 1`,
        status: sql`CASE WHEN ${accountDeletionRequests.attempts} + 1 >= ${accountDeletionRequests.max_attempts} THEN 'action_required' ELSE 'scheduled' END`,
        execute_after: new Date(Date.now() + 60 * 60 * 1_000),
        processing_started_at: null,
        last_error_code: errorCode,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(accountDeletionRequests.id, id),
          eq(accountDeletionRequests.status, "processing"),
          eq(accountDeletionRequests.processing_started_at, processingStartedAt),
        ),
      )
      .returning();
    return updated;
  }
}

export const accountDeletionRequestsRepository = new AccountDeletionRequestsRepository();
