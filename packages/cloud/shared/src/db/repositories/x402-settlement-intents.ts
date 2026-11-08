/** Persists x402 top-up settlement intents through the shared DB boundary. */
import { and, asc, eq, lt } from "drizzle-orm";
import { dbWrite } from "../helpers";
import {
  type X402SettlementIntent,
  x402SettlementIntents,
} from "../schemas/x402-settlement-intents";

export type { X402SettlementIntent };

export interface X402SettlementIdentity {
  network: string;
  payer: string;
  nonce: string;
}

function identityWhere(identity: X402SettlementIdentity) {
  return and(
    eq(x402SettlementIntents.network, identity.network),
    eq(x402SettlementIntents.payer, identity.payer.toLowerCase()),
    eq(x402SettlementIntents.nonce, identity.nonce.toLowerCase()),
  );
}

export class X402SettlementIntentsRepository {
  /**
   * Records the intent for one payment identity, or returns the row an
   * earlier attempt with the same authorization already wrote.
   */
  async open(
    params: X402SettlementIdentity & { walletAddress: string; amountUsd: number },
  ): Promise<X402SettlementIntent> {
    const [created] = await dbWrite
      .insert(x402SettlementIntents)
      .values({
        network: params.network,
        payer: params.payer.toLowerCase(),
        nonce: params.nonce.toLowerCase(),
        wallet_address: params.walletAddress.toLowerCase(),
        amount_usd: params.amountUsd.toFixed(2),
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [existing] = await dbWrite
      .select()
      .from(x402SettlementIntents)
      .where(identityWhere(params))
      .limit(1);
    if (!existing) throw new Error("x402 settlement intent was not recorded");
    return existing;
  }

  async recordBroadcast(id: string, transaction: string): Promise<void> {
    await dbWrite
      .update(x402SettlementIntents)
      .set({ transaction, updated_at: new Date() })
      .where(and(eq(x402SettlementIntents.id, id), eq(x402SettlementIntents.status, "pending")));
  }

  /** Marks the transfer settled. Returns the row as it stands afterwards. */
  async markSettled(
    id: string,
    params: { transaction: string; creditKey: string; sourceId: string },
  ): Promise<X402SettlementIntent> {
    const now = new Date();
    const [settled] = await dbWrite
      .update(x402SettlementIntents)
      .set({
        status: "settled",
        transaction: params.transaction,
        credit_key: params.creditKey,
        source_id: params.sourceId,
        settled_at: now,
        updated_at: now,
      })
      .where(and(eq(x402SettlementIntents.id, id), eq(x402SettlementIntents.status, "pending")))
      .returning();
    if (settled) return settled;
    const [current] = await dbWrite
      .select()
      .from(x402SettlementIntents)
      .where(eq(x402SettlementIntents.id, id))
      .limit(1);
    if (!current) throw new Error("x402 settlement intent was not found");
    return current;
  }

  async markCredited(id: string, organizationId: string): Promise<void> {
    const now = new Date();
    await dbWrite
      .update(x402SettlementIntents)
      .set({
        status: "credited",
        organization_id: organizationId,
        last_error: null,
        credited_at: now,
        updated_at: now,
      })
      .where(and(eq(x402SettlementIntents.id, id), eq(x402SettlementIntents.status, "settled")));
  }

  /** Records why finishing failed; also moves the row behind the others in the queue. */
  async recordError(id: string, message: string): Promise<void> {
    await dbWrite
      .update(x402SettlementIntents)
      .set({ last_error: message.slice(0, 1000), updated_at: new Date() })
      .where(eq(x402SettlementIntents.id, id));
  }

  /** Settled intents not touched since `before`, oldest first. */
  async listSettledBefore(before: Date, limit: number): Promise<X402SettlementIntent[]> {
    return await dbWrite
      .select()
      .from(x402SettlementIntents)
      .where(
        and(
          eq(x402SettlementIntents.status, "settled"),
          lt(x402SettlementIntents.updated_at, before),
        ),
      )
      .orderBy(asc(x402SettlementIntents.updated_at))
      .limit(limit);
  }
}

export const x402SettlementIntentsRepository = new X402SettlementIntentsRepository();
