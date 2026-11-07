/** The least of `amount` to accept after `slippageBps` (basis points) of slippage. */
export function minAmountAfterSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}
