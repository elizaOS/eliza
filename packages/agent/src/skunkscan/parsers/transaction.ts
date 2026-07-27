import { SolanaParsedTransaction } from "../helius";

export type ParsedNativeTransfer = {
  from: string | null;
  to: string | null;
  amountSol: number | null;
};

export type ParsedTokenTransfer = {
  from: string | null;
  to: string | null;
  mint: string | null;
  amount: number | null;
};

export type ParsedWalletTransaction = {
  signature: string | null;
  timestamp: number | null;
  nativeTransfers: ParsedNativeTransfer[];
  tokenTransfers: ParsedTokenTransfer[];
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

  const tokenTransfers = Array.isArray(transaction?.tokenTransfers)
    ? transaction.tokenTransfers.map((transfer) => ({
        from: transfer.fromUserAccount ?? null,
        to: transfer.toUserAccount ?? null,
        mint: transfer.mint ?? null,
        amount:
          typeof transfer.tokenAmount === "number"
            ? transfer.tokenAmount
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
    tokenTransfers,
  };
}
