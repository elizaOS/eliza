import {
  DISCORD_WELCOME_PENDING,
  DISCORD_WELCOME_PROCESSING,
  DISCORD_WELCOME_REQUEUE,
  DISCORD_WELCOME_REQUEUE_HEADER,
  DiscordWelcomeStateError,
} from "@elizaos/cloud-services-common/discord-welcome-state";
import type { DiscordInstallWelcomeRedis } from "./discord-install-welcome-queue";

/** Preserve the queue's existing list/receipt contract and capture one authority. */
export function discordWelcomeStore(
  redis: DiscordInstallWelcomeRedis,
  env: Record<string, string | undefined> = process.env,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): DiscordInstallWelcomeRedis {
  const backend = env.CLOUD_DISCORD_WELCOME_BACKEND ?? "redis";
  if (backend === "redis") return redis;
  if (backend !== "cloudflare")
    throw new DiscordWelcomeStateError("Invalid CLOUD_DISCORD_WELCOME_BACKEND");
  let url: URL;
  try {
    url = new URL(env.DISCORD_WELCOME_URL ?? "");
  } catch {
    throw new DiscordWelcomeStateError("DISCORD_WELCOME_URL is required");
  }
  const token = env.DISCORD_WELCOME_TOKEN;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/internal/discord-welcome" ||
    !token?.trim()
  )
    throw new DiscordWelcomeStateError("Invalid Discord welcome authority");
  async function call(operation: string, fields: object): Promise<unknown> {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, ...fields }),
    });
    if (!response.ok)
      throw new DiscordWelcomeStateError(
        `Discord welcome state failed (${response.status})`,
      );
    if (
      operation === "get" &&
      response.headers.get(DISCORD_WELCOME_REQUEUE_HEADER) !== "1"
    ) {
      await response.body?.cancel();
      throw new DiscordWelcomeStateError(
        "Discord welcome state lacks atomic retry support",
      );
    }
    return response.json();
  }
  async function count(operation: string, fields: object): Promise<number> {
    const result = await call(operation, fields);
    if (
      typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 0
    )
      throw new DiscordWelcomeStateError(
        "Invalid welcome queue acknowledgement",
      );
    return result;
  }
  return {
    async eval(script, keys, args) {
      if (
        script !== DISCORD_WELCOME_REQUEUE ||
        keys.length !== 2 ||
        keys[0] !== DISCORD_WELCOME_PROCESSING ||
        keys[1] !== DISCORD_WELCOME_PENDING ||
        args.length !== 2
      )
        throw new DiscordWelcomeStateError("Unsupported welcome queue script");
      return count("requeue", { claim: args[0], value: args[1] });
    },
    async get<T = string>(key: string): Promise<T | null> {
      const value = await call("get", { key });
      if (value !== null && typeof value !== "string")
        throw new DiscordWelcomeStateError("Invalid welcome receipt");
      return value as T | null;
    },
    async set(key, value, options = {}) {
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof encoded !== "string")
        throw new DiscordWelcomeStateError("Invalid welcome receipt value");
      const result = await call("set", { key, value: encoded, ...options });
      if (result !== null && result !== "OK")
        throw new DiscordWelcomeStateError(
          "Invalid welcome receipt acknowledgement",
        );
      return result;
    },
    lpush: (key, ...values) => count("push", { key, values }),
    async lmove(source, destination, whereFrom, whereTo) {
      const value = await call("move", {
        source,
        destination,
        whereFrom,
        whereTo,
      });
      if (value !== null && typeof value !== "string")
        throw new DiscordWelcomeStateError("Invalid welcome queue claim");
      return value;
    },
    lrem: (key, countValue, value) =>
      count("remove", { key, count: countValue, value }),
  };
}
