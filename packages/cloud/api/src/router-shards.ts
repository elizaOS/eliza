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

import { tryDecodeURI } from "hono/utils/url";

export function routeShardKey(path: string): string | null {
  // This mirrors Hono's `getPath`: preserve an encoded percent, while decoding
  // every independently valid percent run even if another run is malformed.
  // A single `decodeURI` try/catch is not equivalent for mixed input such as
  // `%61uth/%zz`, which Hono routes through the literal `auth` mount.
  const routingPath = tryDecodeURI(
    path.includes("%25") ? path.replaceAll("%25", "%2525") : path,
  );
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

/** Collapse request-derived shard names to the finite generated inventory. */
export function knownRouteShardKey(
  path: string,
  knownShards: ReadonlySet<string>,
): string | null {
  const shard = routeShardKey(path);
  return shard !== null && knownShards.has(shard) ? shard : null;
}
