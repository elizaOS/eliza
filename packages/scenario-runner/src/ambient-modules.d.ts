declare module "@elizaos/plugin-discord" {
  import type { Plugin } from "@elizaos/core";

  export interface DiscordProfileLike {
    displayName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    rawUserId?: string | null;
  }

  export function cacheDiscordAvatarUrl(...args: unknown[]): Promise<string>;
  export function getDiscordAvatarCacheDir(): string;
  export function getDiscordAvatarCachePath(fileName: string): string;
  export function cacheDiscordAvatarForRuntime(
    ...args: unknown[]
  ): Promise<string | undefined>;
  export function isCanonicalDiscordSource(source: unknown): boolean;
  export function resolveDiscordMessageAuthorProfile(
    ...args: unknown[]
  ): Promise<DiscordProfileLike | null>;
  export function resolveDiscordUserProfile(
    ...args: unknown[]
  ): Promise<DiscordProfileLike | null>;
  export function resolveStoredDiscordEntityProfile(
    ...args: unknown[]
  ): Promise<DiscordProfileLike | null>;

  const discordPlugin: Plugin;
  export default discordPlugin;
}
