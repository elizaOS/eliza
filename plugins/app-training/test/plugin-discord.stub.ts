import os from "node:os";
import path from "node:path";

export function getDiscordAvatarCacheDir(): string {
  return path.join(os.tmpdir(), "eliza-app-training-discord-avatar-cache");
}

export function getDiscordAvatarCachePath(fileName: string): string {
  return path.join(getDiscordAvatarCacheDir(), path.basename(fileName));
}

export async function cacheDiscordAvatarUrl(): Promise<string | null> {
  return null;
}

export async function cacheDiscordAvatarForRuntime(): Promise<string | null> {
  return null;
}

export function isCanonicalDiscordSource(source: unknown): boolean {
  return source === "discord";
}

export async function resolveDiscordMessageAuthorProfile(): Promise<null> {
  return null;
}

export async function resolveDiscordUserProfile(): Promise<null> {
  return null;
}

export function resolveStoredDiscordEntityProfile(): null {
  return null;
}
