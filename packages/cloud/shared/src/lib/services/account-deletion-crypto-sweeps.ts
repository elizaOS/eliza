/** Outstanding signed EVM effects must survive either account deletion cascade. */
import { ElizaError } from "@elizaos/core";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import { cryptoSweepOutbox } from "../../db/schemas/crypto-settlement-outbox";

export async function countUnconfirmedAccountEvmSweeps(
  userId: string,
  organizationId: string,
): Promise<number> {
  const [row] = await dbWrite
    .select({ count: sql<number>`count(*)::int` })
    .from(cryptoSweepOutbox)
    .innerJoin(cryptoPayments, eq(cryptoPayments.id, cryptoSweepOutbox.payment_id))
    .where(
      and(
        or(eq(cryptoPayments.organization_id, organizationId), eq(cryptoPayments.user_id, userId)),
        isNotNull(cryptoSweepOutbox.prepared_transaction),
        or(
          isNotNull(cryptoSweepOutbox.evm_sender),
          sql`${cryptoSweepOutbox.prepared_metadata}->>'network' IN ('base','bsc')`,
        ),
        isNull(cryptoSweepOutbox.evm_confirmed_at),
      ),
    );
  if (!row || !Number.isSafeInteger(row.count) || row.count < 0)
    throw new ElizaError("Account EVM sweep inventory returned an invalid count", {
      code: "ACCOUNT_DELETION_EVM_SWEEP_INVENTORY_INVALID",
      severity: "fatal",
    });
  return row.count;
}
