/** Config/env filtering — strip sensitive keys from API responses. */

import { ElizaError } from "@elizaos/core";

/**
 * Env keys that must never be returned in GET /api/config responses.
 * Covers private keys, auth tokens, and database credentials.
 * Keys are stored and matched case-insensitively (uppercased).
 */
export const SENSITIVE_ENV_RESPONSE_KEYS = new Set([
  // Wallet private keys
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
  // Auth / step-up tokens
  "ELIZA_API_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
  // Cloud API keys
  "ELIZAOS_CLOUD_API_KEY",
  // Third-party auth tokens
  "GITHUB_TOKEN",
  // PR-shepherd fallback PAT (#16544): a live GitHub bearer credential the
  // sensitive-suffix regex below cannot catch (no *TOKEN/KEY suffix).
  "GH_PAT",
  // Database connection strings (may contain credentials)
  "DATABASE_URL",
  "POSTGRES_URL",
]);

const SENSITIVE_RESPONSE_KEY_RE =
  /password|secret|api.?key|private.?key|seed.?phrase|authorization|connection.?string|credential|(?<!max)tokens?$/i;

/** Honest GET /api/config payloads are a handful of objects deep. */
export const MAX_CONFIG_FILTER_DEPTH = 32;
/**
 * Node ceiling across the whole redaction walk, including sparse array holes.
 * Well above an ordinary character/config document; bounds synthetic graphs
 * that would otherwise RangeError or hang the authorized config route.
 */
export const MAX_CONFIG_FILTER_NODES = 100_000;
export const CONFIG_FILTER_UNBOUNDED = "CONFIG_FILTER_UNBOUNDED";

type FilterWalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failConfigFilterUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError(
    "Config response exceeds the sensitive-key filter walk budget",
    {
      code: CONFIG_FILTER_UNBOUNDED,
      context,
      cause,
      severity: "fatal",
    },
  );
}

function reserveFilterVisits(ctx: FilterWalkContext, count: number): void {
  if (count > MAX_CONFIG_FILTER_NODES - ctx.visits) {
    failConfigFilterUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_CONFIG_FILTER_NODES,
    });
  }
  ctx.visits += count;
}

function enterFilterContainer(value: object, ctx: FilterWalkContext): void {
  if (ctx.visiting.has(value)) {
    failConfigFilterUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
}

function inspectFilter<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
    failConfigFilterUnbounded({ inspection: operation }, cause);
  }
}

function ownEnumerableStringKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key of inspectFilter("ownKeys", () => Reflect.ownKeys(value))) {
    if (typeof key !== "string") continue;
    const descriptor = inspectFilter("getOwnPropertyDescriptor", () =>
      Object.getOwnPropertyDescriptor(value, key),
    );
    if (!descriptor?.enumerable) continue;
    keys.push(key);
  }
  return keys;
}

function ownValueDescriptor(
  value: object,
  key: string,
): PropertyDescriptor | undefined {
  const descriptor = inspectFilter("getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, key),
  );
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    failConfigFilterUnbounded({ accessor: true, key });
  }
  return descriptor;
}

function ownArrayLength(value: unknown[]): number {
  const descriptor = ownValueDescriptor(value, "length");
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    failConfigFilterUnbounded({ invalidArrayLength: true });
  }
  return descriptor.value;
}

function redactLeaf(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.trim() ? "[REDACTED]" : "";
  if (typeof value === "number" || typeof value === "boolean") {
    return "[REDACTED]";
  }
  return "[REDACTED]";
}

function walkConfigFilter(
  value: unknown,
  depth: number,
  ctx: FilterWalkContext,
  redactAll: boolean,
  visitAlreadyReserved = false,
): unknown {
  if (depth > MAX_CONFIG_FILTER_DEPTH) {
    failConfigFilterUnbounded({
      depth,
      max: MAX_CONFIG_FILTER_DEPTH,
    });
  }
  if (!visitAlreadyReserved) reserveFilterVisits(ctx, 1);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    return redactAll ? redactLeaf(value) : value;
  }

  enterFilterContainer(value, ctx);
  try {
    if (Array.isArray(value)) {
      const length = ownArrayLength(value);
      reserveFilterVisits(ctx, length);
      const next: unknown[] = [];
      next.length = length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownValueDescriptor(value, String(index));
        if (!descriptor) continue;
        next[index] = walkConfigFilter(
          descriptor.value,
          depth + 1,
          ctx,
          redactAll,
          true,
        );
      }
      return next;
    }

    const keys = ownEnumerableStringKeys(value);
    reserveFilterVisits(ctx, keys.length);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = ownValueDescriptor(value, key);
      if (!descriptor) continue;
      const childRedactAll = redactAll || SENSITIVE_RESPONSE_KEY_RE.test(key);
      out[key] = walkConfigFilter(
        descriptor.value,
        depth + 1,
        ctx,
        childRedactAll,
        true,
      );
    }
    return out;
  } finally {
    ctx.visiting.delete(value);
  }
}

function newFilterWalkContext(): FilterWalkContext {
  return { visits: 0, visiting: new WeakSet<object>() };
}

/**
 * Strip sensitive env vars from a config object before it is sent in a GET
 * /api/config response. Returns a shallow-cloned config with a filtered env
 * block — the original object is never mutated.
 *
 * Depth, node, and cycle limits are load-bearing: origin `develop` RangeError'd
 * a cyclic config graph and invoked enumerable getters during the walk, which
 * hangs the authorized config route. Descriptor-only reads so a getter cannot
 * pin GET /api/config.
 */
export function filterConfigEnvForResponse(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const redactedConfig = walkConfigFilter(
    config,
    0,
    newFilterWalkContext(),
    false,
  ) as Record<string, unknown>;
  const env = redactedConfig.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return redactedConfig;
  }

  const filteredEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (SENSITIVE_ENV_RESPONSE_KEYS.has(key.toUpperCase())) continue;
    filteredEnv[key] = value;
  }
  return { ...redactedConfig, env: filteredEnv };
}
