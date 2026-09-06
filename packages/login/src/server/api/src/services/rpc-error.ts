const RPC_INDICATORS = [
  "insufficient funds",
  "insufficient balance",
  "nonce too low",
  "nonce too high",
  "gas too low",
  "gas limit",
  "underpriced",
  "replacement transaction",
  "exceeds block gas limit",
  "execution reverted",
  "out of gas",
  "invalid sender",
  "invalid signature",
  "account not found",
  "blockhash not found",
  "transaction simulation failed",
  "instruction error",
  "custom program error",
  "rpc error",
  "failed to send transaction",
  "transaction failed",
  "0x",
] as const;

export function isRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return RPC_INDICATORS.some((indicator) => message.includes(indicator));
}

/** Return only a stable public classification; provider text may contain credentials. */
export function extractRpcErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "RPC request failed";
  const message = error.message.toLowerCase();
  if (
    message.includes("insufficient funds") ||
    message.includes("insufficient balance")
  ) {
    return "Insufficient funds for transaction";
  }
  if (message.includes("nonce too low") || message.includes("nonce too high")) {
    return "Transaction nonce was rejected";
  }
  if (
    message.includes("gas") ||
    message.includes("underpriced") ||
    message.includes("replacement transaction")
  ) {
    return "Transaction fee parameters were rejected";
  }
  if (
    message.includes("execution reverted") ||
    message.includes("invalid sender") ||
    message.includes("invalid signature") ||
    message.includes("transaction simulation failed") ||
    message.includes("instruction error") ||
    message.includes("custom program error")
  ) {
    return "Transaction execution was rejected";
  }
  return "RPC request failed";
}
