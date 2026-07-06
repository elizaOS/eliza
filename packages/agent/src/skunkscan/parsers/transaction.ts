import { SolanaParsedTransaction } from "../helius";

export type ParsedNativeTransfer = {
  from: string | null;
  to: string | null;
  amountSol: number | null;
};

export type ParsedWalletTransaction = {
  signature: string | null;
  timestamp: number | null;
  nativeTransfers: ParsedNativeTransfer[];
};

export function parseSolanaTransaction(
  transaction: SolanaParsedTransaction | null | undefined,
): ParsedWalletTransaction {
  const nativeTransfers = Array.isArray(transaction?.nativeTransfers)
    ? transaction.nativeTransfers.map((transfer) => ({
        from: transfer.fromUserAccount ?? null,
        to: transfer.toUserAccount ?? null,
        amountSol:
          typeof transfer.amount === "number"
            ? transfer.amount / 1_000_000_000
            : null,
      }))
    : [];

  return {
    signature: transaction?.signature ?? null,
    timestamp:
      typeof transaction?.timestamp === "number"
        ? transaction.timestamp
        : null,
    nativeTransfers,
  };
}
