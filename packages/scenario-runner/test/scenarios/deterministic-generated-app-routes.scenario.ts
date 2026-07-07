/**
 * Keyless coverage that a generated app lands in the real registry with a catalog
 * tile, hero, and dispatchable routes. Runs on the pr-deterministic lane under the
 * LLM proxy.
 */
import { promises as fs } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleAppPackageRoutes } from "@elizaos/agent/api/app-package-routes";
import { registerPluginViews } from "@elizaos/agent/api/views-registry";
import { handleViewsRoutes } from "@elizaos/agent/api/views-routes";
import {
  registerRuntimeAppRouteModule,
  unregisterRuntimeAppRouteModule,
} from "@elizaos/agent/services/app-package-modules";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  getCuratedAppDefinitions,
  packageNameToAppDisplayName,
} from "@elizaos/shared";
import appControlPlugin from "../../../../plugins/plugin-app-control/src/index.js";
import { handleAppsRoutes } from "../../../../plugins/plugin-app-manager/src/index.js";
import { resetAppControlHttpLoopback } from "./_helpers/app-control-http-loopback";

const GENERATED_PACKAGE = "@scenario/app-generated-console";
const GENERATED_SLUG = "generated-console";
const GENERATED_DISPLAY = "Generated Console";
const GENERATED_RUN_ID = "run-generated-console-1";
const GENERATED_SESSION_ID = "session-generated-console-1";

const HTTP_PACKAGE = "@scenario/app-http-console";
const HTTP_SLUG = "http-console";
const HTTP_DISPLAY = "HTTP Console";

const SCENARIO_TEMP_ROOT = path.join(
  os.tmpdir(),
  `eliza-deterministic-generated-app-routes-${process.pid}-${Date.now()}`,
);
const ACTION_APPS_ROOT = path.join(SCENARIO_TEMP_ROOT, "action-apps");
const HTTP_APPS_ROOT = path.join(SCENARIO_TEMP_ROOT, "http-apps");
const STATE_DIR = path.join(SCENARIO_TEMP_ROOT, "state");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const APP_CONTROL_PLUGIN_DIR = path.join(
  REPO_ROOT,
  "plugins/plugin-app-control",
);

const scenarioApiRoutePaths = [
  ["GET", "/api/apps"],
  ["GET", "/api/apps/search"],
  ["GET", "/api/apps/hero/:slug"],
  ["GET", "/api/apps/info/:appName"],
  ["POST", "/api/apps/load-from-directory"],
  ["POST", "/api/apps/launch"],
  ["GET", "/api/apps/runs"],
  ["GET", "/api/apps/runs/:runId"],
  ["POST", "/api/apps/runs/:runId/message"],
  ["POST", "/api/apps/runs/:runId/control"],
  ["POST", "/api/apps/runs/:runId/heartbeat"],
  ["POST", "/api/apps/runs/:runId/stop"],
  ["GET", "/api/apps/:slug/ping"],
  ["POST", "/api/apps/:slug/session/:sessionId/message"],
  ["POST", "/api/apps/:slug/session/:sessionId/control"],
  ["GET", "/api/views"],
] as const;

let previousElizaStateDir: string | undefined;
let scenarioRuntime: RuntimeWithRoutes | null = null;
const appRuns = new Map<string, Record<string, unknown>>();
const packageRouteLedger: Array<Record<string, unknown>> = [];
const viewBroadcastLedger: object[] = [];

type RuntimeWithRoutes = {
  routes?: Array<Record<string, unknown>>;
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  hasService?: (serviceType: string) => boolean;
  registerPlugin?: (plugin: unknown) => Promise<void>;
  registerService?: (service: unknown) => Promise<void>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const itemRecord = record(item);
        return itemRecord ? [itemRecord] : [];
      })
    : [];
}

function appDirectory(root: string, slug: string): string {
  return path.join(root, slug);
}

async function writeAppPackage(args: {
  root: string;
  packageName: string;
  slug: string;
  displayName: string;
  aliases: string[];
}): Promise<void> {
  const dir = appDirectory(args.root, args.slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: args.packageName,
        version: "1.0.0",
        description: `${args.displayName} deterministic app`,
        elizaos: {
          app: {
            slug: args.slug,
            displayName: args.displayName,
            aliases: args.aliases,
            category: "tool",
            launchType: "local",
            launchUrl: `/apps/${args.slug}`,
            isolation: "worker",
            capabilities: ["deterministic-route"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function restoreStateDirEnv(): void {
  if (previousElizaStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = previousElizaStateDir;
  }
}

function scenarioCatalogTiles(): Array<Record<string, unknown>> {
  const allowed = new Set([GENERATED_SLUG, HTTP_SLUG]);
  return getCuratedAppDefinitions()
    .filter((definition) => allowed.has(definition.slug))
    .map((definition) => ({
      name: definition.canonicalName,
      slug: definition.slug,
      displayName: packageNameToAppDisplayName(definition.canonicalName),
      description: `${definition.slug} deterministic app`,
      category: "tool",
      launchType: "local",
      launchUrl: `/apps/${definition.slug}`,
      route: `/apps/${definition.slug}`,
      heroImage: `/api/apps/hero/${definition.slug}`,
      icon: null,
      capabilities: ["deterministic-route"],
      visibleInAppStore: true,
      installed: true,
      source: "real-curated-registry",
    }));
}

function catalogTile(slug: string): Record<string, unknown> | null {
  return scenarioCatalogTiles().find((tile) => tile.slug === slug) ?? null;
}

function registryPluginInfo(args: {
  packageName: string;
  slug: string;
  displayName: string;
  directory: string;
}): Record<string, unknown> {
  return {
    name: args.packageName,
    displayName: args.displayName,
    description: `${args.displayName} deterministic app`,
    kind: "app",
    localPath: args.directory,
    topics: ["scenario", "deterministic"],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: args.packageName,
      v0Version: null,
      v1Version: "1.0.0",
      v2Version: null,
    },
    git: {
      v0Branch: null,
      v1Branch: null,
      v2Branch: null,
    },
    supports: {
      v0: false,
      v1: true,
      v2: false,
    },
    appMeta: {
      slug: args.slug,
      displayName: args.displayName,
      category: "tool",
      launchType: "local",
      launchUrl: `/apps/${args.slug}`,
      icon: null,
      heroImage: null,
      capabilities: ["deterministic-route"],
      minPlayers: null,
      maxPlayers: null,
      session: {
        mode: "interactive",
        features: ["messages", "controls"],
      },
    },
  };
}

function registryMap(): Map<string, Record<string, unknown>> {
  return new Map([
    [
      GENERATED_PACKAGE,
      registryPluginInfo({
        packageName: GENERATED_PACKAGE,
        slug: GENERATED_SLUG,
        displayName: GENERATED_DISPLAY,
        directory: appDirectory(ACTION_APPS_ROOT, GENERATED_SLUG),
      }),
    ],
    [
      HTTP_PACKAGE,
      registryPluginInfo({
        packageName: HTTP_PACKAGE,
        slug: HTTP_SLUG,
        displayName: HTTP_DISPLAY,
        directory: appDirectory(HTTP_APPS_ROOT, HTTP_SLUG),
      }),
    ],
  ]);
}

function makeRun(): Record<string, unknown> {
  return {
    runId: GENERATED_RUN_ID,
    appName: GENERATED_PACKAGE,
    pluginName: GENERATED_PACKAGE,
    displayName: GENERATED_DISPLAY,
    status: "running",
    pid: null,
    startedAt: "2026-05-29T12:00:00.000Z",
    launchType: "local",
    launchUrl: `/apps/${GENERATED_SLUG}`,
    session: {
      sessionId: GENERATED_SESSION_ID,
      mode: "interactive",
      features: ["messages", "controls"],
    },
    health: {
      ok: true,
      status: "ready",
    },
  };
}

function fakePluginManager(): Record<string, unknown> {
  return {
    refreshRegistry: async () => registryMap(),
    listInstalledPlugins: async () => [
      {
        name: GENERATED_PACKAGE,
        version: "1.0.0",
        installedAt: "2026-05-29T12:00:00.000Z",
      },
    ],
    getRegistryPlugin: async (name: string) =>
      registryMap().get(name) ??
      [...registryMap().values()].find(
        (entry) => record(entry.appMeta)?.slug === name,
      ) ??
      null,
    searchRegistry: async (query: string, limit = 20) => {
      const needle = query.trim().toLowerCase();
      return [...registryMap().values()]
        .filter((entry) =>
          [entry.name, entry.displayName, record(entry.appMeta)?.slug].some(
            (value) =>
              typeof value === "string"
                ? value.toLowerCase().includes(needle)
                : false,
          ),
        )
        .slice(0, limit);
    },
    installPlugin: async (pluginName: string) => ({
      success: true,
      pluginName,
      version: "1.0.0",
      installPath: appDirectory(ACTION_APPS_ROOT, GENERATED_SLUG),
      requiresRestart: false,
    }),
    uninstallPlugin: async (pluginName: string) => ({
      success: true,
      pluginName,
      requiresRestart: false,
    }),
    listEjectedPlugins: async () => [],
    ejectPlugin: async (pluginName: string) => ({
      success: true,
      pluginName,
      ejectedPath: "",
      requiresRestart: false,
    }),
    syncPlugin: async (pluginName: string) => ({
      success: true,
      pluginName,
      ejectedPath: "",
      requiresRestart: false,
    }),
    reinjectPlugin: async (pluginName: string) => ({
      success: true,
      pluginName,
      removedPath: "",
      requiresRestart: false,
    }),
  };
}

function fakeAppManager(): Record<string, unknown> {
  return {
    listAvailable: async () => scenarioCatalogTiles(),
    search: async (_pluginManager: unknown, query: string, limit = 20) => {
      const needle = query.trim().toLowerCase();
      return scenarioCatalogTiles()
        .filter((tile) =>
          [tile.name, tile.slug, tile.displayName].some((value) =>
            typeof value === "string"
              ? value.toLowerCase().includes(needle)
              : false,
          ),
        )
        .slice(0, limit);
    },
    listInstalled: async () => scenarioCatalogTiles(),
    listRuns: async () => [...appRuns.values()],
    getRun: async (runId: string) => appRuns.get(runId) ?? null,
    attachRun: async (runId: string) => ({
      success: appRuns.has(runId),
      run: appRuns.get(runId) ?? null,
    }),
    detachRun: async (runId: string) => ({
      success: appRuns.has(runId),
      runId,
    }),
    launch: async (_pluginManager: unknown, name: string) => {
      const known =
        name === GENERATED_PACKAGE ||
        name === GENERATED_SLUG ||
        name === GENERATED_DISPLAY;
      if (!known) {
        return {
          success: false,
          message: `Unknown deterministic app: ${name}`,
          appName: name,
        };
      }
      const run = makeRun();
      appRuns.set(GENERATED_RUN_ID, run);
      return {
        success: true,
        message: `Launched ${GENERATED_DISPLAY}. Run ID: ${GENERATED_RUN_ID}.`,
        appName: GENERATED_PACKAGE,
        run,
      };
    },
    stop: async (_pluginManager: unknown, name: string, runId?: string) => {
      const targetRunId = runId ?? GENERATED_RUN_ID;
      const existed = appRuns.delete(targetRunId);
      return {
        success: existed,
        message: existed
          ? `Stopped ${GENERATED_DISPLAY}.`
          : `App run "${targetRunId}" not found.`,
        appName: name || GENERATED_PACKAGE,
        runId: targetRunId,
      };
    },
    recordHeartbeat: (runId: string) => {
      const run = appRuns.get(runId);
      if (run) run.lastHeartbeatAt = "2026-05-29T12:00:05.000Z";
      return run ?? null;
    },
    startStaleRunSweeper: () => {},
    getInfo: async (_pluginManager: unknown, name: string) => {
      const slug =
        name === GENERATED_PACKAGE || name === GENERATED_DISPLAY
          ? GENERATED_SLUG
          : name;
      return catalogTile(slug);
    },
  };
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 500): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

async function readJsonBody<T extends object>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  // The scenario API server (executor augmentRequest, #10757) drains the
  // request stream up front and caches the bytes under core's shared symbol
  // so route handlers never re-read a consumed socket. Read the cache first;
  // stream only when this handler receives an untouched request.
  const cachedBody = (req as unknown as Record<symbol, Buffer | undefined>)[
    Symbol.for("eliza.http.cachedRequestBody")
  ];
  let raw: string;
  if (cachedBody !== undefined) {
    raw = cachedBody.toString("utf8").trim();
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch (err) {
    error(
      res,
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
    return null;
  }
}

function parseBoundedLimit(rawLimit: string | null, fallback = 20): number {
  const parsed =
    typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 50);
}

async function scenarioRouteHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: unknown,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const ctx = {
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    appManager: fakeAppManager(),
    getPluginManager: fakePluginManager,
    parseBoundedLimit,
    readJsonBody,
    json,
    error,
    runtime,
    developerMode: true,
    // POST /api/apps/launch is role-gated (canLaunchApps). The real host
    // (packages/agent/src/api/server.ts) passes OWNER for authorized local
    // requests; this scenario models that authorized dashboard session.
    actorRole: "OWNER",
    broadcastWs: (payload: object) => viewBroadcastLedger.push(payload),
  };

  if (await handleAppsRoutes(ctx as never)) return;
  if (await handleAppPackageRoutes(ctx as never)) return;
  if (await handleViewsRoutes(ctx as never)) return;
  error(res, `No generated-app route handled ${method} ${url.pathname}`, 404);
}

function registerScenarioApiRoutes(runtime: RuntimeWithRoutes): void {
  const routes = runtime.routes ?? [];
  runtime.routes = routes.filter(
    (route) => route.__scenarioGeneratedAppRoutes !== true,
  );
  for (const [type, routePath] of scenarioApiRoutePaths) {
    runtime.routes.push({
      type,
      path: routePath,
      handler: scenarioRouteHandler,
      __scenarioGeneratedAppRoutes: true,
    });
  }
}

function registerGeneratedRouteModule(): void {
  registerRuntimeAppRouteModule(GENERATED_PACKAGE, {
    handleAppRoutes: async (ctx) => {
      const event: Record<string, unknown> = {
        method: ctx.method,
        pathname: ctx.pathname,
      };

      if (
        ctx.method === "GET" &&
        ctx.pathname === `/api/apps/${GENERATED_SLUG}/ping`
      ) {
        packageRouteLedger.push({ ...event, kind: "ping" });
        ctx.json(ctx.res, {
          ok: true,
          slug: GENERATED_SLUG,
          method: "GET",
          route: "ping",
        });
        return true;
      }

      if (
        ctx.method === "POST" &&
        ctx.pathname ===
          `/api/apps/${GENERATED_SLUG}/session/${GENERATED_SESSION_ID}/message`
      ) {
        const body = await ctx.readJsonBody();
        packageRouteLedger.push({ ...event, kind: "message", body });
        ctx.json(
          ctx.res,
          {
            ok: true,
            success: true,
            disposition: "queued",
            message: "Generated Console queued message.",
            echo: body,
          },
          202,
        );
        return true;
      }

      if (
        ctx.method === "POST" &&
        ctx.pathname ===
          `/api/apps/${GENERATED_SLUG}/session/${GENERATED_SESSION_ID}/control`
      ) {
        const body = await ctx.readJsonBody();
        packageRouteLedger.push({ ...event, kind: "control", body });
        ctx.json(ctx.res, {
          ok: true,
          success: true,
          disposition: "accepted",
          message: "Generated Console accepted control.",
          echo: body,
        });
        return true;
      }

      return false;
    },
  });
}

async function ensureRealAppRegistryService(
  runtime: RuntimeWithRoutes,
): Promise<void> {
  const prototypeGetService = Object.getPrototypeOf(runtime)?.getService;
  const baseGetService =
    typeof prototypeGetService === "function"
      ? prototypeGetService.bind(runtime)
      : runtime.getService?.bind(runtime);
  const currentGetService = runtime.getService?.bind(runtime);
  if (baseGetService?.("app-registry")) {
    runtime.getService = (serviceType: string) => {
      if (serviceType === "app-registry") return baseGetService(serviceType);
      return currentGetService?.(serviceType) ?? baseGetService?.(serviceType);
    };
    return;
  }

  await runtime.registerPlugin?.(appControlPlugin);

  if (runtime.hasService?.("app-registry") !== true) {
    for (const service of appControlPlugin.services ?? []) {
      await runtime.registerService?.(service);
    }
  }

  await runtime.getServiceLoadPromise?.("app-registry");
  runtime.getService = (serviceType: string) => {
    if (serviceType === "app-registry") {
      return baseGetService?.(serviceType) ?? currentGetService?.(serviceType);
    }
    return currentGetService?.(serviceType) ?? baseGetService?.(serviceType);
  };
}

async function prepareScenarioState(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  try {
    previousElizaStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = STATE_DIR;
    scenarioRuntime = null;
    appRuns.clear();
    packageRouteLedger.length = 0;
    viewBroadcastLedger.length = 0;
    resetAppControlHttpLoopback();
    await fs.rm(SCENARIO_TEMP_ROOT, { recursive: true, force: true });
    await fs.mkdir(ACTION_APPS_ROOT, { recursive: true });
    await fs.mkdir(HTTP_APPS_ROOT, { recursive: true });
    await writeAppPackage({
      root: ACTION_APPS_ROOT,
      packageName: GENERATED_PACKAGE,
      slug: GENERATED_SLUG,
      displayName: GENERATED_DISPLAY,
      aliases: ["generated", "gen-console"],
    });
    await writeAppPackage({
      root: HTTP_APPS_ROOT,
      packageName: HTTP_PACKAGE,
      slug: HTTP_SLUG,
      displayName: HTTP_DISPLAY,
      aliases: ["http-generated"],
    });
    const runtime = ctx.runtime as RuntimeWithRoutes;
    scenarioRuntime = runtime;
    await ensureRealAppRegistryService(runtime);
    registerScenarioApiRoutes(runtime);
    registerGeneratedRouteModule();
    await registerPluginViews(
      appControlPlugin,
      APP_CONTROL_PLUGIN_DIR,
      ctx.runtime as never,
    );
    return undefined;
  } catch (err) {
    restoreStateDirEnv();
    return err instanceof Error ? err.message : String(err);
  }
}

function expectActionLoadTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "APP",
  ) as CapturedAction | undefined;
  if (!action) {
    return "expected APP action to be captured";
  }
  const result = record(action.result);
  if (result?.success !== true) {
    return `APP action did not succeed: ${JSON.stringify(action.result)}`;
  }
  const values = record(result.values);
  if (values?.registeredCount !== 1) {
    return `expected registeredCount=1, saw ${JSON.stringify(values)}`;
  }
  const data = record(result.data);
  const registered = arrayOfRecords(data?.registered);
  const loaded = registered.find((entry) => entry.slug === GENERATED_SLUG);
  if (!loaded) {
    return `expected data.registered to include ${GENERATED_SLUG}, saw ${JSON.stringify(registered)}`;
  }
  if (loaded.canonicalName !== GENERATED_PACKAGE) {
    return `expected canonicalName=${GENERATED_PACKAGE}, saw ${String(loaded.canonicalName)}`;
  }
  if (!String(execution.responseText ?? "").includes(GENERATED_DISPLAY)) {
    return `expected response text to mention ${GENERATED_DISPLAY}`;
  }
  return undefined;
}

function expectCatalog(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const apps = arrayOfRecords(body);
  const app = apps.find((candidate) => candidate.slug === GENERATED_SLUG);
  if (!app) {
    return `expected catalog to include ${GENERATED_SLUG}, saw ${JSON.stringify(body)}`;
  }
  if (app.name !== GENERATED_PACKAGE) {
    return `expected catalog name=${GENERATED_PACKAGE}, saw ${String(app.name)}`;
  }
  if (app.heroImage !== `/api/apps/hero/${GENERATED_SLUG}`) {
    return `expected generated hero URL, saw ${String(app.heroImage)}`;
  }
  return undefined;
}

function expectHero(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (
    !text.includes("<svg") ||
    !text.includes(`<title>${GENERATED_DISPLAY}</title>`)
  ) {
    return `expected generated SVG hero with title ${GENERATED_DISPLAY}`;
  }
  return undefined;
}

function expectPackagePing(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const response = record(body);
  if (response?.ok !== true || response.slug !== GENERATED_SLUG) {
    return `expected generated package route ping JSON, saw ${JSON.stringify(body)}`;
  }
  return undefined;
}

function expectLaunch(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const response = record(body);
  const run = record(response?.run);
  if (response?.success !== true || run?.runId !== GENERATED_RUN_ID) {
    return `expected launch result with runId=${GENERATED_RUN_ID}, saw ${JSON.stringify(body)}`;
  }
  return undefined;
}

function expectRunMessage(status: number, body: unknown): string | undefined {
  if (status !== 202) return `expected 202 queued, saw ${status}`;
  const response = record(body);
  const session = record(response?.session);
  if (
    response?.success !== true ||
    response.disposition !== "queued" ||
    session?.sessionId !== GENERATED_SESSION_ID
  ) {
    return `expected queued run message response, saw ${JSON.stringify(body)}`;
  }
  return undefined;
}

function expectRunControl(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const response = record(body);
  if (response?.success !== true || response.disposition !== "accepted") {
    return `expected accepted run control response, saw ${JSON.stringify(body)}`;
  }
  return undefined;
}

function expectHttpLoad(status: number, body: unknown): string | undefined {
  if (status !== 200) return `expected 200, saw ${status}`;
  const response = record(body);
  const items = arrayOfRecords(response?.items);
  const loaded = items.find((item) => item.slug === HTTP_SLUG);
  if (response?.ok !== true || response.registered !== 1 || !loaded) {
    return `expected HTTP load endpoint to register ${HTTP_SLUG}, saw ${JSON.stringify(body)}`;
  }
  if (loaded.canonicalName !== HTTP_PACKAGE) {
    return `expected HTTP canonicalName=${HTTP_PACKAGE}, saw ${String(loaded.canonicalName)}`;
  }
  return undefined;
}

function expectViewsList(
  viewType: "gui" | "tui",
): (status: number, body: unknown) => string | undefined {
  return (status, body) => {
    if (status !== 200) return `expected 200, saw ${status}`;
    const views = arrayOfRecords(record(body)?.views);
    // The views-manager ships GUI-only (#15269): "tui"/"xr" stay valid
    // compatibility modalities but are no longer declared, so no tui-typed
    // entry is registered. `listViews` still surfaces the manager in the TUI
    // list as its GUI fallback (it returns DEFAULT_VIEW_TYPE when the requested
    // modality has no dedicated registration), so the entry reports
    // viewType="gui" in both lists while its terminal capabilities remain
    // reachable for headless server-interact.
    const view = views.find((candidate) => candidate.id === "views-manager");
    if (!view) {
      return `expected views-manager in ${viewType} list, saw ${JSON.stringify(body)}`;
    }
    if (view.viewType !== "gui") {
      return `expected gui-only views-manager viewType, saw ${String(view.viewType)}`;
    }
    if (view.pluginName !== appControlPlugin.name) {
      return `expected pluginName=${appControlPlugin.name}, saw ${String(view.pluginName)}`;
    }
    if (viewType === "tui" && !Array.isArray(view.capabilities)) {
      return "expected TUI views-manager capabilities";
    }
    return undefined;
  };
}

async function finalGeneratedAppCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const failures: string[] = [];
  try {
    const runtime =
      (ctx.runtime as RuntimeWithRoutes | undefined) ?? scenarioRuntime;
    if (!runtime) {
      return "Scenario runtime was not available for final checks";
    }
    const registry = record(runtime.getService?.("app-registry")) as {
      list?: () => Promise<unknown>;
    } | null;
    if (typeof registry?.list !== "function") {
      failures.push("AppRegistryService was not registered on the runtime");
    } else {
      const entries = arrayOfRecords(await registry.list());
      const generated = entries.find((entry) => entry.slug === GENERATED_SLUG);
      const httpLoaded = entries.find((entry) => entry.slug === HTTP_SLUG);
      if (!generated) {
        failures.push(`registry.list() did not include ${GENERATED_SLUG}`);
      } else {
        if (generated.canonicalName !== GENERATED_PACKAGE) {
          failures.push(
            `registry ${GENERATED_SLUG} canonicalName=${String(generated.canonicalName)}`,
          );
        }
        if (generated.trust !== "external") {
          failures.push(
            `registry ${GENERATED_SLUG} trust=${String(generated.trust)}`,
          );
        }
        if (generated.isolation !== "worker") {
          failures.push(
            `registry ${GENERATED_SLUG} isolation=${String(generated.isolation)}`,
          );
        }
        const aliases = Array.isArray(generated.aliases)
          ? generated.aliases
          : [];
        if (
          !aliases.includes("generated") ||
          !aliases.includes("gen-console")
        ) {
          failures.push(
            `registry ${GENERATED_SLUG} aliases missing exact manifest aliases`,
          );
        }
      }
      if (!httpLoaded || httpLoaded.canonicalName !== HTTP_PACKAGE) {
        failures.push(
          `registry.list() did not include HTTP-loaded ${HTTP_SLUG}`,
        );
      }
    }

    const definitions = getCuratedAppDefinitions();
    const generatedDefinition = definitions.find(
      (definition) => definition.slug === GENERATED_SLUG,
    );
    const httpDefinition = definitions.find(
      (definition) => definition.slug === HTTP_SLUG,
    );
    if (generatedDefinition?.canonicalName !== GENERATED_PACKAGE) {
      failures.push(
        `curated definitions missing ${GENERATED_SLUG}:${GENERATED_PACKAGE}`,
      );
    }
    if (httpDefinition?.canonicalName !== HTTP_PACKAGE) {
      failures.push(`curated definitions missing ${HTTP_SLUG}:${HTTP_PACKAGE}`);
    }

    for (const kind of ["ping", "message", "control"] as const) {
      if (!packageRouteLedger.some((entry) => entry.kind === kind)) {
        failures.push(`runtime app route module did not receive ${kind}`);
      }
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    unregisterRuntimeAppRouteModule(GENERATED_PACKAGE);
    scenarioRuntime = null;
    restoreStateDirEnv();
    await fs
      .rm(SCENARIO_TEMP_ROOT, { recursive: true, force: true })
      .catch((err) => {
        failures.push(
          `failed to clean scenario temp root: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
  return failures.length > 0 ? failures.join("\n") : undefined;
}

export default scenario({
  id: "deterministic-generated-app-routes",
  lane: "pr-deterministic",
  title: "Real generated app registry, catalog tile, hero, and route dispatch",
  domain: "app-runtime",
  status: "active",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "create throwaway generated app packages and wire real app routes",
      apply: prepareScenarioState,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "APP load_from_directory registers a real generated app",
      actionName: "APP",
      text: "load generated apps from a directory",
      options: {
        action: "load_from_directory",
        directory: ACTION_APPS_ROOT,
      },
      assertTurn: expectActionLoadTurn,
    },
    {
      kind: "api",
      name: "generated app appears in catalog tile data",
      method: "GET",
      path: "/api/apps",
      expectedStatus: 200,
      assertResponse: expectCatalog,
    },
    {
      kind: "api",
      name: "generated app hero route returns generated SVG",
      method: "GET",
      path: `/api/apps/hero/${GENERATED_SLUG}`,
      expectedStatus: 200,
      assertResponse: expectHero,
    },
    {
      kind: "api",
      name: "generated app package route dispatches to runtime module",
      method: "GET",
      path: `/api/apps/${GENERATED_SLUG}/ping`,
      expectedStatus: 200,
      assertResponse: expectPackagePing,
    },
    {
      kind: "api",
      name: "generated app launches with session metadata",
      method: "POST",
      path: "/api/apps/launch",
      body: { name: GENERATED_PACKAGE },
      expectedStatus: 200,
      assertResponse: expectLaunch,
    },
    {
      kind: "api",
      name: "run message routes through generated package session endpoint",
      method: "POST",
      path: `/api/apps/runs/${GENERATED_RUN_ID}/message`,
      body: { content: "inspect generated app state" },
      expectedStatus: 202,
      assertResponse: expectRunMessage,
    },
    {
      kind: "api",
      name: "run control routes through generated package session endpoint",
      method: "POST",
      path: `/api/apps/runs/${GENERATED_RUN_ID}/control`,
      body: { action: "pause" },
      expectedStatus: 200,
      assertResponse: expectRunControl,
    },
    {
      kind: "api",
      name: "HTTP load-from-directory endpoint uses the real registry service",
      method: "POST",
      path: "/api/apps/load-from-directory",
      body: { directory: HTTP_APPS_ROOT },
      expectedStatus: 200,
      assertResponse: expectHttpLoad,
    },
    {
      kind: "api",
      name: "app-control GUI view is registered in the real views registry",
      method: "GET",
      path: "/api/views?viewType=gui",
      expectedStatus: 200,
      assertResponse: expectViewsList("gui"),
    },
    {
      kind: "api",
      name: "app-control views-manager surfaces in the TUI list as its GUI fallback",
      method: "GET",
      path: "/api/views?viewType=tui",
      expectedStatus: 200,
      assertResponse: expectViewsList("tui"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "real AppRegistryService, curated catalog, and package route ledger are exact",
      predicate: finalGeneratedAppCheck,
    },
  ],
});
