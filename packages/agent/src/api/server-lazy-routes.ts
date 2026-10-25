/**
 * Lazy route-group dispatch wrappers for the agent HTTP surface. Each exported
 * `handle*Routes` shim first checks the request method/pathname against a cheap
 * static guard and only on a match dynamically `import()`s the real route
 * module, keeping the ~38 route modules (and the plugins they pull in) out of
 * the static boot graph so each loads on first hit rather than every boot. Also
 * uses the shared plugin-route matcher for lazy-load and public-route gates.
 */

import type { AgentRuntime } from "@elizaos/core";
import { getHttpRuntime, type Route } from "@elizaos/host/protocol";

import { matchPluginRoutePath } from "./plugin-route-path.ts";

type RouteContext = {
  method: string;
  pathname: string;
};
type RuntimeRouteOptions = {
  method: string;
  pathname: string;
  runtime: AgentRuntime | null | undefined;
};
function routeContext(args: readonly unknown[]): RouteContext | null {
  const value = args[0];
  if (!value || typeof value !== "object") return null;
  const ctx = value as Partial<RouteContext>;
  if (typeof ctx.method !== "string" || typeof ctx.pathname !== "string") {
    return null;
  }
  return { method: ctx.method, pathname: ctx.pathname };
}
/** Keep module loading behind the same cheap path guard in every adapter. */
function lazyRoute<Args extends unknown[]>(
  matches: (context: RouteContext | null) => boolean,
  load: () => Promise<(...args: Args) => Promise<boolean>>,
): (...args: Args) => Promise<boolean> {
  return async (...args) => {
    if (!matches(routeContext(args))) return false;
    return (await load())(...args);
  };
}
function matchesRuntimeRoute({
  method,
  pathname,
  runtime,
}: RuntimeRouteOptions): boolean {
  if (!runtime || !getHttpRuntime(runtime).routes.length) return false;
  const upper = method.toUpperCase();
  return (getHttpRuntime(runtime).routes as Route[]).some((route) => {
    if (route.type === "STATIC" || route.type !== upper) return false;
    return matchPluginRoutePath(route.path, pathname) !== null;
  });
}
function matchesHonoRuntimeRoute({
  method,
  pathname,
  runtime,
}: RuntimeRouteOptions): boolean {
  if (!runtime || !getHttpRuntime(runtime).routes.length) return false;
  const upper = method.toUpperCase();
  return (getHttpRuntime(runtime).routes as Route[]).some((route) => {
    if (route.type === "STATIC" || route.type !== upper) return false;
    if (!route.routeHandler) return false;
    return matchPluginRoutePath(route.path, pathname) !== null;
  });
}
export function isPublicRuntimePluginRoute(options: {
  runtime: AgentRuntime | null | undefined;
  method: string;
  pathname: string;
}): boolean {
  const { runtime, method, pathname } = options;
  if (!runtime || !getHttpRuntime(runtime).routes.length) return false;
  const upper = method.toUpperCase();
  return (getHttpRuntime(runtime).routes as Route[]).some((route) => {
    if (
      route.type === "STATIC" ||
      route.type !== upper ||
      route.public !== true
    ) {
      return false;
    }
    return matchPluginRoutePath(route.path, pathname) !== null;
  });
}

export const handleAccountsRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname.startsWith("/api/accounts") ||
      ctx.pathname.startsWith("/api/providers")),
  async () => (await import("./accounts-routes.ts")).handleAccountsRoutes,
);

export const handleAgentAdminRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname === "/api/agent/restart" ||
      ctx.pathname === "/api/agent/reset"),
  async () => (await import("./agent-admin-routes.ts")).handleAgentAdminRoutes,
);

export const handleAgentLifecycleRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    [
      "/api/agent/start",
      "/api/agent/stop",
      "/api/agent/pause",
      "/api/agent/resume",
      "/api/agent/autonomy",
    ].includes(ctx.pathname),
  async () =>
    (await import("./agent-lifecycle-routes.ts")).handleAgentLifecycleRoutes,
);

export const handleAgentStatusRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname === "/api/agent/self-status" ||
      ctx.pathname.startsWith("/api/registry")),
  async () =>
    (await import("./agent-status-routes.ts")).handleAgentStatusRoutes,
);

export const handleAgentTransferRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    [
      "/api/agent/export",
      "/api/agent/export/estimate",
      "/api/agent/import",
    ].includes(ctx.pathname),
  async () =>
    (await import("./agent-transfer-routes.ts")).handleAgentTransferRoutes,
);

export const handleAppPackageRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/apps/")),
  async () => (await import("./app-package-routes.ts")).handleAppPackageRoutes,
);

export const handleAuthRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/auth/")),
  async () => (await import("./auth-routes.ts")).handleAuthRoutes,
);

export const handleAvatarRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/avatar/")),
  async () => (await import("./avatar-routes.ts")).handleAvatarRoutes,
);

export const handleInteractionsRoutes = lazyRoute(
  (ctx) =>
    ctx?.pathname === "/api/interactions/shortcut" ||
    ctx?.pathname === "/api/interactions/composer",
  async () =>
    (await import("./interactions-routes.ts")).handleInteractionsRoutes,
);

export const handleBackgroundTasksRoute = lazyRoute(
  (ctx) => ctx?.pathname === "/api/background/run-due-tasks",
  async () =>
    (await import("./background-tasks-routes.ts")).handleBackgroundTasksRoute,
);

export const handleBugReportRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname === "/api/bug-report" ||
      ctx.pathname === "/api/bug-report/info"),
  async () => (await import("./bug-report-routes.ts")).handleBugReportRoutes,
);

export const handleCharacterRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/character")),
  async () => (await import("./character-routes.ts")).handleCharacterRoutes,
);

export const handleConfigRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    ["/api/config", "/api/config/schema", "/api/config/reload"].includes(
      ctx.pathname,
    ),
  async () => (await import("./config-routes.ts")).handleConfigRoutes,
);

export const handleConnectorRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/connectors")),
  async () => (await import("./connector-routes.ts")).handleConnectorRoutes,
);

export const handleDiagnosticsRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname.startsWith("/api/logs") ||
      ctx.pathname === "/api/agent/events" ||
      ctx.pathname === "/api/security/audit"),
  async () => (await import("./diagnostics-routes.ts")).handleDiagnosticsRoutes,
);

export const handleFirstRunRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname.startsWith("/api/first-run") ||
      ctx.pathname === "/api/wallet/keys"),
  async () => (await import("./first-run-routes.ts")).handleFirstRunRoutes,
);

export const handleHealthRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    ["/api/status", "/api/health", "/api/runtime"].includes(ctx.pathname),
  async () => (await import("./health-routes.ts")).handleHealthRoutes,
);

export const handleMemoryRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname.startsWith("/api/memory") ||
      ctx.pathname.startsWith("/api/memories") ||
      ctx.pathname === "/api/context/quick"),
  async () => (await import("./memory-routes.ts")).handleMemoryRoutes,
);

export const handleMiscRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname === "/api/restart" ||
      ctx.pathname === "/api/location/approximate" ||
      ctx.pathname === "/api/ingest/share" ||
      ctx.pathname === "/api/agent/event" ||
      /^\/api\/agents\/[^/]+\/event$/.test(ctx.pathname) ||
      ctx.pathname === "/api/terminal/run" ||
      ctx.pathname.startsWith("/api/custom-actions")),
  async () => (await import("./misc-routes.ts")).handleMiscRoutes,
);
export const handleTrajectoryManagementRoutes = lazyRoute(
  (ctx) =>
    ctx !== null &&
    (ctx.pathname === "/api/trajectories/config" ||
      ctx.pathname === "/api/trajectories/export" ||
      (ctx.pathname === "/api/trajectories" && ctx.method === "DELETE")),
  async () =>
    (await import("./trajectory-management-routes.ts"))
      .handleTrajectoryManagementRoutes,
);
type HostSettingsRoutesModule = typeof import("./host-settings-routes.ts");
export async function handleHostSettingsRoutes(
  ...args: Parameters<HostSettingsRoutesModule["handleHostSettingsRoutes"]>
): ReturnType<HostSettingsRoutesModule["handleHostSettingsRoutes"]> {
  const pathname = args[2];
  if (pathname !== "/api/runtime/mode" && pathname !== "/api/stream/settings") {
    return false;
  }
  return (await import("./host-settings-routes.ts")).handleHostSettingsRoutes(
    ...args,
  );
}

export const handleModelsRoutes = lazyRoute(
  (ctx) => ctx?.pathname === "/api/models",
  async () => (await import("./models-routes.ts")).handleModelsRoutes,
);

export const handleModelConfigRoutes = lazyRoute(
  (ctx) => ctx?.pathname === "/api/models/config",
  async () =>
    (await import("./model-config-routes.ts")).handleModelConfigRoutes,
);
type LifeOpsInboxFallbackModule =
  typeof import("./lifeops-inbox-fallback-routes.ts");
export async function tryHandleLifeOpsInboxFallbackLazy(
  ...args: Parameters<
    LifeOpsInboxFallbackModule["tryHandleLifeOpsInboxFallback"]
  >
): Promise<boolean> {
  const options = args[0] as
    | {
        pathname?: string;
      }
    | undefined;
  if (options?.pathname !== "/api/lifeops/inbox") return false;
  return (
    await import("./lifeops-inbox-fallback-routes.ts")
  ).tryHandleLifeOpsInboxFallback(...args);
}

export const handlePermissionRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/permissions")),
  async () => (await import("./permissions-routes.ts")).handlePermissionRoutes,
);

export const handleProjectRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/projects")),
  async () => (await import("./project-routes.ts")).handleProjectRoutes,
);
export const handlePermissionsExtraRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/permissions/")),
  async () =>
    (await import("./permissions-routes-extra.ts"))
      .handlePermissionsExtraRoutes,
);

export const handleProviderSwitchRoutes = lazyRoute(
  (ctx) => ctx?.pathname === "/api/provider/switch",
  async () =>
    (await import("./provider-switch-routes.ts")).handleProviderSwitchRoutes,
);

export const handleRegistryRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/registry")),
  async () => (await import("./registry-routes.ts")).handleRegistryRoutes,
);

export const handleRelationshipsRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/relationships")),
  async () =>
    (await import("./relationships-routes.ts")).handleRelationshipsRoutes,
);
export const handleRemoteCapabilityRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/capability-router")),
  async () =>
    (await import("./remote-capability-routes.ts"))
      .handleRemoteCapabilityRoutes,
);

export const handleInboxAndCloudRelayRouteGroup: RouteDispatchModule["handleInboxAndCloudRelayRouteGroup"] =
  lazyRoute(
    (ctx) =>
      ctx !== null &&
      (ctx.pathname.startsWith("/api/notifications") ||
        ctx.pathname.startsWith("/api/inbox") ||
        ctx.pathname === "/api/approvals" ||
        ctx.pathname === "/api/cloud/relay-status"),
    async () =>
      (await import("./server-route-dispatch.ts"))
        .handleInboxAndCloudRelayRouteGroup,
  );
export const handleCloudAndCoreRouteGroup: RouteDispatchModule["handleCloudAndCoreRouteGroup"] =
  lazyRoute(
    (ctx) => Boolean(ctx?.pathname.startsWith("/api/cloud/")),
    async () =>
      (await import("./server-route-dispatch.ts")).handleCloudAndCoreRouteGroup,
  );
export const handleSandboxRouteGroup: RouteDispatchModule["handleSandboxRouteGroup"] =
  lazyRoute(
    (ctx) => Boolean(ctx?.pathname.startsWith("/api/sandbox")),
    async () =>
      (await import("./server-route-dispatch.ts")).handleSandboxRouteGroup,
  );
export const handleConversationRouteGroup: RouteDispatchModule["handleConversationRouteGroup"] =
  lazyRoute(
    (ctx) =>
      ctx !== null &&
      (ctx.pathname.startsWith("/api/conversations") ||
        ctx.pathname.startsWith("/v1/") ||
        (ctx.method === "POST" &&
          /^\/api\/agents\/[^/]+\/message$/.test(ctx.pathname))),
    async () =>
      (await import("./server-route-dispatch.ts")).handleConversationRouteGroup,
  );
type RouteDispatchModule = typeof import("./server-route-dispatch.ts");
export async function handleDatabaseRouteGroup(
  ...args: Parameters<RouteDispatchModule["handleDatabaseRouteGroup"]>
): ReturnType<RouteDispatchModule["handleDatabaseRouteGroup"]> {
  // This route group receives pathname and req, not a separate method field.
  if (!args[0]?.pathname.startsWith("/api/database/")) return false;
  return (await import("./server-route-dispatch.ts")).handleDatabaseRouteGroup(
    ...args,
  );
}
export async function handleLifeOpsRuntimePluginRoute(
  ...args: Parameters<RouteDispatchModule["handleLifeOpsRuntimePluginRoute"]>
): ReturnType<RouteDispatchModule["handleLifeOpsRuntimePluginRoute"]> {
  const ctx = routeContext(args);
  const state = (
    args[0] as {
      state?: {
        runtime?: AgentRuntime | null;
      };
    }
  )?.state;
  if (
    !ctx ||
    !matchesRuntimeRoute({
      method: ctx.method,
      pathname: ctx.pathname,
      runtime: state?.runtime,
    })
  ) {
    return false;
  }
  return (
    await import("./server-route-dispatch.ts")
  ).handleLifeOpsRuntimePluginRoute(...args);
}

export const handleSubscriptionRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/subscription/")),
  async () =>
    (await import("./subscription-routes.ts")).handleSubscriptionRoutes,
);

export const handleUpdateRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/update/")),
  async () => (await import("./update-routes.ts")).handleUpdateRoutes,
);
type ViewsRoutesModule = typeof import("./views-routes.ts");
export async function handleViewsRoutes(
  ...args: Parameters<ViewsRoutesModule["handleViewsRoutes"]>
): ReturnType<ViewsRoutesModule["handleViewsRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/views")) return false;
  const { handleViewsRoutes } = await import("./views-routes.ts");
  const runtime = args[0].runtime;
  if (runtime)
    (await import("./views-registry.ts")).registerBuiltinViews(runtime);
  return handleViewsRoutes(...args);
}
export async function registerBuiltinViews(
  runtime?: import("@elizaos/core").IAgentRuntime | null,
): Promise<void> {
  if (!runtime) return;
  (await import("./views-registry.ts")).registerBuiltinViews(runtime);
  // Register the built-in shell views' scoped actions once the runtime exists.
  // The Character view declares FILL_BIO / ADD_STYLE_RULE / ADD_MESSAGE_EXAMPLE
  // (#14155); other builtin views carry none yet. registerViewScopedActions is
  // idempotent, so re-running on reload reconciles the builtin set cleanly.
  if (runtime) {
    const { BUILTIN_VIEWS } = await import("./builtin-views.ts");
    const { registerViewScopedActions } = await import(
      "../runtime/view-scoped-actions.ts"
    );
    registerViewScopedActions(runtime, "@elizaos/builtin", BUILTIN_VIEWS);
  }
}

export const handleWorkbenchRoutes = lazyRoute(
  (ctx) => Boolean(ctx?.pathname.startsWith("/api/workbench")),
  async () => (await import("./workbench-routes.ts")).handleWorkbenchRoutes,
);
type RuntimePluginRoutesModule = typeof import("./runtime-plugin-routes.ts");
export async function tryHandleRuntimePluginRoute(
  ...args: Parameters<RuntimePluginRoutesModule["tryHandleRuntimePluginRoute"]>
): ReturnType<RuntimePluginRoutesModule["tryHandleRuntimePluginRoute"]> {
  const options = args[0];
  if (!matchesRuntimeRoute(options)) return false;
  return (
    await import("./runtime-plugin-routes.ts")
  ).tryHandleRuntimePluginRoute(...args);
}
type HonoMountModule = typeof import("./hono-mount.ts");
export async function tryHandleHonoRuntimeRoute(
  ...args: Parameters<HonoMountModule["tryHandleHonoRuntimeRoute"]>
): ReturnType<HonoMountModule["tryHandleHonoRuntimeRoute"]> {
  const options = args[0];
  const method = options.req.method ?? "GET";
  const requestUrl = options.req.url ?? "/";
  const pathname = (() => {
    try {
      return new URL(
        requestUrl,
        `http://${options.req.headers.host ?? "localhost"}`,
      ).pathname;
    } catch {
      return requestUrl.split("?")[0] ?? "/";
    }
  })();
  if (
    !matchesHonoRuntimeRoute({
      method,
      pathname,
      runtime: options.runtime as AgentRuntime | null | undefined,
    })
  ) {
    return false;
  }
  return (await import("./hono-mount.ts")).tryHandleHonoRuntimeRoute(...args);
}
export async function extractConversationMetadataFromRoom(
  ...args: Parameters<
    typeof import("./conversation-metadata.ts")["extractConversationMetadataFromRoom"]
  >
): Promise<
  ReturnType<
    typeof import("./conversation-metadata.ts")["extractConversationMetadataFromRoom"]
  >
> {
  return (
    await import("./conversation-metadata.ts")
  ).extractConversationMetadataFromRoom(...args);
}
export async function createConnectorHealthMonitor(
  ...args: ConstructorParameters<
    typeof import("./connector-health.ts")["ConnectorHealthMonitor"]
  >
): Promise<
  InstanceType<typeof import("./connector-health.ts")["ConnectorHealthMonitor"]>
> {
  const { ConnectorHealthMonitor } = await import("./connector-health.ts");
  return new ConnectorHealthMonitor(...args);
}
