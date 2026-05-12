/**
 * Browser-only stub for `@elizaos/agent`.
 *
 * `@elizaos/agent` is a Node-only package — it pulls in a Postgres-backed
 * AppManager, the dashboard HTTP server, runtime IPC, etc. Most of that
 * surface is meaningless on the browser side, but a handful of helpers
 * (`gatePluginSessionForHostedApp` is the canonical example) are imported
 * from plugin entry files that *also* compile for the in-app shell, so the
 * imports must resolve to *something* even in the WebView bundle.
 *
 * This file maps those helpers to no-op identity passthroughs — the gating
 * only matters server-side, where a real AppManager run exists; in the
 * browser there is no run state to check, so an unwrapped plugin is the
 * only sensible value to hand back.
 */
import type { Plugin } from "@elizaos/core";

/**
 * Server-side this wraps a plugin so its actions/providers only fire while
 * the host app session is active. In the WebView there is no AppManager run
 * to gate against, so this is an identity passthrough.
 */
export function gatePluginSessionForHostedApp(
  plugin: Plugin,
  _appCanonicalName: string,
): Plugin {
  return plugin;
}

/** Server-side this peeks at the run store. In the browser there is no store. */
export function hasActiveAppRunForCanonicalName(
  _appCanonicalName: string,
): boolean {
  return false;
}

/** Server-side this combines run state and overlay heartbeat. */
export function isHostedAppActiveForAgentActions(
  _appCanonicalName: string,
): boolean {
  return false;
}
