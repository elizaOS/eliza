/**
 * Static file serving for the built React dashboard (production mode).
 *
 * Extracted from server.ts — serves packages/app/dist/ with SPA fallback,
 * caching, and API-base injection for reverse-proxy deployments.
 */

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger, sendJsonError } from "@elizaos/core";
import { isCloudProvisionedContainer } from "@elizaos/plugin-elizacloud";
import { resolveApiToken } from "@elizaos/shared";
import { getOrReadCachedFile } from "./memory-bounds.ts";
import { findOwnPackageRoot } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const STATIC_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".gz": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".mjs": "application/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".vrm": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------
// UI directory resolution
// ---------------------------------------------------------------------------

/** Resolved UI directory. Lazily computed once on first request. */
let uiDir: string | null | undefined;
let uiIndexHtml: Buffer | null = null;

export function resolveUiDir(): string | null {
  if (uiDir !== undefined) return uiDir;
  if (process.env.NODE_ENV !== "production") {
    uiDir = null;
    return null;
  }

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findOwnPackageRoot(thisDir);
  const candidates = [
    path.resolve("packages/app/dist"),
    path.resolve("apps/app/dist"),
    path.resolve(packageRoot, "packages", "app", "dist"),
    path.resolve(packageRoot, "apps", "app", "dist"),
  ];

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, "index.html");
    try {
      if (fs.statSync(indexPath).isFile()) {
        uiDir = candidate;
        uiIndexHtml = fs.readFileSync(indexPath);
        logger.info(`[eliza-api] Serving dashboard UI from ${candidate}`);
        return uiDir;
      }
    } catch {
      // Candidate not present, keep searching.
    }
  }

  uiDir = null;
  logger.info("[eliza-api] No built UI found — dashboard routes are disabled");
  return null;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function sendStaticResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body?: Buffer,
): void {
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

// ---------------------------------------------------------------------------
// Static file cache
// ---------------------------------------------------------------------------

const STATIC_CACHE_MAX = 50;
const STATIC_CACHE_FILE_LIMIT = 512 * 1024; // 512 KB
const staticFileCache = new Map<string, { body: Buffer; mtimeMs: number }>();

function getCachedFile(filePath: string, mtimeMs: number): Buffer {
  return getOrReadCachedFile(
    staticFileCache,
    filePath,
    mtimeMs,
    (p) => fs.readFileSync(p),
    STATIC_CACHE_MAX,
    STATIC_CACHE_FILE_LIMIT,
  );
}

// ---------------------------------------------------------------------------
// API base injection (reverse-proxy support)
// ---------------------------------------------------------------------------

/**
 * Serve built dashboard assets from packages/app/dist with SPA fallback.
 * Returns true when the request is handled.
 */
export function injectApiBaseIntoHtml(
  html: Buffer,
  externalBase?: string | null,
  opts?: { apiToken?: string | null },
): Buffer {
  const trimmedBase = externalBase?.trim();
  const trimmedToken = opts?.apiToken?.trim();
  if (!trimmedBase && !trimmedToken) return html;

  const headCloseTag = "</head>";
  const headCloseIndex = html.indexOf(headCloseTag);
  if (headCloseIndex < 0) return html;

  const parts: string[] = [];
  if (trimmedBase) {
    parts.push(`window.__ELIZA_API_BASE__=${JSON.stringify(trimmedBase)};`);
  }
  if (trimmedToken) {
    parts.push(`window.__ELIZA_API_TOKEN__=${JSON.stringify(trimmedToken)};`);
  }
  const injection = Buffer.from(`<script>${parts.join("")}</script>`);

  return Buffer.concat([
    html.subarray(0, headCloseIndex),
    injection,
    html.subarray(headCloseIndex),
  ]);
}

// ---------------------------------------------------------------------------
// SPA serving
// ---------------------------------------------------------------------------

export function serveStaticUi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): boolean {
  const root = resolveUiDir();
  if (!root) return false;

  // Keep API and WebSocket namespaces exclusively owned by server handlers.
  if (isAuthProtectedRoute(pathname)) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJsonError(res, "Invalid URL path encoding", 400);
    return true;
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  const candidatePath = path.resolve(root, relativePath);
  if (
    candidatePath !== root &&
    !candidatePath.startsWith(`${root}${path.sep}`)
  ) {
    sendJsonError(res, "Forbidden", 403);
    return true;
  }

  try {
    const stat = fs.statSync(candidatePath);
    if (stat.isFile()) {
      const ext = path.extname(candidatePath).toLowerCase();
      const body = getCachedFile(candidatePath, stat.mtimeMs);
      const isPreviewOrBinaryAsset =
        relativePath.startsWith("vrms/previews/") ||
        relativePath.startsWith("vrms/backgrounds/") ||
        [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".webp",
          ".avif",
          ".svg",
          ".mp3",
          ".wav",
          ".ogg",
          ".m4a",
          ".aac",
          ".flac",
          ".glb",
          ".spz",
        ].includes(ext);
      const cacheControl = relativePath.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : ext === ".vrm" ||
            relativePath.endsWith(".vrm.gz") ||
            isPreviewOrBinaryAsset
          ? "public, max-age=86400"
          : "public, max-age=0, must-revalidate";
      sendStaticResponse(
        req,
        res,
        200,
        {
          "Cache-Control": cacheControl,
          "Content-Length": body.length,
          "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream",
        },
        body,
      );
      return true;
    }
  } catch {
    // Missing file falls through to SPA index fallback below.
  }

  // Only serve the SPA index.html for navigation-like requests (no file extension
  // or .html). Asset requests (.vrm, .js, .png, etc.) that miss on disk should 404
  // rather than silently returning HTML — which breaks binary loaders like GLTFLoader.
  const reqExt = path.extname(decodedPath).toLowerCase();
  if (reqExt && reqExt !== ".html") return false;

  if (!uiIndexHtml) return false;

  // When served behind a reverse proxy that rewrites the app under a path prefix,
  // inject the API base so the UI client sends requests to the correct path prefix.
  // For cloud-provisioned containers, also inject the API token so the browser
  // client can authenticate without requiring a pairing flow.
  const cloudToken = isCloudProvisionedContainer()
    ? resolveApiToken(process.env)
    : null;
  const html = injectApiBaseIntoHtml(
    uiIndexHtml,
    process.env.ELIZA_EXTERNAL_BASE_URL,
    cloudToken ? { apiToken: cloudToken } : undefined,
  );

  sendStaticResponse(
    req,
    res,
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Length": html.length,
      "Content-Type": "text/html; charset=utf-8",
    },
    html,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

export function isAuthProtectedRoute(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/")
  );
}
