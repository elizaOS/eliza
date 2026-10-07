/**
 * Base units from a parsed SPL token account.
 * `getParsedTokenAccountsByOwner` stores the integer balance at
 * `info.tokenAmount.amount`. `info.uiAmount` is not a field on that object.
 */

export function parsedTokenAccountBaseUnits(info: unknown): bigint | null {
  if (typeof info !== "object" || info === null) return null;
  const tokenAmount = (info as { tokenAmount?: unknown }).tokenAmount;
  if (typeof tokenAmount !== "object" || tokenAmount === null) return null;
  const amount = (tokenAmount as { amount?: unknown }).amount;
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return null;
  return BigInt(amount);
}

export function sumParsedTokenAccountBaseUnits(
  accounts: ReadonlyArray<{
    account?: { data?: { parsed?: { info?: unknown } } };
  }>
): bigint {
  let total = 0n;
  for (const account of accounts) {
    const units = parsedTokenAccountBaseUnits(account.account?.data?.parsed?.info);
    if (units !== null) total += units;
  }
  return total;
}

/**
 * Received base units are post minus pre. A failed read is null, not zero.
 * Zero would report a negative amount when the post-read fails, or the
 * whole post-withdrawal balance when the pre-read fails.
 */
export function withdrawalReceivedBaseUnits(
  post: bigint | null,
  pre: bigint | null
): string | null {
  if (post === null || pre === null) return null;
  return (post - pre).toString();
}
