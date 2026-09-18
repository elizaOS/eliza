/** Resolve an explicit alias table without mutating the supplied environment. */
export function resolveEnvAlias(
  key: string,
  aliases: readonly (readonly [string, string])[] | undefined,
  env: Record<string, string | undefined> | null,
): string | undefined {
  if (!env) return undefined;
  if (env[key]?.trim()) return env[key];
  for (const [left, right] of aliases ?? []) {
    const partner = left === key ? right : right === key ? left : undefined;
    if (partner !== undefined && env[partner]?.trim()) return env[partner];
  }
  return undefined;
}
