import { promises as fs } from "node:fs";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type AppRunActionResult,
  type AppRunSummary,
  type AppSessionActionResult,
  hasAppInterface,
  packageNameToAppRouteSlug,
} from "../contracts/apps.js";
import { importAppRouteModule } from "../services/app-package-modules.js";
import { setOverlayAppPresence } from "../services/overlay-app-presence.js";
import type {
  InstallProgressLike,
  PluginManagerLike,
  RegistryPluginInfo,
  RegistrySearchResult,
} from "../services/plugin-manager-types.js";
import {
  scoreEntries,
  toSearchResults,
} from "../services/registry-client-queries.js";
import type { RouteHelpers, RouteRequestMeta } from "./route-helpers.js";

const HERO_IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

async function streamAppHero(
  res: unknown,
  absolutePath: string,
  contentType: string,
  error: (response: unknown, message: string, status?: number) => void,
): Promise<void> {
  let data: Buffer;
  try {
    data = await fs.readFile(absolutePath);
  } catch {
    error(res, "Hero image not found", 404);
    return;
  }
  const response = res as {
    writeHead?: (
      status: number,
      headers: Record<string, string | number>,
    ) => void;
    setHeader?: (name: string, value: string | number) => void;
    end?: (chunk?: unknown) => void;
  };
  if (typeof response.writeHead === "function") {
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.byteLength,
      "Cache-Control": "public, max-age=300",
    });
  } else if (typeof response.setHeader === "function") {
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", data.byteLength);
    response.setHeader("Cache-Control", "public, max-age=300");
  }
  response.end?.(data);
}

/**
 * Resolve the absolute on-disk path for an app's declared hero image.
 * Returns null if the slug doesn't match a known app, the app doesn't
 * declare a heroImage, the declared path escapes the package, or the
 * declared extension isn't an allowed image type.
 */
async function resolveAppHeroPath(
  pluginManager: PluginManagerLike,
  slug: string,
): Promise<{ absolutePath: string; contentType: string } | null> {
  const registry = await pluginManager.refreshRegistry();
  for (const entry of registry.values()) {
    if (packageNameToAppRouteSlug(entry.name) !== slug) continue;
    const heroImage = entry.appMeta?.heroImage;
    const localPath = entry.localPath;
    if (!heroImage || !localPath) continue;
    if (
      /^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/)/i.test(
        heroImage,
      )
    ) {
      continue;
    }
    const extension = path.extname(heroImage).toLowerCase();
    const contentType = HERO_IMAGE_CONTENT_TYPES[extension];
    if (!contentType) continue;
    const absolute = path.resolve(localPath, heroImage);
    const packageRoot = `${path.resolve(localPath)}${path.sep}`;
    if (!absolute.startsWith(packageRoot)) continue;
    return { absolutePath: absolute, contentType };
  }
  return null;
}

export interface AppManagerLike {
  listAvailable: (pluginManager: PluginManagerLike) => Promise<unknown>;
  search: (
    pluginManager: PluginManagerLike,
    query: string,
    limit?: number,
  ) => Promise<unknown>;
  listInstalled: (pluginManager: PluginManagerLike) => Promise<unknown>;
  listRuns: (runtime?: IAgentRuntime | null) => Promise<unknown>;
  getRun: (runId: string, runtime?: IAgentRuntime | null) => Promise<unknown>;
  attachRun: (
    runId: string,
    runtime?: IAgentRuntime | null,
  ) => Promise<unknown>;
  detachRun: (runId: string) => Promise<unknown>;
  launch: (
    pluginManager: PluginManagerLike,
    name: string,
    onProgress?: (progress: InstallProgressLike) => void,
    runtime?: unknown | null,
  ) => Promise<unknown>;
  stop: (
    pluginManager: PluginManagerLike,
    name: string,
    runId?: string,
    runtime?: IAgentRuntime | null,
  ) => Promise<unknown>;
  getInfo: (pluginManager: PluginManagerLike, name: string) => Promise<unknown>;
}

type AppRunSteeringDisposition =
  | "accepted"
  | "queued"
  | "rejected"
  | "unsupported";

interface AppRunSteeringResult extends AppRunActionResult {
  disposition: AppRunSteeringDisposition;
  status: number;
  session?: AppSessionActionResult["session"] | null;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string | readonly string[]) => void;
  getHeader: (name: string) => string | undefined;
  removeHeader: (name: string) => void;
  writeHead: (
    statusCode: number,
    headers?: Record<string, string | number | readonly string[]>,
  ) => CapturedResponse;
  end: (chunk?: unknown) => void;
}

export interface AppsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "readJsonBody" | "json" | "error"> {
  url: URL;
  appManager: AppManagerLike;
  getPluginManager: () => PluginManagerLike;
  parseBoundedLimit: (rawLimit: string | null, fallback?: number) => number;
  runtime: unknown | null;
}

function isNonAppRegistryPlugin(plugin: RegistryPluginInfo): boolean {
  return !hasAppInterface(plugin);
}

function actionResultStatus(result: unknown): number {
  if (
    result &&
    typeof result === "object" &&
    "success" in (result as Record<string, unknown>) &&
    (result as Record<string, unknown>).success === false
  ) {
    return 404;
  }
  return 200;
}

function createCapturedResponse(): CapturedResponse {
  const headers = new Map<string, string>();
  let body = "";
  let statusCode = 200;

  const response: CapturedResponse = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    headers: Object.create(null) as Record<string, string>,
    body,
    setHeader(name: string, value: string | readonly string[]) {
      const normalized = Array.isArray(value)
        ? value.join(", ")
        : String(value);
      headers.set(name.toLowerCase(), normalized);
      response.headers[name.toLowerCase()] = normalized;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
      delete response.headers[name.toLowerCase()];
    },
    writeHead(
      nextStatusCode: number,
      nextHeaders?: Record<string, string | number | readonly string[]>,
    ) {
      statusCode = nextStatusCode;
      if (nextHeaders) {
        for (const [name, value] of Object.entries(nextHeaders)) {
          response.setHeader(name, value.toString());
        }
      }
      return response;
    },
    end(chunk?: unknown) {
      if (chunk === undefined || chunk === null) {
        response.body = body;
        return;
      }
      body += Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : typeof chunk === "string"
          ? chunk
          : String(chunk);
      response.body = body;
    },
  };

  return response;
}

function parseCapturedBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readSteeringContent(
  body: Record<string, unknown> | null,
): string | null {
  const content =
    typeof body?.content === "string"
      ? body.content
      : typeof body?.message === "string"
        ? body.message
        : null;
  const trimmed = content?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readSteeringAction(
  body: Record<string, unknown> | null,
): "pause" | "resume" | null {
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  if (action === "pause" || action === "resume") return action;
  return null;
}

function isAppRunSummary(value: unknown): value is AppRunSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === "string" &&
    typeof (value as { appName?: unknown }).appName === "string" &&
    typeof (value as { displayName?: unknown }).displayName === "string"
  );
}

function resolveRunSteeringTarget(
  run: AppRunSummary,
  subroute: string,
): {
  pathname: string;
} | null {
  const routeSlug = packageNameToAppRouteSlug(run.appName) ?? run.appName;
  if (!routeSlug) return null;

  if (routeSlug === "babylon") {
    if (subroute === "message") {
      return {
        pathname: `/api/apps/${encodeURIComponent(routeSlug)}/agent/chat`,
      };
    }
    if (subroute === "control") {
      return {
        pathname: `/api/apps/${encodeURIComponent(routeSlug)}/agent/toggle`,
      };
    }
    return null;
  }

  if (!run.session?.sessionId) {
    return null;
  }

  return {
    pathname: `/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(run.session.sessionId)}/${subroute}`,
  };
}

function buildSteeringDisposition(
  run: AppRunSummary,
  subroute: string,
  upstreamStatus: number,
  upstreamBody: Record<string, unknown> | null,
): AppRunSteeringDisposition {
  const upstreamMessage =
    typeof upstreamBody?.message === "string"
      ? upstreamBody.message.toLowerCase()
      : typeof upstreamBody?.error === "string"
        ? upstreamBody.error.toLowerCase()
        : "";
  const upstreamDisposition = upstreamBody?.disposition;
  if (
    upstreamDisposition === "accepted" ||
    upstreamDisposition === "queued" ||
    upstreamDisposition === "rejected" ||
    upstreamDisposition === "unsupported"
  ) {
    return upstreamDisposition;
  }

  if (upstreamStatus === 202) return "queued";
  if (upstreamStatus === 404) {
    return upstreamMessage.includes("not found") ||
      upstreamMessage.includes("not available") ||
      upstreamMessage.includes("unavailable")
      ? "unsupported"
      : "rejected";
  }
  if (upstreamStatus >= 500) return "unsupported";
  if (upstreamStatus >= 400) return "rejected";

  const success = upstreamBody?.success === true || upstreamBody?.ok === true;
  if (!success) {
    return upstreamStatus >= 500 ? "unsupported" : "rejected";
  }

  if (run.appName === "@elizaos/app-2004scape" && subroute === "message") {
    return "queued";
  }

  return "accepted";
}

async function proxyRunSteeringRequest(
  ctx: AppsRouteContext,
  run: AppRunSummary,
  subroute: "message" | "control",
  body: Record<string, unknown> | null,
): Promise<AppRunSteeringResult | null> {
  const target = resolveRunSteeringTarget(run, subroute);
  if (!target) {
    return {
      success: false,
      message:
        subroute === "message"
          ? `Run-scoped messaging is unavailable for "${run.displayName}".`
          : `Run-scoped controls are unavailable for "${run.displayName}".`,
      disposition: "unsupported",
      status: 501,
      run,
      session: run.session ?? null,
    };
  }

  const routeModule = await importAppRouteModule(run.appName);
  if (typeof routeModule?.handleAppRoutes !== "function") {
    return {
      success: false,
      message:
        subroute === "message"
          ? `Run-scoped messaging is unavailable for "${run.displayName}" because its route module does not expose a steering handler.`
          : `Run-scoped controls are unavailable for "${run.displayName}" because its route module does not expose a steering handler.`,
      disposition: "unsupported",
      status: 501,
      run,
      session: run.session ?? null,
    };
  }

  const captured = createCapturedResponse();
  const syntheticUrl = new URL(ctx.url.toString());
  syntheticUrl.pathname = target.pathname;
  const syntheticCtx = {
    ...ctx,
    pathname: target.pathname,
    url: syntheticUrl,
    res: captured,
    readJsonBody: async <T extends object>() => body as T | null,
    json: (response: CapturedResponse, data: object, status = 200): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    },
    error: (
      response: CapturedResponse,
      message: string,
      status = 500,
    ): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: message }));
    },
  };

  const handled = await routeModule.handleAppRoutes(
    syntheticCtx as unknown as AppsRouteContext,
  );
  if (!handled) {
    return {
      success: false,
      message:
        subroute === "message"
          ? `Run-scoped messaging is unavailable for "${run.displayName}".`
          : `Run-scoped controls are unavailable for "${run.displayName}".`,
      disposition: "unsupported",
      status: 501,
      run,
      session: run.session ?? null,
    };
  }

  const upstreamBody = parseCapturedBody(captured.body);
  const refreshedRunCandidate = await ctx.appManager.getRun(
    run.runId,
    ctx.runtime as IAgentRuntime | null,
  );
  const refreshedRun = isAppRunSummary(refreshedRunCandidate)
    ? refreshedRunCandidate
    : run;
  const disposition = buildSteeringDisposition(
    refreshedRun,
    subroute,
    captured.statusCode,
    upstreamBody,
  );
  const success =
    upstreamBody?.success === true || upstreamBody?.ok === true
      ? true
      : disposition === "accepted" || disposition === "queued";
  const message =
    typeof upstreamBody?.message === "string" && upstreamBody.message.trim()
      ? upstreamBody.message.trim()
      : disposition === "queued"
        ? "Command queued."
        : disposition === "accepted"
          ? "Command accepted."
          : disposition === "unsupported"
            ? "This run does not support that steering channel."
            : "Command rejected.";

  return {
    success,
    message,
    disposition,
    status:
      disposition === "queued"
        ? 202
        : disposition === "rejected" && captured.statusCode < 400
          ? 409
          : disposition === "unsupported"
            ? Math.max(captured.statusCode, 501)
            : captured.statusCode,
    run: refreshedRun,
    session:
      (upstreamBody?.session as AppSessionActionResult["session"] | null) ??
      refreshedRun.session ??
      null,
  };
}

export async function handleAppsRoutes(
  ctx: AppsRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    appManager,
    getPluginManager,
    parseBoundedLimit,
    readJsonBody,
    json,
    error,
    runtime,
  } = ctx;

  if (method === "GET" && pathname === "/api/apps") {
    const pluginManager = getPluginManager();
    const apps = await appManager.listAvailable(pluginManager);
    json(res, apps as object);
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/apps/hero/")) {
    const slug = decodeURIComponent(
      pathname.slice("/api/apps/hero/".length),
    ).trim();
    if (!slug) {
      error(res, "app slug is required", 400);
      return true;
    }
    const pluginManager = getPluginManager();
    const resolved = await resolveAppHeroPath(pluginManager, slug);
    if (!resolved) {
      error(res, `Hero image for "${slug}" is not available`, 404);
      return true;
    }
    await streamAppHero(res, resolved.absolutePath, resolved.contentType, error);
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/search") {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      json(res, []);
      return true;
    }
    const limit = parseBoundedLimit(url.searchParams.get("limit"));
    const pluginManager = getPluginManager();
    const results = await appManager.search(pluginManager, query, limit);
    json(res, results as object);
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/installed") {
    const pluginManager = getPluginManager();
    const installed = await appManager.listInstalled(pluginManager);
    json(res, installed as object);
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/runs") {
    const runs = await appManager.listRuns(runtime as IAgentRuntime | null);
    json(res, runs as object);
    return true;
  }

  // Dashboard heartbeat for overlay apps (companion, etc.) — no AppManager run.
  if (method === "POST" && pathname === "/api/apps/overlay-presence") {
    const body = await readJsonBody<{ appName?: string | null }>(req, res);
    if (!body) return true;
    const raw = body.appName;
    const appName =
      typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    setOverlayAppPresence(appName);
    json(res, { ok: true, appName });
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/apps/runs/")) {
    const parts = pathname.split("/").filter(Boolean);
    const runId = parts[3] ? decodeURIComponent(parts[3]) : "";
    const subroute = parts[4] ?? "";
    if (!runId) {
      error(res, "runId is required");
      return true;
    }

    if (!subroute) {
      const run = await appManager.getRun(
        runId,
        runtime as IAgentRuntime | null,
      );
      if (!run) {
        error(res, `App run "${runId}" not found`, 404);
        return true;
      }
      json(res, run as object);
      return true;
    }

    if (subroute === "health") {
      const run = await appManager.getRun(
        runId,
        runtime as IAgentRuntime | null,
      );
      if (!run || typeof run !== "object" || run === null) {
        error(res, `App run "${runId}" not found`, 404);
        return true;
      }
      const health =
        "health" in (run as Record<string, unknown>)
          ? (run as Record<string, unknown>).health
          : null;
      json(res, health as object);
      return true;
    }
  }

  if (method === "POST" && pathname.startsWith("/api/apps/runs/")) {
    const parts = pathname.split("/").filter(Boolean);
    const runId = parts[3] ? decodeURIComponent(parts[3]) : "";
    const subroute = parts[4] ?? "";
    if (!runId || !subroute) {
      error(res, "runId is required");
      return true;
    }

    if (subroute === "attach") {
      const result = await appManager.attachRun(
        runId,
        runtime as IAgentRuntime | null,
      );
      json(res, result as object, actionResultStatus(result));
      return true;
    }

    if (subroute === "message" || subroute === "control") {
      const run = (await appManager.getRun(
        runId,
        runtime as IAgentRuntime | null,
      )) as AppRunSummary | null;
      if (!run) {
        error(res, `App run "${runId}" not found`, 404);
        return true;
      }

      const body =
        subroute === "message"
          ? await readJsonBody<{ content?: string }>(req, res)
          : await readJsonBody<{ action?: "pause" | "resume" }>(req, res);
      if (!body) return true;

      const normalizedBody =
        subroute === "message"
          ? {
              content: readSteeringContent(body as Record<string, unknown>),
            }
          : {
              action: readSteeringAction(body as Record<string, unknown>),
            };
      if (
        (subroute === "message" && !normalizedBody.content) ||
        (subroute === "control" && !normalizedBody.action)
      ) {
        error(
          res,
          subroute === "message"
            ? "content is required"
            : "action must be pause or resume",
          400,
        );
        return true;
      }

      const result = await proxyRunSteeringRequest(
        ctx,
        run,
        subroute,
        normalizedBody as Record<string, unknown>,
      );
      if (!result) {
        error(res, "Run steering failed", 500);
        return true;
      }
      json(res, result as object, result.status);
      return true;
    }

    if (subroute === "detach") {
      const result = await appManager.detachRun(runId);
      json(res, result as object, actionResultStatus(result));
      return true;
    }

    if (subroute === "stop") {
      const pluginManager = getPluginManager();
      const result = await appManager.stop(
        pluginManager,
        "",
        runId,
        ctx.runtime as IAgentRuntime | null,
      );
      json(res, result as object);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/apps/launch") {
    try {
      const body = await readJsonBody<{ name?: string }>(req, res);
      if (!body) return true;
      if (!body.name?.trim()) {
        error(res, "name is required");
        return true;
      }
      const pluginManager = getPluginManager();
      const result = await appManager.launch(
        pluginManager,
        body.name.trim(),
        (_progress: InstallProgressLike) => {},
        runtime,
      );
      json(res, result as object);
    } catch (e) {
      error(res, e instanceof Error ? e.message : "Failed to launch app", 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/apps/install") {
    try {
      const body = await readJsonBody<{ name?: string; version?: string }>(
        req,
        res,
      );
      if (!body) return true;
      const name = body.name?.trim();
      if (!name) {
        error(res, "name is required");
        return true;
      }
      const progressEvents: InstallProgressLike[] = [];
      const recordProgress = (progress: InstallProgressLike) => {
        progressEvents.push(progress);
      };
      const pluginManager = getPluginManager();
      let result = await pluginManager
        .installPlugin(
          name,
          recordProgress,
          body.version ? { version: body.version } : undefined,
        )
        .catch((err: unknown) => ({
          success: false as const,
          pluginName: name,
          version: "",
          installPath: "",
          requiresRestart: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      if (
        !result.success &&
        result.error?.includes("requires a running agent runtime")
      ) {
        // Fall back to the app-core installer which writes directly to
        // ~/.eliza/plugins/installed without depending on a plugin-manager
        // service. The runtime plugin resolver already searches that dir.
        const { installPlugin: installPluginDirect } = (await import(
          /* webpackIgnore: true */ "@elizaos/app-core/services/plugin-installer"
        )) as {
          installPlugin: (
            name: string,
            onProgress?: (progress: InstallProgressLike) => void,
            version?: string,
          ) => Promise<{
            success: boolean;
            pluginName: string;
            version: string;
            installPath: string;
            requiresRestart: boolean;
            error?: string;
          }>;
        };
        result = await installPluginDirect(name, recordProgress, body.version);
      }
      if (!result.success) {
        json(
          res,
          { success: false, error: result.error, progress: progressEvents },
          422,
        );
        return true;
      }
      json(res, {
        success: true,
        pluginName: result.pluginName ?? name,
        version: result.version,
        installPath: result.installPath,
        requiresRestart: result.requiresRestart,
        progress: progressEvents,
      });
    } catch (e) {
      error(res, e instanceof Error ? e.message : "Failed to install app", 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/apps/stop") {
    const body = await readJsonBody<{ name?: string; runId?: string }>(
      req,
      res,
    );
    if (!body) return true;
    if (!body.name?.trim() && !body.runId?.trim()) {
      error(res, "name or runId is required");
      return true;
    }
    const appName = body.name?.trim() ?? "";
    const runId = body.runId?.trim();
    const pluginManager = getPluginManager();
    const result = await appManager.stop(
      pluginManager,
      appName,
      runId,
      ctx.runtime as IAgentRuntime | null,
    );
    json(res, result as object);
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/apps/info/")) {
    const appName = decodeURIComponent(
      pathname.slice("/api/apps/info/".length),
    );
    if (!appName) {
      error(res, "app name is required");
      return true;
    }
    const pluginManager = getPluginManager();
    const info = await appManager.getInfo(pluginManager, appName);
    if (!info) {
      error(res, `App "${appName}" not found in registry`, 404);
      return true;
    }
    json(res, info as object);
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/plugins") {
    try {
      const pluginManager = getPluginManager();
      const registry = await pluginManager.refreshRegistry();
      const plugins = Array.from(registry.values()).filter(
        isNonAppRegistryPlugin,
      );
      json(res, plugins);
    } catch (err) {
      error(
        res,
        `Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/plugins/search") {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      json(res, []);
      return true;
    }
    try {
      const limit = parseBoundedLimit(url.searchParams.get("limit"));
      const pluginManager = getPluginManager();
      const registry = await pluginManager.refreshRegistry();
      const results = scoreEntries(
        Array.from(registry.values()).filter(isNonAppRegistryPlugin),
        query,
        limit,
      );
      json(res, toSearchResults(results) as RegistrySearchResult[]);
    } catch (err) {
      error(
        res,
        `Plugin search failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/apps/refresh") {
    try {
      const pluginManager = getPluginManager();
      const registry = await pluginManager.refreshRegistry();
      const count = Array.from(registry.values()).filter(
        isNonAppRegistryPlugin,
      ).length;
      json(res, { ok: true, count });
    } catch (err) {
      error(
        res,
        `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    return true;
  }

  return false;
}
