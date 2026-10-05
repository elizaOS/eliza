/** Preserve transaction-hash keys; hash-less settlements need a payer-scoped nonce. */
export function x402TopupPaymentId(
  settlement: { transaction?: string | null },
  authorization: { from?: string; nonce?: string },
): string {
  if (settlement.transaction) return settlement.transaction;
  const { from, nonce } = authorization;
  if (!from || !/^0x[0-9a-fA-F]{40}$/.test(from) || !nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    throw new Error("Settled x402 payment has no usable payment identity");
  }
  // Authorization nonces are scoped to the sender, not globally unique.
  return `authorization:${from.toLowerCase()}:${nonce.toLowerCase()}`;
}
