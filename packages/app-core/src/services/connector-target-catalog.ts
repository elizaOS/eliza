/**
 * Connector target catalog — surfaces the user's enabled connectors as
 * structured `TargetGroup`s so the workflow clarification UI can render
 * quick-pick servers, channels, recipients, and chats without making the
 * end-user paste raw IDs.
 *
 * Discord is the only wired source in slice 2. Slack, Telegram, and Gmail
 * are placeholders so the host can stack them onto this framework without
 * a route or UI rewrite.
 *
 * The Discord enumeration shares its 5-minute REST cache with the workflow
 * runtime-context provider when the host wires both with the same
 * `discordCache` instance — a "generate" call that already primed the
 * runtime-context cache pays no extra REST cost when the user picks.
 */

import {
  createDiscordSourceCache,
  type DiscordSourceCache,
  type DiscordSourceLogger,
  fetchDiscordEnumeration,
} from "./discord-target-source";

export interface TargetGroup {
  /** Connector platform: 'discord', 'slack', 'telegram', 'gmail', etc. */
  platform: string;
  /** Server / workspace / chat-collection id (e.g. Discord guild id). */
  groupId: string;
  /** Human-readable group name (e.g. "Cozy Devs"). */
  groupName: string;
  targets: TargetEntry[];
}

export interface TargetEntry {
  id: string;
  name: string;
  kind: "channel" | "recipient" | "chat";
}

export interface ListGroupsOptions {
  /** Restrict to a single platform (e.g. only Discord). */
  platform?: string;
  /** Restrict to a single group within the platform (e.g. one guild). */
  groupId?: string;
}

export interface ConnectorTargetCatalog {
  listGroups(opts?: ListGroupsOptions): Promise<TargetGroup[]>;
}

/**
 * Subset of the host config the catalog reads. Mirrors the runtime-context
 * provider's `ConnectorConfigLike` so a host can pass the same accessor
 * to both.
 */
export interface ConnectorConfigLike {
  connectors?: {
    discord?: { enabled?: boolean; token?: string };
    telegram?: { enabled?: boolean; botToken?: string };
    gmail?: { enabled?: boolean; email?: string };
    slack?: { enabled?: boolean; accessToken?: string };
  };
}

export interface ElizaConnectorTargetCatalogOptions {
  /** Re-read on every call so connector edits do not require a restart. */
  getConfig: () => ConnectorConfigLike;
  /** Test injection seam — defaults to fetch. */
  fetchImpl?: typeof fetch;
  /** Test injection seam — defaults to Date.now. */
  now?: () => number;
  /** Optional shared Discord cache (see runtime-context-provider). */
  discordCache?: DiscordSourceCache;
  /** Optional logger; warnings only. */
  logger?: DiscordSourceLogger;
}

export function createElizaConnectorTargetCatalog(
  options: ElizaConnectorTargetCatalogOptions,
): ConnectorTargetCatalog {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const discordCache = options.discordCache ?? createDiscordSourceCache();
  const logger = options.logger;

  const listDiscordGroups = async (
    groupId: string | undefined,
  ): Promise<TargetGroup[]> => {
    const config = options.getConfig();
    const token = config.connectors?.discord?.token?.trim();
    if (!token) return [];

    const enumeration = await fetchDiscordEnumeration(token, {
      fetchImpl,
      now,
      cache: discordCache,
      logger,
    });

    const groups: TargetGroup[] = [];
    for (const guild of enumeration) {
      if (groupId && guild.guildId !== groupId) continue;
      groups.push({
        platform: "discord",
        groupId: guild.guildId,
        groupName: guild.guildName,
        targets: (guild.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          kind: "channel",
        })),
      });
    }
    return groups;
  };

  return {
    async listGroups(opts: ListGroupsOptions = {}): Promise<TargetGroup[]> {
      const platform = opts.platform;
      const all: TargetGroup[] = [];

      if (!platform || platform === "discord") {
        for (const g of await listDiscordGroups(opts.groupId)) all.push(g);
      }

      // slack / telegram / gmail land in slice 2.1+. Returning an empty list
      // for those platforms today is the desired behavior — the route falls
      // back to a free-text input when no catalog entries are available.

      return all;
    },
  };
}
