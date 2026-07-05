/**
 * Lazy route-group dispatch wrappers for the agent HTTP surface. Each exported
 * `handle*Routes` shim first checks the request method/pathname against a cheap
 * static guard and only on a match dynamically `import()`s the real route
 * module, keeping the ~38 route modules (and the plugins they pull in) out of
 * the static boot graph so each loads on first hit rather than every boot. Also
 * carries the plugin-route path matcher (`matchPluginRoutePath`) and the
 * public-route predicate that decides which runtime plugin routes skip auth.
 */
import type { AgentRuntime, Route } from "@elizaos/core";

type RouteContext = {
  method: string;
  pathname: string;
};

type RuntimeRouteOptions = {
  method: string;
  pathname: string;
  runtime: AgentRuntime | null | undefined;
};

// Builtin views are registered once at startup (server.ts). The per-request
// path below is a safety net for the case where the first /api/views request
// arrives before startup registration completes; gate it so it runs at most
// once instead of on every (hot) nav request.
let builtinViewsRegistered = false;

function routeContext(args: readonly unknown[]): RouteContext | null {
  const value = args[0];
  if (!value || typeof value !== "object") return null;
  const ctx = value as Partial<RouteContext>;
  if (typeof ctx.method !== "string" || typeof ctx.pathname !== "string") {
    return null;
  }
  return { method: ctx.method, pathname: ctx.pathname };
}

function matchesRuntimeRoute({
  method,
  pathname,
  runtime,
}: RuntimeRouteOptions): boolean {
  if (!runtime?.routes?.length) return false;
  const upper = method.toUpperCase();
  return (runtime.routes as Route[]).some((route) => {
    if (route.type === "STATIC" || route.type !== upper) return false;
    return matchPluginRoutePath(route.path, pathname) !== null;
  });
}

function matchesHonoRuntimeRoute({
  method,
  pathname,
  runtime,
}: RuntimeRouteOptions): boolean {
  if (!runtime?.routes?.length) return false;
  const upper = method.toUpperCase();
  return (runtime.routes as Route[]).some((route) => {
    if (route.type === "STATIC" || route.type !== upper) return false;
    if (!route.routeHandler) return false;
    return matchPluginRoutePath(route.path, pathname) !== null;
  });
}

function matchPluginRoutePath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const norm = (p: string) => p.split("/").filter((s) => s.length > 0);
  const pSegs = norm(pattern);
  const pathSegs = norm(pathname);
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    const c = pathSegs[i];
    if (!p) return null;
    if (p.startsWith(":") && p.endsWith("*")) {
      const key = p.slice(1, -1);
      const tail = pathSegs.slice(i).join("/");
      if (!tail) return null;
      try {
        params[key] = decodeURIComponent(tail);
      } catch {
        params[key] = tail;
      }
      return params;
    }
    if (c === undefined) return null;
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(c);
      } catch {
        params[p.slice(1)] = c;
      }
    } else if (p !== c) {
      return null;
    }
  }
  return pSegs.length === pathSegs.length ? params : null;
}

export function isPublicRuntimePluginRoute(options: {
  runtime: AgentRuntime | null | undefined;
  method: string;
  pathname: string;
}): boolean {
  const { runtime, method, pathname } = options;
  if (!runtime?.routes?.length) return false;
  const upper = method.toUpperCase();
  return (runtime.routes as Route[]).some((route) => {
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

type AccountsRoutesModule = typeof import("./accounts-routes.ts");
export async function handleAccountsRoutes(
  ...args: Parameters<AccountsRoutesModule["handleAccountsRoutes"]>
): ReturnType<AccountsRoutesModule["handleAccountsRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    (!ctx.pathname.startsWith("/api/accounts") &&
      !ctx.pathname.startsWith("/api/providers"))
  ) {
    return false;
  }
  return (await import("./accounts-routes.ts")).handleAccountsRoutes(...args);
}

type AgentAdminRoutesModule = typeof import("./agent-admin-routes.ts");
export async function handleAgentAdminRoutes(
  ...args: Parameters<AgentAdminRoutesModule["handleAgentAdminRoutes"]>
): ReturnType<AgentAdminRoutesModule["handleAgentAdminRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname === "/api/agent/restart" ||
      ctx.pathname === "/api/agent/reset"
    )
  ) {
    return false;
  }
  return (await import("./agent-admin-routes.ts")).handleAgentAdminRoutes(
    ...args,
  );
}

type AgentLifecycleRoutesModule = typeof import("./agent-lifecycle-routes.ts");
export async function handleAgentLifecycleRoutes(
  ...args: Parameters<AgentLifecycleRoutesModule["handleAgentLifecycleRoutes"]>
): ReturnType<AgentLifecycleRoutesModule["handleAgentLifecycleRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    ![
      "/api/agent/start",
      "/api/agent/stop",
      "/api/agent/pause",
      "/api/agent/resume",
      "/api/agent/autonomy",
    ].includes(ctx.pathname)
  ) {
    return false;
  }
  return (
    await import("./agent-lifecycle-routes.ts")
  ).handleAgentLifecycleRoutes(...args);
}

type AgentStatusRoutesModule = typeof import("./agent-status-routes.ts");
export async function handleAgentStatusRoutes(
  ...args: Parameters<AgentStatusRoutesModule["handleAgentStatusRoutes"]>
): ReturnType<AgentStatusRoutesModule["handleAgentStatusRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname === "/api/agent/self-status" ||
      ctx.pathname.startsWith("/api/registry")
    )
  ) {
    return false;
  }
  return (await import("./agent-status-routes.ts")).handleAgentStatusRoutes(
    ...args,
  );
}

type AgentTransferRoutesModule = typeof import("./agent-transfer-routes.ts");
export async function handleAgentTransferRoutes(
  ...args: Parameters<AgentTransferRoutesModule["handleAgentTransferRoutes"]>
): ReturnType<AgentTransferRoutesModule["handleAgentTransferRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    ![
      "/api/agent/export",
      "/api/agent/export/estimate",
      "/api/agent/import",
    ].includes(ctx.pathname)
  ) {
    return false;
  }
  return (await import("./agent-transfer-routes.ts")).handleAgentTransferRoutes(
    ...args,
  );
}

type AppPackageRoutesModule = typeof import("./app-package-routes.ts");
export async function handleAppPackageRoutes(
  ...args: Parameters<AppPackageRoutesModule["handleAppPackageRoutes"]>
): ReturnType<AppPackageRoutesModule["handleAppPackageRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/apps/")) return false;
  return (await import("./app-package-routes.ts")).handleAppPackageRoutes(
    ...args,
  );
}

type AuthRoutesModule = typeof import("./auth-routes.ts");
export async function handleAuthRoutes(
  ...args: Parameters<AuthRoutesModule["handleAuthRoutes"]>
): ReturnType<AuthRoutesModule["handleAuthRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/auth/")) return false;
  return (await import("./auth-routes.ts")).handleAuthRoutes(...args);
}

type AvatarRoutesModule = typeof import("./avatar-routes.ts");
export async function handleAvatarRoutes(
  ...args: Parameters<AvatarRoutesModule["handleAvatarRoutes"]>
): ReturnType<AvatarRoutesModule["handleAvatarRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/avatar/")) return false;
  return (await import("./avatar-routes.ts")).handleAvatarRoutes(...args);
}

type SuggestionsRoutesModule = typeof import("./suggestions-routes.ts");
export async function handleSuggestionsRoutes(
  ...args: Parameters<SuggestionsRoutesModule["handleSuggestionsRoutes"]>
): ReturnType<SuggestionsRoutesModule["handleSuggestionsRoutes"]> {
  const ctx = routeContext(args);
  if (ctx?.pathname !== "/api/suggestions") return false;
  return (await import("./suggestions-routes.ts")).handleSuggestionsRoutes(
    ...args,
  );
}

type InteractionsRoutesModule = typeof import("./interactions-routes.ts");
export async function handleInteractionsRoutes(
  ...args: Parameters<InteractionsRoutesModule["handleInteractionsRoutes"]>
): ReturnType<InteractionsRoutesModule["handleInteractionsRoutes"]> {
  const ctx = routeContext(args);
  if (ctx?.pathname !== "/api/interactions/shortcut") return false;
  return (await import("./interactions-routes.ts")).handleInteractionsRoutes(
    ...args,
  );
}

type CommandsRoutesModule = typeof import("./commands-routes.ts");
export async function handleCommandsRoutes(
  ...args: Parameters<CommandsRoutesModule["handleCommandsRoutes"]>
): ReturnType<CommandsRoutesModule["handleCommandsRoutes"]> {
  const ctx = routeContext(args);
  if (ctx?.pathname !== "/api/commands") return false;
  return (await import("./commands-routes.ts")).handleCommandsRoutes(...args);
}

type BackgroundTasksRoutesModule =
  typeof import("./background-tasks-routes.ts");
export async function handleBackgroundTasksRoute(
  ...args: Parameters<BackgroundTasksRoutesModule["handleBackgroundTasksRoute"]>
): ReturnType<BackgroundTasksRoutesModule["handleBackgroundTasksRoute"]> {
  const ctx = routeContext(args);
  if (ctx?.pathname !== "/api/background/run-due-tasks") return false;
  return (
    await import("./background-tasks-routes.ts")
  ).handleBackgroundTasksRoute(...args);
}

type BugReportRoutesModule = typeof import("./bug-report-routes.ts");
export async function handleBugReportRoutes(
  ...args: Parameters<BugReportRoutesModule["handleBugReportRoutes"]>
): ReturnType<BugReportRoutesModule["handleBugReportRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname === "/api/bug-report" ||
      ctx.pathname === "/api/bug-report/info"
    )
  ) {
    return false;
  }
  return (await import("./bug-report-routes.ts")).handleBugReportRoutes(
    ...args,
  );
}

type CharacterRoutesModule = typeof import("./character-routes.ts");
export async function handleCharacterRoutes(
  ...args: Parameters<CharacterRoutesModule["handleCharacterRoutes"]>
): ReturnType<CharacterRoutesModule["handleCharacterRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/character")) return false;
  return (await import("./character-routes.ts")).handleCharacterRoutes(...args);
}

type ConfigRoutesModule = typeof import("./config-routes.ts");
export async function handleConfigRoutes(
  ...args: Parameters<ConfigRoutesModule["handleConfigRoutes"]>
): ReturnType<ConfigRoutesModule["handleConfigRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !["/api/config", "/api/config/schema", "/api/config/reload"].includes(
      ctx.pathname,
    )
  ) {
    return false;
  }
  return (await import("./config-routes.ts")).handleConfigRoutes(...args);
}

type ConnectorRoutesModule = typeof import("./connector-routes.ts");
export async function handleConnectorRoutes(
  ...args: Parameters<ConnectorRoutesModule["handleConnectorRoutes"]>
): ReturnType<ConnectorRoutesModule["handleConnectorRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/connectors")) return false;
  return (await import("./connector-routes.ts")).handleConnectorRoutes(...args);
}

type DiagnosticsRoutesModule = typeof import("./diagnostics-routes.ts");
export async function handleDiagnosticsRoutes(
  ...args: Parameters<DiagnosticsRoutesModule["handleDiagnosticsRoutes"]>
): ReturnType<DiagnosticsRoutesModule["handleDiagnosticsRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname.startsWith("/api/logs") ||
      ctx.pathname === "/api/agent/events" ||
      ctx.pathname === "/api/security/audit" ||
      ctx.pathname === "/api/extension/status"
    )
  ) {
    return false;
  }
  return (await import("./diagnostics-routes.ts")).handleDiagnosticsRoutes(
    ...args,
  );
}

type FirstRunRoutesModule = typeof import("./first-run-routes.ts");
export async function handleFirstRunRoutes(
  ...args: Parameters<FirstRunRoutesModule["handleFirstRunRoutes"]>
): ReturnType<FirstRunRoutesModule["handleFirstRunRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname.startsWith("/api/first-run") ||
      ctx.pathname === "/api/wallet/keys"
    )
  ) {
    return false;
  }
  return (await import("./first-run-routes.ts")).handleFirstRunRoutes(...args);
}

type HealthRoutesModule = typeof import("./health-routes.ts");
export async function handleHealthRoutes(
  ...args: Parameters<HealthRoutesModule["handleHealthRoutes"]>
): ReturnType<HealthRoutesModule["handleHealthRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !["/api/status", "/api/health", "/api/runtime"].includes(ctx.pathname)
  ) {
    return false;
  }
  return (await import("./health-routes.ts")).handleHealthRoutes(...args);
}

type MemoryRoutesModule = typeof import("./memory-routes.ts");
export async function handleMemoryRoutes(
  ...args: Parameters<MemoryRoutesModule["handleMemoryRoutes"]>
): ReturnType<MemoryRoutesModule["handleMemoryRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname.startsWith("/api/memory") ||
      ctx.pathname.startsWith("/api/memories") ||
      ctx.pathname === "/api/context/quick"
    )
  ) {
    return false;
  }
  return (await import("./memory-routes.ts")).handleMemoryRoutes(...args);
}

type MiscRoutesModule = typeof import("./misc-routes.ts");
export async function handleMiscRoutes(
  ...args: Parameters<MiscRoutesModule["handleMiscRoutes"]>
): ReturnType<MiscRoutesModule["handleMiscRoutes"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname === "/api/restart" ||
      ctx.pathname === "/api/ingest/share" ||
      ctx.pathname === "/api/agent/event" ||
      /^\/api\/agents\/[^/]+\/event$/.test(ctx.pathname) ||
      ctx.pathname === "/api/terminal/run" ||
      ctx.pathname.startsWith("/api/custom-actions")
    )
  ) {
    return false;
  }
  return (await import("./misc-routes.ts")).handleMiscRoutes(...args);
}

type MobileOptionalRoutesModule = typeof import("./mobile-optional-routes.ts");
export async function handleMobileOptionalRoutes(
  ...args: Parameters<MobileOptionalRoutesModule["handleMobileOptionalRoutes"]>
): ReturnType<MobileOptionalRoutesModule["handleMobileOptionalRoutes"]> {
  const pathname = args[2];
  if (
    typeof pathname !== "string" ||
    !(
      pathname.startsWith("/api/local-inference") ||
      pathname === "/api/tts/local-inference" ||
      pathname === "/api/asr/local-inference" ||
      pathname.startsWith("/api/mobile") ||
      pathname === "/api/runtime/mode" ||
      pathname.startsWith("/api/computer-use/") ||
      pathname.startsWith("/api/stream/") ||
      pathname === "/api/catalog/apps" ||
      pathname === "/api/drop/status" ||
      pathname.startsWith("/api/coding-agents") ||
      pathname === "/api/lifeops/activity-signals"
    )
  ) {
    return false;
  }
  return (
    await import("./mobile-optional-routes.ts")
  ).handleMobileOptionalRoutes(...args);
}

type ModelsRoutesModule = typeof import("./models-routes.ts");
export async function handleModelsRoutes(
  ...args: Parameters<ModelsRoutesModule["handleModelsRoutes"]>
): ReturnType<ModelsRoutesModule["handleModelsRoutes"]> {
  const ctx = routeContext(args);
  if (ctx?.pathname !== "/api/models") return false;
  return (await import("./models-routes.ts")).handleModelsRoutes(...args);
}

type MusicPlayerFallbackModule =
  typeof import("./music-player-route-fallback.ts");
export async function tryHandleMusicPlayerStatusFallbackLazy(
  ...args: Parameters<
    MusicPlayerFallbackModule["tryHandleMusicPlayerStatusFallback"]
  >
): Promise<boolean> {
  const options = args[0] as { pathname?: string } | undefined;
  if (options?.pathname !== "/music-player/status") return false;
  return (
    await import("./music-player-route-fallback.ts")
  ).tryHandleMusicPlayerStatusFallback(...args);
}

type LifeOpsInboxFallbackModule =
  typeof import("./lifeops-inbox-fallback-routes.ts");
export async function tryHandleLifeOpsInboxFallbackLazy(
  ...args: Parameters<
    LifeOpsInboxFallbackModule["tryHandleLifeOpsInboxFallback"]
  >
): Promise<boolean> {
  const options = args[0] as { pathname?: string } | undefined;
  if (options?.pathname !== "/api/lifeops/inbox") return false;
  return (
    await import("./lifeops-inbox-fallback-routes.ts")
  ).tryHandleLifeOpsInboxFallback(...args);
}

type PermissionsRoutesModule = typeof import("./permissions-routes.ts");
export async function handlePermissionRoutes(
  ...args: Parameters<PermissionsRoutesModule["handlePermissionRoutes"]>
): ReturnType<PermissionsRoutesModule["handlePermissionRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/permissions")) return false;
  return (await import("./permissions-routes.ts")).handlePermissionRoutes(
    ...args,
  );
}

type PermissionsExtraRoutesModule =
  typeof import("./permissions-routes-extra.ts");
export async function handlePermissionsExtraRoutes(
  ...args: Parameters<
    PermissionsExtraRoutesModule["handlePermissionsExtraRoutes"]
  >
): ReturnType<PermissionsExtraRoutesModule["handlePermissionsExtraRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/permissions/")) return false;
  return (
    await import("./permissions-routes-extra.ts")
  ).handlePermissionsExtraRoutes(...args);
}

type ProviderSwitchRoutesModule = typeof import("./provider-switch-routes.ts");
export async function handleProviderSwitchRoutes(
  ...args: Parameters<ProviderSwitchRoutesModule["handleProviderSwitchRoutes"]>
): ReturnType<ProviderSwitchRoutesModule["handleProviderSwitchRoutes"]> {
  const ctx = routeContext(args);
  if (ctx?.pathname !== "/api/provider/switch") return false;
  return (
    await import("./provider-switch-routes.ts")
  ).handleProviderSwitchRoutes(...args);
}

type RegistryRoutesModule = typeof import("./registry-routes.ts");
export async function handleRegistryRoutes(
  ...args: Parameters<RegistryRoutesModule["handleRegistryRoutes"]>
): ReturnType<RegistryRoutesModule["handleRegistryRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/registry")) return false;
  return (await import("./registry-routes.ts")).handleRegistryRoutes(...args);
}

type RelationshipsRoutesModule = typeof import("./relationships-routes.ts");
export async function handleRelationshipsRoutes(
  ...args: Parameters<RelationshipsRoutesModule["handleRelationshipsRoutes"]>
): ReturnType<RelationshipsRoutesModule["handleRelationshipsRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/relationships")) return false;
  return (await import("./relationships-routes.ts")).handleRelationshipsRoutes(
    ...args,
  );
}

type RemoteCapabilityRoutesModule =
  typeof import("./remote-capability-routes.ts");
export async function handleRemoteCapabilityRoutes(
  ...args: Parameters<
    RemoteCapabilityRoutesModule["handleRemoteCapabilityRoutes"]
  >
): ReturnType<RemoteCapabilityRoutesModule["handleRemoteCapabilityRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/capability-router")) return false;
  return (
    await import("./remote-capability-routes.ts")
  ).handleRemoteCapabilityRoutes(...args);
}

type RouteDispatchModule = typeof import("./server-route-dispatch.ts");
export async function handleInboxAndCloudRelayRouteGroup(
  ...args: Parameters<RouteDispatchModule["handleInboxAndCloudRelayRouteGroup"]>
): ReturnType<RouteDispatchModule["handleInboxAndCloudRelayRouteGroup"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname.startsWith("/api/notifications") ||
      ctx.pathname.startsWith("/api/inbox") ||
      ctx.pathname === "/api/approvals" ||
      ctx.pathname === "/api/cloud/relay-status"
    )
  ) {
    return false;
  }
  return (
    await import("./server-route-dispatch.ts")
  ).handleInboxAndCloudRelayRouteGroup(...args);
}

export async function handleCloudAndCoreRouteGroup(
  ...args: Parameters<RouteDispatchModule["handleCloudAndCoreRouteGroup"]>
): ReturnType<RouteDispatchModule["handleCloudAndCoreRouteGroup"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/cloud/")) return false;
  return (
    await import("./server-route-dispatch.ts")
  ).handleCloudAndCoreRouteGroup(...args);
}

export async function handleSandboxRouteGroup(
  ...args: Parameters<RouteDispatchModule["handleSandboxRouteGroup"]>
): ReturnType<RouteDispatchModule["handleSandboxRouteGroup"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/sandbox")) return false;
  return (await import("./server-route-dispatch.ts")).handleSandboxRouteGroup(
    ...args,
  );
}

export async function handleConversationRouteGroup(
  ...args: Parameters<RouteDispatchModule["handleConversationRouteGroup"]>
): ReturnType<RouteDispatchModule["handleConversationRouteGroup"]> {
  const ctx = routeContext(args);
  if (
    !ctx ||
    !(
      ctx.pathname.startsWith("/api/conversations") ||
      ctx.pathname.startsWith("/v1/") ||
      (ctx.method === "POST" &&
        /^\/api\/agents\/[^/]+\/message$/.test(ctx.pathname))
    )
  ) {
    return false;
  }
  return (
    await import("./server-route-dispatch.ts")
  ).handleConversationRouteGroup(...args);
}

export async function handleDatabaseRouteGroup(
  ...args: Parameters<RouteDispatchModule["handleDatabaseRouteGroup"]>
): ReturnType<RouteDispatchModule["handleDatabaseRouteGroup"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/database/")) return false;
  return (await import("./server-route-dispatch.ts")).handleDatabaseRouteGroup(
    ...args,
  );
}

export async function handleLifeOpsRuntimePluginRoute(
  ...args: Parameters<RouteDispatchModule["handleLifeOpsRuntimePluginRoute"]>
): ReturnType<RouteDispatchModule["handleLifeOpsRuntimePluginRoute"]> {
  const ctx = routeContext(args);
  const state = (args[0] as { state?: { runtime?: AgentRuntime | null } })
    ?.state;
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

type SubscriptionRoutesModule = typeof import("./subscription-routes.ts");
export async function handleSubscriptionRoutes(
  ...args: Parameters<SubscriptionRoutesModule["handleSubscriptionRoutes"]>
): ReturnType<SubscriptionRoutesModule["handleSubscriptionRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/subscription/")) return false;
  return (await import("./subscription-routes.ts")).handleSubscriptionRoutes(
    ...args,
  );
}

type UpdateRoutesModule = typeof import("./update-routes.ts");
export async function handleUpdateRoutes(
  ...args: Parameters<UpdateRoutesModule["handleUpdateRoutes"]>
): ReturnType<UpdateRoutesModule["handleUpdateRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/update/")) return false;
  return (await import("./update-routes.ts")).handleUpdateRoutes(...args);
}

type ViewsRoutesModule = typeof import("./views-routes.ts");
export async function handleViewsRoutes(
  ...args: Parameters<ViewsRoutesModule["handleViewsRoutes"]>
): ReturnType<ViewsRoutesModule["handleViewsRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/views")) return false;
  const { handleViewsRoutes } = await import("./views-routes.ts");
  if (!builtinViewsRegistered) {
    (await import("./views-registry.ts")).registerBuiltinViews();
    builtinViewsRegistered = true;
  }
  return handleViewsRoutes(...args);
}

export async function registerBuiltinViews(
  runtime?: import("@elizaos/core").IAgentRuntime | null,
): Promise<void> {
  (await import("./views-registry.ts")).registerBuiltinViews();
  // Register the built-in shell views' scoped actions once the runtime exists.
  // Mechanism only: BUILTIN_VIEWS carries no scoped actions until per-view
  // children add them, so this is a no-op today but wires the boot path.
  if (runtime) {
    const { BUILTIN_VIEWS } = await import("./builtin-views.ts");
    const { registerViewScopedActions } = await import(
      "../runtime/view-scoped-actions.ts"
    );
    registerViewScopedActions(runtime, "@elizaos/builtin", BUILTIN_VIEWS);
  }
}

type WorkbenchRoutesModule = typeof import("./workbench-routes.ts");
export async function handleWorkbenchRoutes(
  ...args: Parameters<WorkbenchRoutesModule["handleWorkbenchRoutes"]>
): ReturnType<WorkbenchRoutesModule["handleWorkbenchRoutes"]> {
  const ctx = routeContext(args);
  if (!ctx?.pathname.startsWith("/api/workbench")) return false;
  return (await import("./workbench-routes.ts")).handleWorkbenchRoutes(...args);
}

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
