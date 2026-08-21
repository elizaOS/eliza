/**
 * Defines the canonical transaction-hash identity shared by every crypto-payment writer.
 * EVM-style hexadecimal hashes are case-insensitive; case-sensitive chain identifiers remain unchanged.
 */

const HEX_TRANSACTION_HASH = /^0x[0-9a-f]+$/i;

export function isHexTransactionHash(transactionHash: string): boolean {
  return HEX_TRANSACTION_HASH.test(transactionHash.trim());
}

export function canonicalizeCryptoTransactionHash(
  transactionHash: string,
  network?: string | null,
): string {
  const trimmed = transactionHash.trim();
  if (!trimmed) throw new Error("Transaction hash must not be empty");
  if (network?.toLowerCase() === "solana") return trimmed;
  return isHexTransactionHash(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function cryptoTransactionHashesEqual(
  left: string | null | undefined,
  right: string,
  network?: string | null,
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    canonicalizeCryptoTransactionHash(left, network) ===
      canonicalizeCryptoTransactionHash(right, network)
  );
}
