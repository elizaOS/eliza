import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import {
  getDiscordAvatarCacheDir,
  getDiscordAvatarCachePath,
} from "@elizaos/plugin-discord";
import { resolveStateDir } from "../config/paths.js";
import { readRequestBodyBuffer } from "./http-helpers.js";

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
  const { req, res, method, pathname, json, error } = ctx;

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

    const filePath = getDiscordAvatarCachePath(fileName);
    if (
      path.dirname(filePath) !== getDiscordAvatarCacheDir() ||
      !filePath.startsWith(getDiscordAvatarCacheDir())
    ) {
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

  // ── POST /api/avatar/vrm ─────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/avatar/vrm") {
    const MAX_VRM_BYTES = 50 * 1024 * 1024; // 50 MB
    const rawBody = await readRequestBodyBuffer(req, {
      maxBytes: MAX_VRM_BYTES,
      returnNullOnTooLarge: true,
    });
    if (!rawBody || rawBody.length === 0) {
      error(res, "Request body is empty or exceeds 50 MB", 400);
      return true;
    }
    const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]); // "glTF"
    if (rawBody.length < 4 || !rawBody.subarray(0, 4).equals(GLB_MAGIC)) {
      error(res, "Invalid VRM file: not a valid glTF/GLB file", 400);
      return true;
    }
    const avatarDir = path.join(resolveStateDir(), "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    const vrmPath = path.join(avatarDir, "custom.vrm");
    fs.writeFileSync(vrmPath, rawBody);
    json(res, { ok: true, size: rawBody.length });
    return true;
  }

  // ── GET /api/avatar/vrm ──────────────────────────────────────────────
  if (
    (method === "GET" || method === "HEAD") &&
    pathname === "/api/avatar/vrm"
  ) {
    const vrmPath = path.join(resolveStateDir(), "avatars", "custom.vrm");
    try {
      const stat = fs.statSync(vrmPath);
      if (!stat.isFile()) {
        error(res, "No custom avatar found", 404);
        return true;
      }
      const headers: Record<string, string | number> = {
        "Content-Type": "model/gltf-binary",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
      };
      if (method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return true;
      }
      const body = fs.readFileSync(vrmPath);
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      error(res, "No custom avatar found", 404);
    }
    return true;
  }

  // ── POST /api/avatar/background ──────────────────────────────────────
  if (method === "POST" && pathname === "/api/avatar/background") {
    const MAX_BG_BYTES = 10 * 1024 * 1024; // 10 MB
    const rawBody = await readRequestBodyBuffer(req, {
      maxBytes: MAX_BG_BYTES,
      returnNullOnTooLarge: true,
    });
    if (!rawBody || rawBody.length === 0) {
      error(res, "Request body is empty or exceeds 10 MB", 400);
      return true;
    }
    let ext = "";
    if (
      rawBody[0] === 0x89 &&
      rawBody[1] === 0x50 &&
      rawBody[2] === 0x4e &&
      rawBody[3] === 0x47
    ) {
      ext = "png";
    } else if (rawBody[0] === 0xff && rawBody[1] === 0xd8) {
      ext = "jpg";
    } else if (
      rawBody[0] === 0x52 &&
      rawBody[1] === 0x49 &&
      rawBody[2] === 0x46 &&
      rawBody[3] === 0x46 &&
      rawBody.length >= 12 &&
      rawBody[8] === 0x57 &&
      rawBody[9] === 0x45 &&
      rawBody[10] === 0x42 &&
      rawBody[11] === 0x50
    ) {
      ext = "webp";
    } else {
      error(res, "Invalid image file: expected PNG, JPEG, or WebP", 400);
      return true;
    }
    const avatarDir = path.join(resolveStateDir(), "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    for (const old of ["png", "jpg", "webp"]) {
      const p = path.join(avatarDir, `custom-background.${old}`);
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    const bgPath = path.join(avatarDir, `custom-background.${ext}`);
    fs.writeFileSync(bgPath, rawBody);
    json(res, { ok: true, size: rawBody.length });
    return true;
  }

  // ── GET /api/avatar/background ─────────────────────────────────────────
  if (
    (method === "GET" || method === "HEAD") &&
    pathname === "/api/avatar/background"
  ) {
    const avatarDir = path.join(resolveStateDir(), "avatars");
    const MIME: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
    };
    let found = "";
    for (const ext of ["png", "jpg", "webp"]) {
      const p = path.join(avatarDir, `custom-background.${ext}`);
      try {
        if (fs.statSync(p).isFile()) {
          found = p;
          break;
        }
      } catch {}
    }
    if (!found) {
      error(res, "No custom background found", 404);
      return true;
    }
    const stat = fs.statSync(found);
    const fileExt = path.extname(found).slice(1);
    const headers: Record<string, string | number> = {
      "Content-Type": MIME[fileExt] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    };
    if (method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return true;
    }
    const body = fs.readFileSync(found);
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  return false;
}
