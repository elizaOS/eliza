import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

const DISCORD_AVATAR_ROUTE_PREFIX = "/api/avatar/discord";
const MAX_DISCORD_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_DISCORD_AVATAR_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
]);
const inflightDiscordAvatarDownloads = new Map<
  string,
  Promise<string | undefined>
>();

function normalizeExtension(extension: string | null | undefined): string {
  const normalized = (extension ?? "").trim().toLowerCase().replace(/^\./, "");
  switch (normalized) {
    case "jpg":
    case "jpeg":
      return "jpg";
    case "png":
    case "webp":
    case "gif":
      return normalized;
    default:
      return "png";
  }
}

function extensionFromContentType(contentType: string | null): string {
  switch (contentType?.split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function sanitizeFileSegment(value: string | undefined): string {
  const normalized = (value ?? "discord")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "discord";
}

export function isDiscordAvatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_DISCORD_AVATAR_HOSTS.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function getDiscordAvatarCacheDir(): string {
  return path.join(resolveStateDir(), "cache", "discord-avatars");
}

export function getDiscordAvatarPublicPath(fileName: string): string {
  return `${DISCORD_AVATAR_ROUTE_PREFIX}/${encodeURIComponent(fileName)}`;
}

export function getDiscordAvatarCachePath(fileName: string): string {
  return path.join(getDiscordAvatarCacheDir(), fileName);
}

export function buildDiscordAvatarCacheFileName(
  url: string,
  userId?: string,
): string {
  const parsed = new URL(url);
  const pathnameExtension = path.extname(parsed.pathname);
  const extension = normalizeExtension(pathnameExtension);
  const baseId = sanitizeFileSegment(
    userId ??
      parsed.pathname.split("/").filter(Boolean).at(-2) ??
      parsed.pathname.split("/").filter(Boolean).at(-1),
  );
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 24);
  return `${baseId}-${hash}.${extension}`;
}

export async function cacheDiscordAvatarUrl(
  url: string | undefined,
  options: {
    fetchImpl?: typeof fetch;
    userId?: string;
  } = {},
): Promise<string | undefined> {
  if (!url || !isDiscordAvatarUrl(url)) {
    return url;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return url;
  }

  const requestedFileName = buildDiscordAvatarCacheFileName(
    url,
    options.userId,
  );
  const requestedFilePath = getDiscordAvatarCachePath(requestedFileName);
  try {
    const stat = await fs.stat(requestedFilePath);
    if (stat.isFile()) {
      return getDiscordAvatarPublicPath(requestedFileName);
    }
  } catch {}

  const existing = inflightDiscordAvatarDownloads.get(requestedFileName);
  if (existing) {
    return existing;
  }

  const downloadPromise = (async () => {
    await fs.mkdir(getDiscordAvatarCacheDir(), { recursive: true });

    const response = await fetchImpl(url, {
      headers: { Accept: "image/*" },
    });
    if (!response.ok) {
      return url;
    }

    const contentType = response.headers.get("content-type");
    if (!contentType?.toLowerCase().startsWith("image/")) {
      return url;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_DISCORD_AVATAR_BYTES) {
      return url;
    }

    const preferredExtension = extensionFromContentType(contentType);
    const finalFileName = requestedFileName.endsWith(`.${preferredExtension}`)
      ? requestedFileName
      : requestedFileName.replace(/\.[^.]+$/, `.${preferredExtension}`);
    const finalFilePath = getDiscordAvatarCachePath(finalFileName);

    try {
      const stat = await fs.stat(finalFilePath);
      if (stat.isFile()) {
        return getDiscordAvatarPublicPath(finalFileName);
      }
    } catch {}

    const tempFilePath = `${finalFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempFilePath, bytes, { mode: 0o600 });
    try {
      await fs.rename(tempFilePath, finalFilePath);
    } catch (error) {
      await fs.unlink(tempFilePath).catch(() => {});
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "";
      if (code !== "EEXIST") {
        throw error;
      }
    }

    return getDiscordAvatarPublicPath(finalFileName);
  })().finally(() => {
    inflightDiscordAvatarDownloads.delete(requestedFileName);
  });

  inflightDiscordAvatarDownloads.set(requestedFileName, downloadPromise);
  return downloadPromise;
}
