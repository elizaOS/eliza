/** One installation-bound delivery path for root and sibling view resources. */
import { createHash } from "node:crypto";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  parseHostExternalSpecifiers,
  wrapBundleAsHostExternalFactory,
} from "./dynamic-view-host-external.mjs";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.ts";
import {
  getViewAssetRoot,
  readViewAsset,
  type ViewAssetKind,
  validViewAssetPath,
} from "./view-assets.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import { assertRuntimeViewEntry, getView } from "./views-registry.ts";
import type { ViewsRouteContext } from "./views-routes.ts";

function contentTypeForViewAsset(assetPath: string): string {
  const ext = path.extname(assetPath).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

export async function handleViewAssetRequest(
  ctx: ViewsRouteContext,
  runtime: IAgentRuntime,
  id: string,
  resource: string,
  authorized: (entry: ViewRegistryEntry) => boolean,
): Promise<boolean> {
  const { req, res, url, method, error, json } = ctx;
  if (!isDynamicLoadingAllowed(detectClientPlatform(req))) {
    error(
      res,
      "Dynamic view asset loading is not permitted on this platform.",
      403,
    );
    return true;
  }
  const bound = resource.startsWith("installations/");
  let segments: string[];
  try {
    segments = resource.split("/").map(decodeURIComponent);
  } catch {
    // error-policy:J3 Malformed percent encoding is an explicit invalid request.
    error(res, "Malformed view asset path", 400);
    return true;
  }
  const viewType = bound
    ? segments[2]
    : (url.searchParams.get("viewType") ?? "gui");
  const kind = bound
    ? segments[3]
    : resource === "frame.html"
      ? "frame"
      : "bundle";
  const file = bound ? segments.slice(4).join("/") : segments.join("/");
  if (
    !(viewType === "gui" || viewType === "tui" || viewType === "xr") ||
    !(kind === "bundle" || kind === "frame") ||
    !validViewAssetPath(file) ||
    (bound &&
      url.searchParams.has("viewType") &&
      url.searchParams.get("viewType") !== viewType)
  ) {
    error(res, "Malformed view asset path or modality", 400);
    return true;
  }
  const entry = getView(runtime, id, { viewType });
  if (!entry || entry.viewType !== viewType) {
    error(res, `View "${id}" not found`, 404);
    return true;
  }
  if (!authorized(entry)) {
    error(res, `View "${id}" is not available to this caller`, 403);
    return true;
  }
  const lease = bound ? segments[1] : url.searchParams.get("installation");
  if (lease !== entry.installationId) {
    error(
      res,
      "View installation changed; refresh the view catalog before loading this asset",
      409,
    );
    return true;
  }
  const root = getViewAssetRoot(entry, kind as ViewAssetKind);
  if (!root) {
    error(res, "View asset is not built or has no local root", 404);
    return true;
  }
  if (!bound) {
    if (resource !== "bundle.js" && resource !== "frame.html") {
      error(
        res,
        "Use the installation-bound catalog URL and declare sibling assets in its .assets.json manifest",
        409,
      );
      return true;
    }
    const target = new URL(
      kind === "bundle" ? entry.bundleUrl! : entry.frameUrl!,
      url,
    );
    for (const [key, value] of url.searchParams)
      if (key !== "installation" && key !== "viewType")
        target.searchParams.set(key, value);
    res.writeHead(307, {
      Location: `${target.pathname}${target.search}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return true;
  }
  try {
    assertRuntimeViewEntry(runtime, entry);
    let bytes = await readViewAsset(root, file);
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    if (url.searchParams.has("v") && url.searchParams.get("v") !== sourceHash) {
      error(res, "View asset bytes do not match the requested version", 409);
      return true;
    }
    const hostExternals =
      kind === "bundle" && file === root.rootName
        ? parseHostExternalSpecifiers(url)
        : [];
    if (hostExternals.length) {
      const { init, parse } = await import("es-module-lexer");
      await init;
      const [imports] = parse(bytes.toString("utf8"));
      if (
        imports.some(
          (item) =>
            item.d !== -2 &&
            (!item.n || item.n.startsWith(".") || item.n.startsWith("/")),
        )
      ) {
        json(
          res,
          {
            error:
              "The host-external blob loader requires a self-contained module; use the canonical view build or a manifest-backed frame",
            code: "VIEW_MODULE_GRAPH_UNSUPPORTED",
          },
          422,
        );
        return true;
      }
      bytes = Buffer.from(
        wrapBundleAsHostExternalFactory(bytes.toString("utf8"), hostExternals),
      );
    }
    assertRuntimeViewEntry(runtime, entry);
    if (!authorized(entry)) {
      error(res, `View "${id}" is no longer available to this caller`, 403);
      return true;
    }
    const digest = createHash("sha256").update(bytes).digest();
    const etag = `"${digest.toString("hex")}"`;
    const notModified = req.headers["if-none-match"] === etag;
    res.writeHead(notModified ? 304 : 200, {
      "Content-Type": contentTypeForViewAsset(file),
      "Content-Length": bytes.byteLength,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": hostExternals.length ? "no-store" : "private, no-cache",
      "X-Content-Hash": `sha256-${digest.toString("base64")}`,
      ETag: etag,
    });
    res.end(notModified || method === "HEAD" ? undefined : bytes);
  } catch (caught) {
    // error-policy:J1 The HTTP boundary returns a structured asset failure.
    const code =
      caught && typeof caught === "object" && "code" in caught
        ? String(caught.code)
        : "VIEW_ASSET_READ_FAILED";
    json(
      res,
      {
        error:
          caught instanceof Error
            ? caught.message
            : "Failed to read view asset",
        code,
      },
      code === "VIEW_ASSET_NOT_PUBLISHED" || code === "ENOENT" ? 404 : 409,
    );
  }
  return true;
}
