/**
 * Discord target enumeration — shared by the workflow runtime-context provider
 * (which formats results as fact strings for the LLM prompt) and the
 * connector-target-catalog (which surfaces structured TargetGroup objects
 * for the clarification UI). Owning the REST + cache here means a single
 * 5-minute window covers both consumers; a dogfood "generate" that just
 * primed the runtime-context cache then asks the catalog for choices does
 * not double-fetch Discord.
 *
 * Network failures degrade silently — callers receive an empty array or a
 * `channelsError` marker on partial success, never a thrown rejection.
 */

export interface DiscordEnumerationResult {
  guildId: string;
  guildName: string;
  /** Text channels for this guild. Absent when channel enumeration failed. */
  channels?: Array<{ id: string; name: string }>;
  /** Present when channel enumeration failed for this specific guild. */
  channelsError?: { status?: number; message?: string };
}

export type DiscordSourceCache = Map<
  string,
  { expiresAt: number; result: DiscordEnumerationResult[] }
>;

export interface DiscordSourceLogger {
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface DiscordSourceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  cache?: DiscordSourceCache;
  logger?: DiscordSourceLogger;
}

export const DISCORD_FACT_CACHE_TTL_MS = 5 * 60 * 1000;

export function createDiscordSourceCache(): DiscordSourceCache {
  return new Map();
}

const DISCORD_TEXT_CHANNEL_TYPE = 0;

/**
 * Enumerate the Discord bot's guilds and text channels. Cached per-token
 * for `DISCORD_FACT_CACHE_TTL_MS`. The cache is provided by the caller so
 * the runtime-context-provider and the catalog can share a single window.
 */
export async function fetchDiscordEnumeration(
  botToken: string,
  options: DiscordSourceOptions = {},
): Promise<DiscordEnumerationResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = options.cache;
  const logger = options.logger;

  if (cache) {
    const cached = cache.get(botToken);
    if (cached && cached.expiresAt > now()) {
      return cached.result;
    }
  }

  const writeCache = (result: DiscordEnumerationResult[]) => {
    if (cache) {
      cache.set(botToken, {
        expiresAt: now() + DISCORD_FACT_CACHE_TTL_MS,
        result,
      });
    }
    return result;
  };

  let guilds: Array<{ id: string; name: string }>;
  try {
    const headers = { Authorization: `Bot ${botToken}` };
    const guildsRes = await fetchImpl(
      "https://discord.com/api/v10/users/@me/guilds",
      { headers },
    );
    if (!guildsRes.ok) {
      logger?.warn?.(
        { src: "discord-target-source", status: guildsRes.status },
        "Discord guilds REST returned non-ok",
      );
      return writeCache([]);
    }
    guilds = (await guildsRes.json()) as Array<{ id: string; name: string }>;
  } catch (err) {
    logger?.warn?.(
      {
        src: "discord-target-source",
        err: err instanceof Error ? err.message : String(err),
      },
      "Discord guilds REST threw",
    );
    return [];
  }

  const headers = { Authorization: `Bot ${botToken}` };
  const out: DiscordEnumerationResult[] = [];
  for (const guild of guilds) {
    try {
      const channelsRes = await fetchImpl(
        `https://discord.com/api/v10/guilds/${guild.id}/channels`,
        { headers },
      );
      if (!channelsRes.ok) {
        out.push({
          guildId: guild.id,
          guildName: guild.name,
          channelsError: { status: channelsRes.status },
        });
        continue;
      }
      const channels = (await channelsRes.json()) as Array<{
        id: string;
        name: string;
        type: number;
      }>;
      out.push({
        guildId: guild.id,
        guildName: guild.name,
        channels: channels
          .filter((c) => c.type === DISCORD_TEXT_CHANNEL_TYPE)
          .map((c) => ({ id: c.id, name: c.name })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn?.(
        { src: "discord-target-source", guildId: guild.id, err: message },
        "Discord channels REST threw",
      );
      out.push({
        guildId: guild.id,
        guildName: guild.name,
        channelsError: { message },
      });
    }
  }

  return writeCache(out);
}

/**
 * Format an enumeration result as the human-readable fact strings the workflow
 * runtime-context provider injects into the LLM prompt.
 */
export function formatDiscordEnumerationAsFacts(
  results: ReadonlyArray<DiscordEnumerationResult>,
): string[] {
  const facts: string[] = [];
  for (const guild of results) {
    if (guild.channels) {
      const text = guild.channels.map((c) => `#${c.name} (${c.id})`).join(", ");
      facts.push(
        text.length > 0
          ? `Discord guild "${guild.guildName}" (id ${guild.guildId}) channels: ${text}.`
          : `Discord guild "${guild.guildName}" (id ${guild.guildId}) — no text channels visible to the bot.`,
      );
      continue;
    }
    if (guild.channelsError) {
      const detail =
        typeof guild.channelsError.status === "number"
          ? `status ${guild.channelsError.status}`
          : (guild.channelsError.message ?? "unknown error");
      facts.push(
        `Discord guild "${guild.guildName}" (id ${guild.guildId}) — channels not enumerable (${detail}).`,
      );
    }
  }
  return facts;
}
