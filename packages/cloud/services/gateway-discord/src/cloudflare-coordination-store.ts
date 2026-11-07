import {
  DISCORD_LEASE_DELETE,
  DISCORD_LEASE_EXPIRE,
  DiscordCoordinationError,
} from "@elizaos/cloud-services-common/discord-coordination";
import type { GatewayRedis } from "./gateway-manager";

/** Select the Discord-owned state store; shared agent routing has a separate authority. */
export function discordCoordinationStore(
  env: Record<string, string | undefined> = process.env,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): GatewayRedis | null {
  const backend = env.CLOUD_DISCORD_COORDINATION_BACKEND ?? "redis";
  if (backend === "redis") return null;
  if (backend !== "cloudflare")
    throw new DiscordCoordinationError(
      "Invalid CLOUD_DISCORD_COORDINATION_BACKEND",
    );
  if (
    env.CLOUD_DISCORD_WELCOME_BACKEND !== "cloudflare" ||
    env.CLOUD_GATEWAY_RECEIPTS_BACKEND !== "cloudflare"
  )
    throw new DiscordCoordinationError(
      "Native Discord coordination requires native welcome and receipt stores",
    );
  let url: URL;
  try {
    url = new URL(env.DISCORD_COORDINATION_URL ?? "");
  } catch {
    throw new DiscordCoordinationError("DISCORD_COORDINATION_URL is required");
  }
  const token = env.DISCORD_COORDINATION_TOKEN;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/internal/discord-coordination" ||
    !token?.trim()
  )
    throw new DiscordCoordinationError(
      "Invalid Discord coordination authority",
    );
  async function call(operation: string, fields: object): Promise<unknown> {
    const response = await fetcher(url, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, ...fields }),
    });
    if (!response.ok)
      throw new DiscordCoordinationError(
        `Discord coordination failed (${response.status})`,
      );
    return response.json();
  }
  async function count(operation: string, fields: object): Promise<number> {
    const result = await call(operation, fields);
    if (
      typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 0
    )
      throw new DiscordCoordinationError(
        "Invalid coordination acknowledgement",
      );
    return result;
  }
  const unsupported = async (): Promise<never> => {
    throw new DiscordCoordinationError(
      "Discord lists require the selected welcome store",
    );
  };
  const store: GatewayRedis = {
    async get<T = string>(key: string): Promise<T | null> {
      const value = await call("get", { key });
      if (value === null) return null;
      if (typeof value !== "string")
        throw new DiscordCoordinationError("Invalid coordination value");
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    },
    async set(key, value, options = {}) {
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof encoded !== "string")
        throw new DiscordCoordinationError("Invalid coordination value");
      const result = await call("set", { key, value: encoded, ...options });
      if (result !== null && result !== "OK")
        throw new DiscordCoordinationError(
          "Invalid coordination write acknowledgement",
        );
      return result;
    },
    async setex(key, ttlSeconds, value) {
      const result = await store.set(key, value, { ex: ttlSeconds });
      if (result !== "OK")
        throw new DiscordCoordinationError(
          "Coordination write was not acknowledged",
        );
      return result;
    },
    del: (...keys) => count("delete", { keys }),
    expire: (key, seconds) => count("expire", { key, seconds }),
    sadd: (key, ...members) => count("addMembers", { key, members }),
    srem: (key, ...members) => count("removeMembers", { key, members }),
    async smembers(key) {
      const result = await call("members", { key });
      if (
        !Array.isArray(result) ||
        result.some((member) => typeof member !== "string")
      )
        throw new DiscordCoordinationError("Invalid coordination members");
      return result as string[];
    },
    async eval(script, keys, args) {
      if (keys.length !== 1 || typeof args[0] !== "string")
        throw new DiscordCoordinationError(
          "Invalid coordination lease operation",
        );
      if (script === DISCORD_LEASE_DELETE && args.length === 1)
        return count("compareDelete", { key: keys[0], expected: args[0] });
      if (script === DISCORD_LEASE_EXPIRE && args.length === 2)
        return count("compareExpire", {
          key: keys[0],
          expected: args[0],
          seconds: args[1],
        });
      throw new DiscordCoordinationError("Unsupported coordination script");
    },
    lpush: unsupported,
    lmove: unsupported,
    lrem: unsupported,
    ltrim: unsupported,
  };
  return store;
}
