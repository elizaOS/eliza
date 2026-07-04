import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

// Lazy memoized loader: @elizaos/plugin-discord loads only on the first
// /api/avatar/discord/* request. A module-scope `await import` would load the
// whole plugin on every agent boot just for two pure path helpers.
type DiscordAvatarModule = {
  getDiscordAvatarCacheDir: () => string;
  getDiscordAvatarCachePath: (fileName: string) => string;
};

let discordAvatarPromise: Promise<DiscordAvatarModule> | null = null;
function getDiscordAvatarApi(): Promise<DiscordAvatarModule> {
  discordAvatarPromise ??= import(
    "@elizaos/plugin-discord"
  ) as Promise<unknown> as Promise<DiscordAvatarModule>;
  return discordAvatarPromise;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AvatarRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleAvatarRoutes(
  ctx: AvatarRouteContext,
): Promise<boolean> {
  const { res, method, pathname, error } = ctx;

  if (
    (method === "GET" || method === "HEAD") &&
    pathname.startsWith("/api/avatar/discord/")
  ) {
    const encodedFileName = pathname.slice("/api/avatar/discord/".length);
    const fileName = decodeURIComponent(encodedFileName);
    if (
      !fileName ||
      fileName !== path.basename(fileName) ||
      !/^[a-zA-Z0-9._-]+$/.test(fileName)
    ) {
      error(res, "Invalid Discord avatar path", 400);
      return true;
    }

    const discordAvatar = await getDiscordAvatarApi();
    const filePath = discordAvatar.getDiscordAvatarCachePath(fileName);
    const cacheDir = discordAvatar.getDiscordAvatarCacheDir();
    if (path.dirname(filePath) !== cacheDir || !filePath.startsWith(cacheDir)) {
      error(res, "Invalid Discord avatar path", 400);
      return true;
    }

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        error(res, "Discord avatar not found", 404);
        return true;
      }
      const extension = path.extname(filePath).slice(1).toLowerCase();
      const mimeType =
        extension === "jpg" || extension === "jpeg"
          ? "image/jpeg"
          : extension === "gif"
            ? "image/gif"
            : extension === "webp"
              ? "image/webp"
              : "image/png";
      const headers: Record<string, string | number> = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": stat.size,
        "Content-Type": mimeType,
      };
      if (method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return true;
      }
      const body = fs.readFileSync(filePath);
      res.writeHead(200, headers);
      res.end(body);
      return true;
    } catch {
      error(res, "Discord avatar not found", 404);
      return true;
    }
  }

  // The custom VRM (`/api/avatar/vrm`) and custom background
  // (`/api/avatar/background`) upload/serve routes were removed with the 3D
  // companion feature (#10434): nothing renders an uploaded model or scene
  // background anymore, so the routes only produced onboarding 404 noise from
  // the startup existence probes. Only the Discord avatar cache route above
  // remains. Bundled/content-pack avatars use `avatarIndex` (client-side).

  return false;
}
