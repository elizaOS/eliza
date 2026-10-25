/**
 * Atomic persistence for OAuth success-proof tickets. Inserts fail loudly and
 * `DELETE … RETURNING` gives exactly one verifier ownership of a live nonce.
 */

import { and, eq, gt, lte } from "drizzle-orm";
import { dbWrite } from "../helpers";
import {
  type NewOAuthSuccessProofTicketRow,
  type OAuthSuccessProofTicketRow,
  oauthSuccessProofTickets,
} from "../schemas/oauth-success-proof-tickets";

export class OAuthSuccessProofTicketsRepository {
  async insert(row: NewOAuthSuccessProofTicketRow): Promise<OAuthSuccessProofTicketRow> {
    const [inserted] = await dbWrite.insert(oauthSuccessProofTickets).values(row).returning();
    if (!inserted) {
      throw new Error("OAuthSuccessProofTicketsRepository: failed to insert ticket");
    }
    return inserted;
  }

  async claim(
    nonceHash: string,
    now: Date = new Date(),
  ): Promise<OAuthSuccessProofTicketRow | undefined> {
    const [claimed] = await dbWrite
      .delete(oauthSuccessProofTickets)
      .where(
        and(
          eq(oauthSuccessProofTickets.nonce_hash, nonceHash),
          gt(oauthSuccessProofTickets.expires_at, now),
        ),
      )
      .returning();
    return claimed;
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const purged = await dbWrite
      .delete(oauthSuccessProofTickets)
      .where(lte(oauthSuccessProofTickets.expires_at, now))
      .returning({ nonce_hash: oauthSuccessProofTickets.nonce_hash });
    return purged.length;
  }
}

export const oauthSuccessProofTicketsRepository = new OAuthSuccessProofTicketsRepository();
