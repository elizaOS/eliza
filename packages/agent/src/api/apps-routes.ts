import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import type http from "node:http";
import { ServerResponse } from "node:http";
import path from "node:path";
import type { IAgentRuntime, RouteRequestMeta } from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import {
  type AppRunActionResult,
  type AppRunSummary,
  type AppSessionActionResult,
  createGeneratedAppHeroSvg,
  hasAppInterface,
  PostInstallAppRequestSchema,
  PostLaunchAppRequestSchema,
  PostLoadFromDirectoryRequestSchema,
  PostStopAppRequestSchema,
  PutAppPermissionsRequestSchema,
  packageNameToAppDisplayName,
  packageNameToAppRouteSlug,
  parseAppIsolation,
  parseAppPermissions,
} from "@elizaos/shared";
import {
  importAppRouteModule,
  resolveWorkspacePackageDir,
} from "../services/app-package-modules.ts";
import { setOverlayAppPresence } from "../services/overlay-app-presence.ts";
import type {
  InstallProgressLike,
  PluginManagerLike,
  RegistryPluginInfo,
  RegistrySearchResult,
} from "../services/plugin-manager-types.ts";
import {
  scoreEntries,
  toSearchResults,
} from "../services/registry-client-queries.ts";

const HERO_IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

const DEFAULT_HERO_IMAGE_CANDIDATES = [
  "assets/hero.png",
  "assets/hero.webp",
  "assets/hero.jpg",
  "assets/hero.jpeg",
  "assets/hero.avif",
  "assets/hero.gif",
  "assets/hero.svg",
] as const;

interface LocalAppPackageJson {
  elizaos?: {
    app?: {
      heroImage?: unknown;
    };
  };
}

async function streamAppHero(
  res: http.ServerResponse,
  absolutePath: string,
  contentType: string,
  error: (
    response: http.ServerResponse,
    message: string,
    status?: number,
  ) => void,
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

function sendGeneratedAppHero(res: http.ServerResponse, svg: string): void {
  const data = Buffer.from(svg, "utf8");
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
      "Content-Type": "image/svg+xml",
      "Content-Length": data.byteLength,
      "Cache-Control": "public, max-age=300",
    });
  } else if (typeof response.setHeader === "function") {
    response.setHeader("Content-Type", "image/svg+xml");
    response.setHeader("Content-Length", data.byteLength);
    response.setHeader("Cache-Control", "public, max-age=300");
  }
  response.end?.(data);
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function isRelativeHeroPath(heroImage: string): boolean {
  return !/^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/)/i.test(
    heroImage,
  );
}

async function readPackageHeroImage(
  packageDir: string,
): Promise<string | null> {
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as LocalAppPackageJson;
    const heroImage = packageJson.elizaos?.app?.heroImage;
    return typeof heroImage === "string" ? heroImage : null;
  } catch {
    return null;
  }
}

async function resolveWorkspaceAppDirBySlug(
  slug: string,
): Promise<string | null> {
  const cwd = process.cwd();
  const roots = Array.from(
    new Set([
      path.resolve(cwd),
      path.resolve(cwd, ".."),
      path.resolve(cwd, "..", ".."),
    ]),
  );
  const candidateDirs: string[] = [];
  const legacyAppsDiscovery = (() => {
    const raw = process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  })();

  for (const root of roots) {
    candidateDirs.push(
      path.join(root, "plugins", `app-${slug}`),
      path.join(root, "packages", `app-${slug}`),
    );
    if (legacyAppsDiscovery) {
      candidateDirs.push(path.join(root, "apps", `app-${slug}`));
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      candidateDirs.push(
        path.join(root, entry.name, "plugins", `app-${slug}`),
        path.join(root, entry.name, "packages", `app-${slug}`),
      );
      if (legacyAppsDiscovery) {
        // Temporary opt-in for older external workspaces. Current Eliza app
        // plugin packages live under plugins/app-*.
        candidateDirs.push(path.join(root, entry.name, "apps", `app-${slug}`));
      }
    }
  }

  for (const candidateDir of new Set(
    candidateDirs.map((dir) => path.resolve(dir)),
  )) {
    if (await pathExists(path.join(candidateDir, "package.json"))) {
      return candidateDir;
    }
  }

  return null;
}

async function resolveHeroPathFromPackageDir(
  packageDir: string,
  declaredHeroImage: string | null,
): Promise<{ absolutePath: string; contentType: string } | null> {
  const packageHeroImage = await readPackageHeroImage(packageDir);
  const heroCandidates = Array.from(
    new Set(
      [
        declaredHeroImage,
        packageHeroImage,
        ...DEFAULT_HERO_IMAGE_CANDIDATES,
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    ),
  );

  for (const heroImage of heroCandidates) {
    if (!isRelativeHeroPath(heroImage)) continue;
    const extension = path.extname(heroImage).toLowerCase();
    const contentType = HERO_IMAGE_CONTENT_TYPES[extension];
    if (!contentType) continue;
    const absolutePath = path.resolve(packageDir, heroImage);
    const packageRoot = `${path.resolve(packageDir)}${path.sep}`;
    if (!absolutePath.startsWith(packageRoot)) continue;
    if (!(await pathExists(absolutePath))) continue;
    return { absolutePath, contentType };
  }

  return null;
}

/**
 * Resolve the absolute on-disk path for an app's declared hero image.
 * Returns null if the slug doesn't match a known app or none of the
 * candidate local package directories contain a valid hero image.
 */
type ResolvedAppHero =
  | { kind: "file"; absolutePath: string; contentType: string }
  | { kind: "generated"; svg: string };

async function resolveAppHero(
  pluginManager: PluginManagerLike,
  slug: string,
): Promise<ResolvedAppHero | null> {
  const registry = await pluginManager.refreshRegistry();
  for (const entry of registry.values()) {
    const entrySlugs = new Set<string>();
    const nameSlug = packageNameToAppRouteSlug(entry.name);
    const npmSlug = packageNameToAppRouteSlug(entry.npm.package);
    if (nameSlug) entrySlugs.add(nameSlug);
    if (npmSlug) entrySlugs.add(npmSlug);
    if (!entrySlugs.has(slug)) continue;

    const packageDirs = new Set<string>();
    if (entry.localPath) {
      packageDirs.add(path.resolve(entry.localPath));
    }
    const workspacePackageDir = await resolveWorkspacePackageDir(
      entry.npm.package,
    );
    if (workspacePackageDir) {
      packageDirs.add(path.resolve(workspacePackageDir));
    }
    const workspaceSlugDir = await resolveWorkspaceAppDirBySlug(slug);
    if (workspaceSlugDir) {
      packageDirs.add(path.resolve(workspaceSlugDir));
    }

    for (const packageDir of packageDirs) {
      const resolved = await resolveHeroPathFromPackageDir(
        packageDir,
        entry.appMeta?.heroImage ?? null,
      );
      if (resolved) {
        return { kind: "file", ...resolved };
      }
    }

    return {
      kind: "generated",
      svg: createGeneratedAppHeroSvg({
        name: entry.name,
        displayName:
          entry.appMeta?.displayName ?? packageNameToAppDisplayName(entry.name),
        category: entry.appMeta?.category ?? "app",
        description: entry.description,
      }),
    };
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
  recordHeartbeat: (runId: string) => unknown;
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

export interface FavoriteAppsStore {
  /** Read the persisted favorites list. Returns a fresh array. */
  read: () => string[];
  /** Replace the persisted favorites list. Implementation must persist. */
  write: (apps: string[]) => string[];
}

export interface AppsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "readJsonBody" | "json" | "error"> {
  url: URL;
  appManager: AppManagerLike;
  getPluginManager: () => PluginManagerLike;
  parseBoundedLimit: (rawLimit: string | null, fallback?: number) => number;
  runtime: unknown | null;
  favoriteApps?: FavoriteAppsStore;
}

function sanitizeFavoriteAppNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const apps: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    apps.push(trimmed);
  }
  return apps;
}

function isNonAppRegistryPlugin(plugin: RegistryPluginInfo): boolean {
  return !hasAppInterface(plugin);
}

function actionResultStatus(result: unknown): number {
  if (
    result &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false
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
      ? parsed
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
  const syntheticResponse = Object.assign(
    Object.create(ServerResponse.prototype) as http.ServerResponse,
    captured,
  );
  const syntheticUrl = new URL(ctx.url.toString());
  syntheticUrl.pathname = target.pathname;
  const syntheticCtx: AppsRouteContext = {
    ...ctx,
    pathname: target.pathname,
    url: syntheticUrl,
    res: syntheticResponse,
    readJsonBody: async <T extends object>() => body as T | null,
    json: (
      response: http.ServerResponse,
      data: unknown,
      status = 200,
    ): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    },
    error: (
      response: http.ServerResponse,
      message: string,
      status = 500,
    ): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: message }));
    },
  };

  const handled = await routeModule.handleAppRoutes(syntheticCtx);
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
    json(res, apps);
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
    const resolved = await resolveAppHero(pluginManager, slug);
    if (!resolved) {
      error(res, `Hero image for "${slug}" is not available`, 404);
      return true;
    }
    if (resolved.kind === "file") {
      await streamAppHero(
        res,
        resolved.absolutePath,
        resolved.contentType,
        error as (response: unknown, message: string, status?: number) => void,
      );
    } else {
      sendGeneratedAppHero(res, resolved.svg);
    }
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
    json(res, results);
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/installed") {
    const pluginManager = getPluginManager();
    const installed = await appManager.listInstalled(pluginManager);
    json(res, installed);
    return true;
  }

  if (pathname === "/api/apps/favorites") {
    const store = ctx.favoriteApps;
    if (!store) {
      error(res, "Favorites store is not configured", 503);
      return true;
    }

    if (method === "GET") {
      json(res, { favoriteApps: store.read() });
      return true;
    }

    if (method === "PUT") {
      const body = await readJsonBody<{
        appName?: unknown;
        isFavorite?: unknown;
      }>(req, res);
      if (!body) return true;
      const rawName =
        typeof body.appName === "string" ? body.appName.trim() : "";
      if (!rawName) {
        error(res, "appName is required", 400);
        return true;
      }
      if (typeof body.isFavorite !== "boolean") {
        error(res, "isFavorite must be a boolean", 400);
        return true;
      }
      const current = store.read();
      const filtered = current.filter((entry) => entry !== rawName);
      const next = body.isFavorite ? [...filtered, rawName] : filtered;
      const persisted = store.write(sanitizeFavoriteAppNames(next));
      json(res, { favoriteApps: persisted });
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/apps/favorites/replace") {
    const store = ctx.favoriteApps;
    if (!store) {
      error(res, "Favorites store is not configured", 503);
      return true;
    }
    const body = await readJsonBody<{ favoriteAppNames?: unknown }>(req, res);
    if (!body) return true;
    if (!Array.isArray(body.favoriteAppNames)) {
      error(res, "favoriteAppNames must be an array of strings", 400);
      return true;
    }
    const sanitized = sanitizeFavoriteAppNames(body.favoriteAppNames);
    const persisted = store.write(sanitized);
    json(res, { favoriteApps: persisted });
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/runs") {
    const runs = await appManager.listRuns(runtime as IAgentRuntime | null);
    json(res, runs);
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
      json(res, run);
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
      const health = "health" in run ? run.health : null;
      json(res, health);
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
      json(res, result as Record<string, unknown>, actionResultStatus(result));
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
              content: readSteeringContent(body),
            }
          : {
              action: readSteeringAction(body),
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
      json(res, result, result.status);
      return true;
    }

    if (subroute === "detach") {
      const result = await appManager.detachRun(runId);
      json(res, result as Record<string, unknown>, actionResultStatus(result));
      return true;
    }

    if (subroute === "stop") {
      const pluginManager = getPluginManager();
      const result = await appManager.stop(pluginManager, "", runId, null);
      json(res, result);
      return true;
    }

    if (subroute === "heartbeat") {
      // Cheap liveness ping from the UI — does not invoke any plugin route
      // or talk to the upstream game API. The stale-run sweeper relies on
      // this so the moment a tab closes the heartbeat dries up and the
      // run gets reaped via the same `stopRun` hook the Stop button uses.
      //
      // Returns 200 + the refreshed run so the client can also use this as
      // a low-cost confirmation that the run still exists; returns 404 if
      // the run has already been stopped (so the UI can detect a Stop
      // initiated from another window or by the sweeper).
      const refreshed = appManager.recordHeartbeat(runId);
      if (!refreshed) {
        error(res, `App run "${runId}" not found`, 404);
        return true;
      }
      json(res, { ok: true, run: refreshed } as object);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/apps/launch") {
    try {
      const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
      if (rawBody === null || rawBody === undefined) return true;
      const parsed = PostLaunchAppRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const issuePath = issue?.path?.join(".") ?? "<root>";
        error(
          res,
          `Invalid request body at ${issuePath}: ${issue?.message ?? "validation failed"}`,
          400,
        );
        return true;
      }
      const pluginManager = getPluginManager();
      const result = await appManager.launch(
        pluginManager,
        parsed.data.name,
        (_progress: InstallProgressLike) => {},
        runtime,
      );
      json(res, result);
    } catch (e: unknown) {
      error(res, e instanceof Error ? e.message : "Failed to launch app", 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/apps/install") {
    try {
      const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
      if (rawBody === null || rawBody === undefined) return true;
      const parsed = PostInstallAppRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const issuePath = issue?.path?.join(".") ?? "<root>";
        error(
          res,
          `Invalid request body at ${issuePath}: ${issue?.message ?? "validation failed"}`,
          400,
        );
        return true;
      }
      const { name, version } = parsed.data;
      const progressEvents: InstallProgressLike[] = [];
      const recordProgress = (progress: InstallProgressLike) => {
        progressEvents.push(progress);
      };
      const pluginManager = getPluginManager();
      let result = await pluginManager
        .installPlugin(name, recordProgress, version ? { version } : undefined)
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
        // Fall back to the direct installer which writes directly to
        // ~/.eliza/plugins/installed without depending on a plugin-manager
        // service. The runtime plugin resolver already searches that dir.
        const { installPlugin: installPluginDirect } = await import(
          /* webpackIgnore: true */ "../services/plugin-installer.js"
        );
        result = await installPluginDirect(name, recordProgress, version);
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
    const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawBody === null || rawBody === undefined) return true;
    const parsed = PostStopAppRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const issuePath = issue?.path?.join(".") ?? "<root>";
      error(
        res,
        `Invalid request body at ${issuePath}: ${issue?.message ?? "validation failed"}`,
        400,
      );
      return true;
    }
    const appName = parsed.data.name ?? "";
    const runId = parsed.data.runId;
    const pluginManager = getPluginManager();
    const result = await appManager.stop(pluginManager, appName, runId);
    json(res, result);
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
    json(res, info);
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

  // -------------------------------------------------------------------------
  // Unified APP-action HTTP surface (relaunch / load-from-directory / create)
  //
  // These endpoints pair with the in-process @elizaos/plugin-app-control APP
  // action sub-modes. They live here so dashboard UIs and platform connectors
  // can reach the same behaviour without going through the chat planner.
  // -------------------------------------------------------------------------

  if (method === "POST" && pathname === "/api/apps/relaunch") {
    const body = await readJsonBody<{
      name?: string;
      runId?: string;
      verify?: boolean;
    }>(req, res);
    if (!body) return true;
    const name = body.name?.trim();
    if (!name) {
      error(res, "name is required");
      return true;
    }
    const pluginManager = getPluginManager();

    try {
      // Stop matching runs first.
      if (body.runId?.trim()) {
        await appManager.stop(pluginManager, "", body.runId.trim(), null);
      } else {
        await appManager.stop(pluginManager, name, undefined, null);
      }

      const launch = await appManager.launch(
        pluginManager,
        name,
        (_progress: InstallProgressLike) => {},
        runtime,
      );

      let verify: { verdict: string; retryablePromptForChild?: string } | null =
        null;
      if (body.verify === true) {
        const runtimeWithServices = runtime as {
          getService?: (type: string) => {
            verifyApp?: (opts: {
              workdir: string;
              appName?: string;
              profile?: "fast" | "full";
            }) => Promise<{
              verdict: "pass" | "fail";
              retryablePromptForChild: string;
            }>;
          } | null;
        } | null;
        const verificationService =
          runtimeWithServices?.getService?.("app-verification") ?? null;
        if (verificationService?.verifyApp) {
          // Workdir is unknown server-side; verification needs the app's
          // source dir which we cannot infer from a name alone, so we record
          // skip rather than guess. Callers that need verification should
          // route through the in-process APP action with an explicit workdir.
          verify = {
            verdict: "skipped",
            retryablePromptForChild:
              "Verification requires a workdir; relaunch endpoint cannot infer one.",
          };
        }
      }

      json(res, { launch, verify });
    } catch (err) {
      error(
        res,
        `Relaunch failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/apps/permissions") {
    const runtimeWithList = runtime as {
      getService?: (type: string) => {
        listPermissionsViews?: () => Promise<unknown[]>;
      } | null;
    } | null;
    const registry = runtimeWithList?.getService?.("app-registry") ?? null;
    if (!registry?.listPermissionsViews) {
      error(res, "AppRegistryService is not registered on the runtime", 503);
      return true;
    }
    const views = await registry.listPermissionsViews();
    json(res, views);
    return true;
  }

  if (
    (method === "GET" || method === "PUT") &&
    pathname.startsWith("/api/apps/permissions/")
  ) {
    const slug = decodeURIComponent(
      pathname.slice("/api/apps/permissions/".length),
    );
    if (!slug || slug.includes("/")) {
      error(res, "slug is required");
      return true;
    }
    const runtimeWithRegistry = runtime as {
      getService?: (type: string) => {
        getPermissionsView?: (slug: string) => Promise<unknown>;
        setGrantedNamespaces?: (
          slug: string,
          namespaces: readonly string[],
          actor: "user" | "first-party-auto",
        ) => Promise<
          | { ok: true; view: unknown }
          | {
              ok: false;
              reason: string;
              unknownNamespaces?: string[];
              notRequestedNamespaces?: string[];
            }
        >;
      } | null;
    } | null;
    const registry = runtimeWithRegistry?.getService?.("app-registry") ?? null;
    if (!registry?.getPermissionsView || !registry.setGrantedNamespaces) {
      error(res, "AppRegistryService is not registered on the runtime", 503);
      return true;
    }

    if (method === "GET") {
      const view = await registry.getPermissionsView(slug);
      if (view === null || view === undefined) {
        error(res, `No app registered under slug=${slug}`, 404);
        return true;
      }
      json(res, view);
      return true;
    }

    // PUT — replace granted namespaces. Body validation goes through
    // the zod schema in @elizaos/shared so the wire shape is the
    // single source of truth (see contracts/app-permissions-routes.ts).
    const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawBody === null || rawBody === undefined) return true;
    const parsed = PutAppPermissionsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join(".") ?? "<root>";
      error(
        res,
        `Invalid request body at ${path}: ${issue?.message ?? "validation failed"}`,
        400,
      );
      return true;
    }
    const result = await registry.setGrantedNamespaces(
      slug,
      parsed.data.namespaces,
      "user",
    );
    if (result.ok === false) {
      const status = result.reason.startsWith("No app registered") ? 404 : 400;
      error(res, result.reason, status);
      return true;
    }
    json(res, result.view);
    return true;
  }

  if (method === "POST" && pathname === "/api/apps/load-from-directory") {
    // Body validation goes through PostLoadFromDirectoryRequestSchema
    // (zod, see @elizaos/shared/contracts/apps-loading-routes.ts).
    // The schema handles the required check, the absolute-path check,
    // and rejects extra unknown fields via .strict().
    const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawBody === null || rawBody === undefined) return true;
    const parsed = PostLoadFromDirectoryRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join(".") ?? "<root>";
      error(
        res,
        `Invalid request body at ${path}: ${issue?.message ?? "validation failed"}`,
        400,
      );
      return true;
    }
    const directory = parsed.data.directory;

    const runtimeWithServices = runtime as {
      getService?: (type: string) => {
        register?: (
          entry: Record<string, unknown>,
          ctx?: {
            requesterEntityId?: string | null;
            requesterRoomId?: string | null;
            trust?: "first-party" | "external";
          },
        ) => Promise<void>;
        recordManifestRejection?: (rejection: {
          directory: string;
          packageName: string | null;
          reason: string;
          path: string;
          requesterEntityId?: string | null;
          requesterRoomId?: string | null;
        }) => Promise<void>;
      } | null;
    } | null;
    const registry = runtimeWithServices?.getService?.("app-registry") ?? null;
    if (!registry?.register) {
      error(res, "AppRegistryService is not registered on the runtime", 503);
      return true;
    }

    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      let registered = 0;
      const items: Array<{ slug: string; canonicalName: string }> = [];
      const rejectedManifests: Array<{
        directory: string;
        packageName: string | null;
        reason: string;
        path: string;
      }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subdir = path.join(directory, entry.name);
        const pkgPath = path.join(subdir, "package.json");
        const raw = await fs.readFile(pkgPath, "utf8").catch(() => null);
        if (raw === null) continue;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const elizaos =
          parsed.elizaos && typeof parsed.elizaos === "object"
            ? (parsed.elizaos as Record<string, unknown>)
            : null;
        const appMeta =
          elizaos?.app && typeof elizaos.app === "object"
            ? (elizaos.app as Record<string, unknown>)
            : null;
        if (!appMeta) continue;
        const packageName =
          typeof parsed.name === "string" ? parsed.name : null;
        if (!packageName) continue;

        const permissionsResult = parseAppPermissions(appMeta.permissions);
        if (permissionsResult.ok === false) {
          const rejection = {
            directory: subdir,
            packageName,
            reason: permissionsResult.reason,
            path: permissionsResult.path,
          };
          rejectedManifests.push(rejection);
          await registry.recordManifestRejection?.({
            ...rejection,
            requesterEntityId: null,
            requesterRoomId: null,
          });
          continue;
        }

        const basename = packageName.replace(/^@[^/]+\//, "").trim();
        const slug =
          (typeof appMeta.slug === "string" && appMeta.slug.trim()) ||
          basename.replace(/^app-/, "");
        const displayName =
          (typeof appMeta.displayName === "string" &&
            appMeta.displayName.trim()) ||
          basename;
        const aliases = Array.isArray(appMeta.aliases)
          ? appMeta.aliases.filter((v): v is string => typeof v === "string")
          : [];
        const entryRecord: Record<string, unknown> = {
          slug,
          canonicalName: packageName,
          aliases,
          directory: subdir,
          displayName,
          isolation: parseAppIsolation(appMeta.isolation),
        };
        if (permissionsResult.manifest.raw !== null) {
          entryRecord.requestedPermissions = permissionsResult.manifest.raw;
        }
        await registry.register(entryRecord, {
          requesterEntityId: null,
          requesterRoomId: null,
          trust: "external",
        });
        registered += 1;
        items.push({ slug, canonicalName: packageName });
      }
      json(res, {
        ok: true,
        directory,
        registered,
        items,
        rejectedManifests,
      });
    } catch (err) {
      error(
        res,
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/apps/create") {
    const body = await readJsonBody<{ intent?: string; editTarget?: string }>(
      req,
      res,
    );
    if (!body) return true;
    const intent = body.intent?.trim() ?? "";
    if (!intent) {
      error(res, "intent is required");
      return true;
    }

    const runtimeWithActions = runtime as {
      actions?: Array<{
        name: string;
        handler: (
          runtime: unknown,
          message: unknown,
          state: unknown,
          options: unknown,
          callback: unknown,
        ) => Promise<unknown>;
      }>;
      agentId?: string;
    } | null;
    const appAction =
      runtimeWithActions?.actions?.find((a) => a.name === "APP") ?? null;
    if (!appAction) {
      error(res, "APP action is not registered on the runtime", 503);
      return true;
    }

    try {
      const lines: string[] = [];
      const callback = async (content: { text?: string }) => {
        if (typeof content?.text === "string" && content.text.length > 0) {
          lines.push(content.text);
        }
        return [];
      };
      const fakeMessage = {
        entityId: runtimeWithActions?.agentId ?? "system",
        roomId: runtimeWithActions?.agentId ?? "system",
        agentId: runtimeWithActions?.agentId ?? "system",
        content: { text: intent },
      };
      const result = (await appAction.handler(
        runtime,
        fakeMessage,
        undefined,
        {
          parameters: {
            mode: "create",
            intent,
            ...(body.editTarget ? { editTarget: body.editTarget } : {}),
          },
          mode: "create",
          intent,
          ...(body.editTarget ? { editTarget: body.editTarget } : {}),
        },
        callback,
      )) as { success?: boolean; text?: string; data?: unknown } | undefined;
      json(res, {
        success: result?.success !== false,
        text: result?.text ?? lines.join("\n"),
        messages: lines,
        data: result?.data ?? null,
      });
    } catch (err) {
      error(
        res,
        `Create failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  return false;
}
