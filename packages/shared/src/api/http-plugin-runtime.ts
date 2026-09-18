/** HTTP host state and contribution lifecycle, separate from the runtime kernel. */
import type { IAgentRuntime } from "@elizaos/core";
import {
  assertPublicRouteIntent,
  type HttpPlugin,
  type Route,
} from "./http-plugin";

export interface HttpRuntimeState {
  routes: Route[];
}
interface OwnedHttpRuntimeState extends HttpRuntimeState {
  installed: boolean;
  owned: Map<string, Route[]>;
}
const HTTP_RUNTIME = Symbol.for("elizaos.http-runtime");
function stateFor(runtime: object): OwnedHttpRuntimeState {
  const target = runtime as { [HTTP_RUNTIME]?: OwnedHttpRuntimeState };
  const existing = target[HTTP_RUNTIME];
  if (existing) return existing;
  const state: OwnedHttpRuntimeState = {
    routes: [],
    installed: false,
    owned: new Map(),
  };
  Object.defineProperty(target, HTTP_RUNTIME, { value: state });
  return state;
}
export function getHttpRuntime(runtime: object): HttpRuntimeState {
  return stateFor(runtime);
}

function normalizedRoutes(
  plugin: HttpPlugin,
  prefixPluginName = true,
): Route[] {
  return (plugin.routes ?? []).map((route) => {
    assertPublicRouteIntent(route, plugin.name);
    const path = route.path.startsWith("/") ? route.path : `/${route.path}`;
    return {
      ...route,
      path:
        route.rawPath || !prefixPluginName ? path : `/${plugin.name}${path}`,
    };
  });
}
function removeRoutes(state: OwnedHttpRuntimeState, name: string): void {
  const owned = new Set(state.owned.get(name));
  state.routes = state.routes.filter((route) => !owned.has(route));
  state.owned.delete(name);
}

/** Register a route-only host contribution without adding a kernel plugin. */
export function registerHttpPluginRoutes(
  runtime: object,
  plugin: HttpPlugin,
  prefixPluginName = true,
): void {
  const routes = normalizedRoutes(plugin, prefixPluginName);
  const state = stateFor(runtime);
  removeRoutes(state, plugin.name);
  state.routes.push(...routes);
  state.owned.set(plugin.name, routes);
}
export function getPluginHttpRoutes(
  runtime: object,
  pluginName: string,
): readonly Route[] {
  return stateFor(runtime).owned.get(pluginName) ?? [];
}

/** Install before host plugin registration; existing declarations are adopted once. */
export function installHttpPluginLifecycle(runtime: IAgentRuntime): void {
  const state = stateFor(runtime);
  if (state.installed) return;
  // Validate the complete existing set before publishing any route.
  const existing = runtime.plugins.map(
    (plugin) => [plugin.name, normalizedRoutes(plugin)] as const,
  );
  for (const [name, routes] of existing) {
    state.routes.push(...routes);
    state.owned.set(name, routes);
  }
  state.installed = true;
  const register = runtime.registerPlugin.bind(runtime);
  const unload = runtime.unloadPlugin.bind(runtime);
  runtime.registerPlugin = async (plugin: HttpPlugin) => {
    if (runtime.plugins.some((entry) => entry.name === plugin.name))
      return register(plugin);
    const routes = normalizedRoutes(plugin);
    await register(plugin);
    state.routes.push(...routes);
    state.owned.set(plugin.name, routes);
  };
  runtime.unloadPlugin = async (name) => {
    try {
      return await unload(name);
    } finally {
      // A refused unload leaves the live plugin and its routes intact.
      if (!runtime.plugins.some((plugin) => plugin.name === name))
        removeRoutes(state, name);
    }
  };
  runtime.reloadPlugin = async (plugin) => {
    await runtime.unloadPlugin(plugin.name);
    await runtime.registerPlugin(plugin);
  };
}
