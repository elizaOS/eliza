/**
 * Shard-key resolution for the lazily loaded generated route graph. A shard is
 * the set of generated mounts that share the first literal path segment after
 * `/api` (or after `/api/v1` for the v1 tree), so a request only evaluates the
 * route modules that could match its path instead of all of them (issue
 * #22550). The same function classifies both mount patterns (where a `:param`
 * or splat at the shard position yields `null` = "mount into every shard") and
 * concrete request pathnames (where `null` means only shared mounts apply).
 *
 * This is the runtime twin of `routeShardKey` in `src/_generate-router.mjs`
 * (codegen runs under plain node and cannot import TypeScript); the pair is
 * kept in lockstep by `src/router-shards.test.ts`. Correctness invariant: a
 * request that a mount pattern can match always resolves to the same shard key
 * as the pattern itself, because both share the literal segments the key is
 * derived from.
 */

export function routeShardKey(path: string): string | null {
  let routingPath = path;
  try {
    // Hono decodes URI-safe escapes before matching literal routes. The shard
    // selector must use the same view or `/api/%66oo` would match `/api/foo`
    // in a full router while loading a non-existent `%66oo` shard here.
    // `decodeURI` deliberately preserves encoded slashes, matching Hono.
    routingPath = decodeURI(path);
  } catch {
    // Malformed escapes are not valid literal aliases. Keep the raw path so
    // they select no unrelated shard and reach the ordinary 404 boundary.
  }
  const segments = routingPath.split("/").filter(Boolean);
  if (segments[0] !== "api") return null;
  const first = segments[1];
  if (!first || first.startsWith(":") || first.includes("*")) return null;
  if (first === "v1") {
    const second = segments[2];
    if (!second || second.startsWith(":") || second.includes("*")) return null;
    return `v1/${second}`;
  }
  return first;
}
