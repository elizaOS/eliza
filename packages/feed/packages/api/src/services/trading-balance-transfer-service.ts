import {
  and,
  balanceTransactions,
  db,
  desc,
  eq,
  inArray,
  sql,
  users,
} from "@feed/db";
import {
  CANONICAL_PEER_TRANSFER_TRANSACTION_TYPES,
  generateSnowflakeId,
  logger,
  PEER_TRANSFER_IN_TRANSACTION_TYPE,
  PEER_TRANSFER_OUT_TRANSACTION_TYPE,
} from "@feed/shared";
import { CACHE_KEYS, cachedDb, invalidateCache } from "../cache";
import { findUserByIdentifier } from "../users/user-lookup";

const MAX_TRANSFER_AMOUNT = 1_000_000;

export type TradingBalanceTransferErrorCode =
  | "INVALID_AMOUNT"
  | "SELF_TRANSFER"
  | "SENDER_NOT_ALLOWED"
  | "RECIPIENT_NOT_FOUND"
  | "RECIPIENT_NOT_ALLOWED"
  | "INSUFFICIENT_BALANCE";

export interface TradingBalanceTransferSuccess {
  success: true;
  transferId: string;
  amount: number;
  senderUserId: string;
  senderHistoricalAuthId?: string | null;
  senderUsername?: string | null;
  recipientUserId: string;
  recipientHistoricalAuthId?: string | null;
  recipientUsername?: string | null;
  senderBalanceBefore: number;
  senderBalanceAfter: number;
  recipientBalanceBefore: number;
  recipientBalanceAfter: number;
}

export interface TradingBalanceTransferFailure {
  success: false;
  errorCode: TradingBalanceTransferErrorCode;
  error: string;
}

export type TradingBalanceTransferResult =
  | TradingBalanceTransferSuccess
  | TradingBalanceTransferFailure;

function buildTransferDescription(params: {
  direction: "in" | "out";
  counterpartyLabel: string;
  note?: string;
}): string {
  const base =
    params.direction === "out"
      ? `Trading balance transfer to ${params.counterpartyLabel}`
      : `Trading balance transfer from ${params.counterpartyLabel}`;

  return params.note ? `${base}: ${params.note}` : base;
}

export class TradingBalanceTransferService {
  private static async afterBalanceMutation(
    usersToInvalidate: Array<{
      id: string;
      privyId?: string | null;
      username?: string | null;
    }>,
  ): Promise<void> {
    const uniqueUsers = Array.from(
      new Map(usersToInvalidate.map((user) => [user.id, user])).values(),
    );

    await Promise.allSettled(
      uniqueUsers.flatMap((user) => [
        invalidateCache(user.id, { namespace: CACHE_KEYS.USER_BALANCE }),
        invalidateCache(user.id, { namespace: CACHE_KEYS.USER }),
        cachedDb.invalidateUserIdentifierCaches({
          id: user.id,
          privyId: user.privyId,
          username: user.username,
        }),
      ]),
    );
  }

  static async getTransferHistory(
    userId: string,
    limit = 100,
  ): Promise<
    Array<{
      id: string;
      type: string;
      amount: number;
      balanceBefore: number;
      balanceAfter: number;
      description: string | null;
      relatedId: string | null;
      createdAt: Date;
    }>
  > {
    const transactions = await db
      .select({
        id: balanceTransactions.id,
        type: balanceTransactions.type,
        amount: balanceTransactions.amount,
        balanceBefore: balanceTransactions.balanceBefore,
        balanceAfter: balanceTransactions.balanceAfter,
        description: balanceTransactions.description,
        relatedId: balanceTransactions.relatedId,
        createdAt: balanceTransactions.createdAt,
      })
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          inArray(balanceTransactions.type, [
            ...CANONICAL_PEER_TRANSFER_TRANSACTION_TYPES,
          ]),
        ),
      )
      .orderBy(desc(balanceTransactions.createdAt))
      .limit(limit);

    return transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amount: Number(transaction.amount),
      balanceBefore: Number(transaction.balanceBefore),
      balanceAfter: Number(transaction.balanceAfter),
      description: transaction.description,
      relatedId: transaction.relatedId,
      createdAt: transaction.createdAt,
    }));
  }

  static async transfer(params: {
    senderUserId: string;
    recipientIdentifier: string;
    amount: number;
    note?: string;
  }): Promise<TradingBalanceTransferResult> {
    const senderUserId = params.senderUserId.trim();
    const recipientIdentifier = params.recipientIdentifier.trim();
    const amount = Math.round(params.amount * 100) / 100;
    const note = params.note?.trim() || undefined;

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_TRANSFER_AMOUNT
    ) {
      return {
        success: false,
        errorCode: "INVALID_AMOUNT",
        error: "Amount must be greater than 0 and within the allowed limit",
      };
    }

    const recipient = await findUserByIdentifier(recipientIdentifier, {
      id: true,
      username: true,
      displayName: true,
      isActor: true,
      isAgent: true,
    });

    if (!recipient) {
      return {
        success: false,
        errorCode: "RECIPIENT_NOT_FOUND",
        error: "Recipient not found",
      };
    }

    if (recipient.id === senderUserId) {
      return {
        success: false,
        errorCode: "SELF_TRANSFER",
        error: "Cannot transfer trading balance to yourself",
      };
    }

    if (recipient.isActor || recipient.isAgent) {
      return {
        success: false,
        errorCode: "RECIPIENT_NOT_ALLOWED",
        error: "Recipient must be a Feed user, not an actor or agent",
      };
    }

    const result = await db.transaction(async (tx) => {
      const userIds = [senderUserId, recipient.id].sort();
      const lockedUsers = await tx
        .select({
          id: users.id,
          username: users.username,
          privyId: users.privyId,
          displayName: users.displayName,
          virtualBalance: users.virtualBalance,
          isActor: users.isActor,
          isAgent: users.isAgent,
        })
        .from(users)
        .where(inArray(users.id, userIds))
        .for("update");

      const sender = lockedUsers.find((user) => user.id === senderUserId);
      const recipientUser = lockedUsers.find(
        (user) => user.id === recipient.id,
      );

      if (!sender || sender.isActor || sender.isAgent) {
        return {
          success: false,
          errorCode: "SENDER_NOT_ALLOWED",
          error: "Only Feed users can send trading balance",
        } satisfies TradingBalanceTransferFailure;
      }

      if (!recipientUser || recipientUser.isActor || recipientUser.isAgent) {
        return {
          success: false,
          errorCode: "RECIPIENT_NOT_ALLOWED",
          error: "Recipient must be a Feed user, not an actor or agent",
        } satisfies TradingBalanceTransferFailure;
      }

      const senderBalanceBefore = Number(sender.virtualBalance ?? 0);
      const recipientBalanceBefore = Number(recipientUser.virtualBalance ?? 0);

      if (senderBalanceBefore < amount) {
        return {
          success: false,
          errorCode: "INSUFFICIENT_BALANCE",
          error: "Insufficient trading balance",
        } satisfies TradingBalanceTransferFailure;
      }

      const senderBalanceAfter = senderBalanceBefore - amount;
      const recipientBalanceAfter = recipientBalanceBefore + amount;
      const transferId = await generateSnowflakeId();
      const senderLabel =
        sender.displayName || sender.username || `user ${sender.id}`;
      const recipientLabel =
        recipientUser.displayName ||
        recipientUser.username ||
        `user ${recipientUser.id}`;

      await tx
        .update(users)
        .set({
          virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) - ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, sender.id));

      await tx
        .update(users)
        .set({
          virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, recipientUser.id));

      await tx.insert(balanceTransactions).values([
        {
          id: await generateSnowflakeId(),
          userId: sender.id,
          type: PEER_TRANSFER_OUT_TRANSACTION_TYPE,
          amount: String(-amount),
          balanceBefore: String(senderBalanceBefore),
          balanceAfter: String(senderBalanceAfter),
          relatedId: transferId,
          description: buildTransferDescription({
            direction: "out",
            counterpartyLabel: recipientLabel,
            note,
          }),
        },
        {
          id: await generateSnowflakeId(),
          userId: recipientUser.id,
          type: PEER_TRANSFER_IN_TRANSACTION_TYPE,
          amount: String(amount),
          balanceBefore: String(recipientBalanceBefore),
          balanceAfter: String(recipientBalanceAfter),
          relatedId: transferId,
          description: buildTransferDescription({
            direction: "in",
            counterpartyLabel: senderLabel,
            note,
          }),
        },
      ]);

      return {
        success: true,
        transferId,
        amount,
        senderUserId: sender.id,
        senderHistoricalAuthId: sender.privyId,
        senderUsername: sender.username,
        recipientUserId: recipientUser.id,
        recipientHistoricalAuthId: recipientUser.privyId,
        recipientUsername: recipientUser.username,
        senderBalanceBefore,
        senderBalanceAfter,
        recipientBalanceBefore,
        recipientBalanceAfter,
      } satisfies TradingBalanceTransferSuccess;
    });

    if (result.success) {
      logger.info(
        "Trading balance peer transfer completed",
        {
          transferId: result.transferId,
          senderUserId: result.senderUserId,
          recipientUserId: result.recipientUserId,
          amount: result.amount,
        },
        "TradingBalanceTransferService",
      );

      await TradingBalanceTransferService.afterBalanceMutation([
        {
          id: result.senderUserId,
          privyId: result.senderHistoricalAuthId,
          username: result.senderUsername,
        },
        {
          id: result.recipientUserId,
          privyId: result.recipientHistoricalAuthId,
          username: result.recipientUsername,
        },
      ]);
    }

    return result;
  }
}
