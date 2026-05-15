import { and, eq, gt, lt } from "drizzle-orm";
import { dbWrite } from "@/db/helpers";
import {
  type AppAuthCode,
  appAuthCodes,
  type NewAppAuthCode,
} from "@/db/schemas/app-auth-codes";

export type { AppAuthCode, NewAppAuthCode };

/**
 * Single-use authorization codes for the `Authorize this app` consent flow.
 * Rows are keyed by SHA-256 hash of the plaintext code; plaintext is never
 * persisted. Lookups always filter `expires_at > now()` so a stale row that
 * outlived the cron cleanup still fails redemption.
 */
export class AppAuthCodesRepository {
  async create(record: NewAppAuthCode): Promise<AppAuthCode> {
    const [row] = await dbWrite.insert(appAuthCodes).values(record).returning();
    if (!row) {
      throw new Error("Failed to insert app_auth_codes row");
    }
    return row;
  }

  /**
   * Atomically read-and-delete an active (unexpired) code. Single-use
   * semantics: even if two requests redeem the same code in parallel, at most
   * one of them gets a non-undefined return because `DELETE ... RETURNING` is
   * atomic at the row level.
   */
  async consume(codeHash: string): Promise<AppAuthCode | undefined> {
    const now = new Date();
    const [row] = await dbWrite
      .delete(appAuthCodes)
      .where(
        and(
          eq(appAuthCodes.code_hash, codeHash),
          gt(appAuthCodes.expires_at, now),
        ),
      )
      .returning();
    return row;
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const deleted = await dbWrite
      .delete(appAuthCodes)
      .where(lt(appAuthCodes.expires_at, now))
      .returning({ code_hash: appAuthCodes.code_hash });
    return deleted.length;
  }
}

export const appAuthCodesRepository = new AppAuthCodesRepository();
