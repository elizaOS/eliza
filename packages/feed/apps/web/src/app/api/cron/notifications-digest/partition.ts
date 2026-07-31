/**
 * Assigns digest candidates deterministically between production and staging
 * when both environments participate in cron fan-out.
 */

export function shouldProcessUser(
  userId: string,
  isFanOut: boolean,
  isProduction: boolean,
): boolean {
  if (!isFanOut) {
    return true;
  }

  const hash = userId
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const isEvenHash = hash % 2 === 0;
  return isProduction ? isEvenHash : !isEvenHash;
}
