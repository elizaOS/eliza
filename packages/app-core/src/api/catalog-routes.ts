// Catalog routes — surfaces the registry SoT to the frontend.
//
// /api/catalog/apps  → static apps known to the registry (internal-tool apps,
//                      curated apps, plugin-shipped apps). Lets AppsView stop
//                      depending on the hardcoded INTERNAL_TOOL_APPS array
//                      and the ELIZA_CURATED_APP_DEFINITIONS list.
//
// Server-discovered apps (npm packages installed at runtime) and overlay
// apps (runtime-registered) are still merged on the frontend; this endpoint
// covers the static, declared catalog only.

import type http from "node:http";
import type { RegistryAppInfo } from "@elizaos/shared";
import { type AppEntry, getApps, loadRegistry } from "../registry";
import { ensureRouteAuthorized } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson as sendJsonResponse } from "./response";

function appEntryToRegistryAppInfo(entry: AppEntry): RegistryAppInfo {
  const launchType =
    entry.launch.type === "server-launch" ? "server" : entry.launch.type;
  return {
    name: entry.npmName ?? entry.id,
    displayName: entry.name,
    description: entry.description ?? "",
    category: entry.subtype,
    launchType,
    launchUrl: entry.launch.url ?? null,
    icon: entry.render.icon ?? null,
    heroImage: entry.render.heroImage ?? null,
    capabilities: entry.launch.capabilities ?? [],
    stars: 0,
    repository: entry.resources.repository ?? "",
    latestVersion: entry.version ?? null,
    supports: entry.launch.supports ?? { v0: false, v1: false, v2: true },
    npm: entry.launch.npm ?? {
      package: entry.npmName ?? entry.id,
      v0Version: null,
      v1Version: null,
      v2Version: entry.version ?? null,
    },
    viewer: entry.launch.viewer,
    uiExtension: entry.launch.uiExtension,
  };
}

export async function handleCatalogRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/catalog")) {
    return false;
  }

  if (method === "GET" && url.pathname === "/api/catalog/apps") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const apps = getApps(loadRegistry()).filter((a) => a.render.visible);
    sendJsonResponse(res, 200, apps.map(appEntryToRegistryAppInfo));
    return true;
  }

  return false;
}
