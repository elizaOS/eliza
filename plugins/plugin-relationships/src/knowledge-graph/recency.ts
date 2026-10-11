/** Recency rule shared by the entity and relationship stores. */

/**
 * The later of a stored instant and an incoming one. An equal instant takes
 * the incoming value, so a tie counts as the latest observation.
 */
export function laterIso(
  current: string | undefined,
  incoming: string,
): string {
  return current !== undefined && Date.parse(current) > Date.parse(incoming)
    ? current
    : incoming;
}
