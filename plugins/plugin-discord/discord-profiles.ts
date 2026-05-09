import type { AgentRuntime, Room, UUID } from "@elizaos/core";
import { normalizeConnectorSource } from "@elizaos/shared";
import { cacheDiscordAvatarUrl } from "./discord-avatar-cache";

type DiscordUserProfile = {
  avatarUrl?: string;
  displayName?: string;
  username?: string;
};

type DiscordMessageAuthorProfile = DiscordUserProfile & {
  rawUserId?: string;
};

type StoredDiscordEntityProfile = {
  avatarUrl?: string;
  displayName?: string;
  rawUserId?: string;
  username?: string;
};

const DISCORD_PROFILE_CACHE_TTL_MS = 5 * 60_000;

const discordUserProfileCache = new Map<
  string,
  { expiresAt: number; value: DiscordUserProfile | null }
>();

const discordMessageAuthorProfileCache = new Map<
  string,
  { expiresAt: number; value: DiscordMessageAuthorProfile | null }
>();

type DiscordClientLike = {
  channels?: {
    cache?: { get?: (id: string) => unknown };
    fetch?: (id: string) => Promise<unknown>;
  };
  users?: {
    fetch?: (id: string) => Promise<unknown>;
  };
};

function readCachedValue<T>(
  cache: Map<string, { expiresAt: number; value: T }>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function getDiscordClient(runtime: AgentRuntime): DiscordClientLike | null {
  const runtimeWithServices = runtime as AgentRuntime & {
    getService?: (name: string) => unknown;
  };
  const service = runtimeWithServices.getService?.("discord") as
    | { client?: DiscordClientLike | null }
    | undefined;
  return service?.client ?? null;
}

function firstCollectionValue(collection: unknown): unknown {
  if (!collection || typeof collection !== "object") {
    return null;
  }
  const record = collection as {
    first?: () => unknown;
    values?: () => IterableIterator<unknown>;
  };
  if (typeof record.first === "function") {
    return record.first();
  }
  if (typeof record.values === "function") {
    return record.values().next().value ?? null;
  }
  return null;
}

function readDiscordDisplayName(user: unknown): string | undefined {
  if (!user || typeof user !== "object") return undefined;
  const record = user as Record<string, unknown>;
  const globalName = record.globalName;
  if (typeof globalName === "string" && globalName.trim()) {
    return globalName.trim();
  }
  const displayName = record.displayName;
  if (typeof displayName === "string" && displayName.trim()) {
    return displayName.trim();
  }
  const username = record.username;
  if (typeof username === "string" && username.trim()) {
    return username.trim();
  }
  return undefined;
}

function readDiscordAvatarUrl(user: unknown): string | undefined {
  if (!user || typeof user !== "object") return undefined;
  const record = user as {
    displayAvatarURL?: () => string;
    avatarURL?: () => string | null;
  };
  if (typeof record.displayAvatarURL === "function") {
    const url = record.displayAvatarURL();
    if (typeof url === "string" && url.trim()) return url;
  }
  if (typeof record.avatarURL === "function") {
    const url = record.avatarURL();
    if (typeof url === "string" && url.trim()) return url;
  }
  return undefined;
}

function readLooseStringValue(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function readStoredDiscordEntityProfile(
  entity: unknown,
): StoredDiscordEntityProfile | null {
  if (!entity || typeof entity !== "object") {
    return null;
  }

  const metadata = (entity as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const discord =
    record.discord && typeof record.discord === "object"
      ? (record.discord as Record<string, unknown>)
      : null;
  const fallback =
    record.default && typeof record.default === "object"
      ? (record.default as Record<string, unknown>)
      : null;

  const displayName =
    readLooseStringValue(record, ["displayName", "name"]) ??
    readLooseStringValue(discord ?? undefined, [
      "displayName",
      "globalName",
      "name",
    ]) ??
    readLooseStringValue(fallback ?? undefined, ["name"]);
  const username =
    readLooseStringValue(record, ["username"]) ??
    readLooseStringValue(discord ?? undefined, ["username", "userName"]) ??
    readLooseStringValue(fallback ?? undefined, ["username"]);
  const avatarUrl =
    readLooseStringValue(record, ["avatarUrl"]) ??
    readLooseStringValue(discord ?? undefined, ["avatarUrl"]) ??
    readLooseStringValue(fallback ?? undefined, ["avatarUrl"]);
  const rawUserId =
    readLooseStringValue(discord ?? undefined, ["userId", "id"]) ??
    readLooseStringValue(record, ["originalId"]);

  if (!displayName && !username && !avatarUrl && !rawUserId) {
    return null;
  }

  return {
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(displayName ? { displayName } : {}),
    ...(rawUserId ? { rawUserId } : {}),
    ...(username ? { username } : {}),
  };
}

export function isCanonicalDiscordSource(
  source: string | null | undefined,
): boolean {
  return normalizeConnectorSource(source) === "discord";
}

export async function cacheDiscordAvatarForRuntime(
  runtime: AgentRuntime,
  avatarUrl: string | undefined,
  userId?: string,
): Promise<string | undefined> {
  return cacheDiscordAvatarUrl(avatarUrl, {
    fetchImpl: runtime.fetch ?? globalThis.fetch,
    userId,
  });
}

export async function resolveStoredDiscordEntityProfile(
  runtime: AgentRuntime,
  entityId: string | undefined,
): Promise<StoredDiscordEntityProfile | null> {
  if (!entityId) return null;

  const runtimeWithEntityLookup = runtime as AgentRuntime & {
    getEntityById?: (id: UUID) => Promise<unknown>;
  };
  if (typeof runtimeWithEntityLookup.getEntityById !== "function") {
    return null;
  }

  try {
    const entity = await runtimeWithEntityLookup.getEntityById(
      entityId as UUID,
    );
    return readStoredDiscordEntityProfile(entity);
  } catch {
    return null;
  }
}

export async function resolveDiscordMessageAuthorProfile(
  runtime: AgentRuntime,
  channelId: string,
  messageId: string,
): Promise<DiscordMessageAuthorProfile | null> {
  const cacheKey = `${channelId}:${messageId}`;
  const cached = readCachedValue(discordMessageAuthorProfileCache, cacheKey);
  if (cached !== undefined) return cached;

  const client = getDiscordClient(runtime);
  const cachedChannel = client?.channels?.cache?.get?.(channelId);
  const fetchChannel = client?.channels?.fetch;
  const channel =
    cachedChannel ??
    (typeof fetchChannel === "function"
      ? await fetchChannel(channelId).catch(() => null)
      : null);

  const fetchMessage =
    channel &&
    typeof channel === "object" &&
    typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch ===
      "function"
      ? (channel as { messages: { fetch: (id: string) => Promise<unknown> } })
          .messages.fetch
      : null;
  if (!fetchMessage) {
    discordMessageAuthorProfileCache.set(cacheKey, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }

  try {
    const message = await fetchMessage(messageId);
    const author =
      message && typeof message === "object"
        ? ((message as { author?: unknown }).author ?? null)
        : null;
    const member =
      message && typeof message === "object"
        ? ((message as { member?: unknown }).member ?? null)
        : null;
    const rawUserId =
      author &&
      typeof author === "object" &&
      typeof (author as { id?: unknown }).id === "string"
        ? (author as { id: string }).id
        : undefined;
    const profile: DiscordMessageAuthorProfile = {
      displayName: readDiscordDisplayName(member ?? author),
      username:
        author &&
        typeof author === "object" &&
        typeof (author as { username?: unknown }).username === "string"
          ? (author as { username: string }).username
          : undefined,
      avatarUrl: readDiscordAvatarUrl(author),
      ...(rawUserId ? { rawUserId } : {}),
    };
    discordMessageAuthorProfileCache.set(cacheKey, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: profile,
    });
    return profile;
  } catch {
    discordMessageAuthorProfileCache.set(cacheKey, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }
}

export async function resolveDiscordUserProfile(
  runtime: AgentRuntime,
  userId: string,
): Promise<DiscordUserProfile | null> {
  const cached = readCachedValue(discordUserProfileCache, userId);
  if (cached !== undefined) return cached;

  const client = getDiscordClient(runtime);
  const fetchUser = client?.users?.fetch;
  if (typeof fetchUser !== "function") return null;

  try {
    const user = await fetchUser(userId);
    const profile: DiscordUserProfile = {
      displayName: readDiscordDisplayName(user),
      username:
        user &&
        typeof user === "object" &&
        typeof (user as { username?: unknown }).username === "string"
          ? (user as { username: string }).username
          : undefined,
      avatarUrl: readDiscordAvatarUrl(user),
    };
    discordUserProfileCache.set(userId, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: profile,
    });
    return profile;
  } catch {
    discordUserProfileCache.set(userId, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }
}

export async function resolveDiscordRoomProfile(
  runtime: AgentRuntime,
  room: Room | undefined,
  channelIdHint?: string,
): Promise<{ avatarUrl?: string; title: string | null } | null> {
  const channelId =
    typeof channelIdHint === "string" && channelIdHint.trim()
      ? channelIdHint.trim()
      : (() => {
          const raw = room?.channelId;
          return typeof raw === "string" && raw.trim() ? raw.trim() : "";
        })();
  if (!channelId) return null;

  const client = getDiscordClient(runtime);
  const cachedChannel = client?.channels?.cache?.get?.(channelId);
  const fetchChannel = client?.channels?.fetch;
  const channel =
    cachedChannel ??
    (typeof fetchChannel === "function"
      ? await fetchChannel(channelId).catch(() => null)
      : null);

  let title: string | null = null;
  let avatarUrl: string | undefined;
  if (channel && typeof channel === "object") {
    const namedChannel = channel as { name?: unknown };
    if (typeof namedChannel.name === "string" && namedChannel.name.trim()) {
      title = namedChannel.name.trim();
    } else {
      const record = channel as {
        recipient?: unknown;
        recipients?: unknown;
      };
      const recipient =
        record.recipient ?? firstCollectionValue(record.recipients);
      title = readDiscordDisplayName(recipient) ?? null;
      avatarUrl = readDiscordAvatarUrl(recipient);
    }
  }

  return {
    title,
    ...(typeof avatarUrl === "string" && avatarUrl.length > 0
      ? { avatarUrl }
      : {}),
  };
}
