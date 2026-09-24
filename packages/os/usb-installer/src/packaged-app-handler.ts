// Serves packaged renderer assets and keeps the API on the same loopback origin.
import fs from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function packagedAssetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  if (
    !relative ||
    relative.includes("\0") ||
    relative.split("/").includes("..")
  ) {
    return null;
  }

  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relative);
  return absolute.startsWith(`${absoluteRoot}${sep}`) ? absolute : null;
}

export function createPackagedAppHandler(
  assetsRoot: string,
  backend: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4) || "/";
      const body = ["GET", "HEAD"].includes(request.method)
        ? undefined
        : await request.arrayBuffer();
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        redirect: request.redirect,
        signal: request.signal,
      };
      if (body !== undefined) init.body = body;
      return backend(new Request(url, init));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const path = packagedAssetPath(assetsRoot, url.pathname);
    if (!path) return new Response("Not found", { status: 404 });

    let contents: Uint8Array;
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return new Response("Not found", { status: 404 });
      }
      contents = await fs.readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Response("Not found", { status: 404 });
      }
      throw error;
    }

    const responseBody = contents.buffer.slice(
      contents.byteOffset,
      contents.byteOffset + contents.byteLength,
    ) as ArrayBuffer;
    return new Response(request.method === "HEAD" ? null : responseBody, {
      headers: {
        "Cache-Control":
          url.pathname === "/"
            ? "no-store"
            : "public, max-age=31536000, immutable",
        "Content-Type":
          CONTENT_TYPES[extname(path).toLowerCase()] ??
          "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}
