/**
 * Absent-plugin route stub registry.
 *
 * When an optional plugin/feature is not loaded, its status/probe routes still
 * need to answer the dashboard SPA with a stable "capability unavailable"
 * snapshot rather than a 404. Historically each such stub was hand-written as an
 * inline response literal inside the host's `handleBuiltinOptionalRoutes`
 * (packages/agent/src/api/server.ts) if-chain, and several of them were *also*
 * hand-copied into `handleMobileOptionalRoutes`
 * (packages/agent/src/api/mobile-optional-routes.ts). That duplication is the
 * "host fabricates absent plugins' route responses with hand-mirrored schemas"
 * hazard (arch-audit #12089 item 12 / issue #12662): the two copies had already
 * drifted (e.g. the lifeops POST `reason` string), and every new stub multiplied
 * the surface that could silently diverge from what the real plugin returns.
 *
 * This module owns those pure-fabrication stub payloads once, as declared data
 * keyed by a stable `capabilityId`. Both host handlers resolve from this single
 * registry instead of re-typing the schema. A stub is intentionally limited to a
 * pure function of the request (path + query) — anything that reads live runtime
 * state, such as wallet addresses, stays in its own handler and is NOT a stub
 * here, because those responses are not fabrications.
 *
 * Guardrails:
 *  - `buildBody` must be deterministic and side-effect free (no I/O, no plugin
 *    loading). It may read the request URL/query only.
 *  - Adding a stub here does not change routing precedence: the live plugin
 *    route (registered via `runtime.routes`) is still consulted first by the
 *    dispatcher, so a loaded plugin always wins over its stub.
 */
import type http from "node:http";

/** Snapshot body for an absent-capability status/probe route. */
export type AbsentPluginRouteStubBody = Record<string, unknown>;

/**
 * A single declared stub. `path` is matched exactly (after the query string is
 * stripped by the caller). `buildBody` receives the raw request so query-driven
 * stubs (accountId, authScope) can echo their inputs without reaching into
 * runtime state.
 */
export interface AbsentPluginRouteStub {
  /** Stable identifier of the owning capability/plugin surface. */
  readonly capabilityId: string;
  /** HTTP method this stub answers. */
  readonly method: "GET" | "POST";
  /** Exact pathname (no query string) this stub answers. */
  readonly path: string;
  /** Pure builder for the "unavailable" snapshot. No I/O, no plugin loading. */
  readonly buildBody: (req: http.IncomingMessage) => AbsentPluginRouteStubBody;
}

function queryParam(
  req: http.IncomingMessage,
  key: string,
  fallback: string | null = null,
): string | null {
  const url = new URL(req.url ?? "", "http://localhost");
  return url.searchParams.get(key) ?? fallback;
}

/**
 * Declared registry of absent-plugin route stubs. Keyed order is irrelevant;
 * paths are unique per (method, path). This is the single source of truth for
 * every hand-mirrored "unavailable" snapshot that used to live inline in two
 * host handlers.
 */
export const ABSENT_PLUGIN_ROUTE_STUBS: readonly AbsentPluginRouteStub[] = [
  {
    capabilityId: "voice-profiles",
    method: "GET",
    path: "/api/voice/profiles",
    buildBody: () => ({ profiles: [] }),
  },
  {
    capabilityId: "browser-bridge-companions",
    method: "GET",
    path: "/api/browser-bridge/companions",
    buildBody: () => ({ companions: [] }),
  },
  {
    capabilityId: "discord-local",
    method: "GET",
    path: "/api/discord-local/status",
    buildBody: () => ({
      available: false,
      connected: false,
      authenticated: false,
      currentUser: null,
      subscribedChannelIds: [],
      configuredChannelIds: [],
      scopes: [],
      lastError: null,
      ipcPath: null,
    }),
  },
  {
    capabilityId: "lifeops-imessage",
    method: "GET",
    path: "/api/lifeops/connectors/imessage/status",
    buildBody: () => ({
      available: false,
      connected: false,
      bridgeType: "none",
      hostPlatform: process.platform,
      diagnostics: [],
      error: null,
      chatDbAvailable: false,
      sendOnly: false,
      reason: "lifeops_route_unavailable",
      permissionAction: null,
    }),
  },
  {
    capabilityId: "telegram-account",
    method: "GET",
    path: "/api/setup/telegram-account/status",
    buildBody: () => ({
      connector: "telegram-account",
      state: "idle",
      detail: {
        status: "idle",
        configured: false,
        sessionExists: false,
        serviceConnected: false,
        restartRequired: false,
        hasAppCredentials: false,
        phone: null,
        isCodeViaApp: false,
        account: null,
        error: null,
      },
    }),
  },
  {
    capabilityId: "whatsapp",
    method: "GET",
    path: "/api/whatsapp/status",
    buildBody: (req) => {
      const accountId = queryParam(req, "accountId", "default") || "default";
      const authScope = queryParam(req, "authScope");
      return {
        accountId,
        ...(authScope === "platform" || authScope === "lifeops"
          ? { authScope }
          : {}),
        status: "idle",
        authExists: false,
        serviceConnected: false,
        servicePhone: null,
      };
    },
  },
  {
    capabilityId: "coding-agents-preflight",
    method: "GET",
    path: "/api/coding-agents/preflight",
    buildBody: () => ({ installed: [], available: false }),
  },
  {
    capabilityId: "coding-agents-coordinator",
    method: "GET",
    path: "/api/coding-agents/coordinator/status",
    buildBody: () => ({
      supervisionLevel: "unavailable",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
      taskThreadCount: 0,
      taskThreads: [],
      frameworks: [],
    }),
  },
  {
    capabilityId: "lifeops-activity-signals",
    method: "GET",
    path: "/api/lifeops/activity-signals",
    buildBody: () => ({ signals: [] }),
  },
  {
    capabilityId: "lifeops-activity-signals",
    method: "POST",
    path: "/api/lifeops/activity-signals",
    buildBody: () => ({
      ok: true,
      stored: false,
      reason: "lifeops_route_unavailable",
    }),
  },
];

/**
 * Resolve the declared stub for a (method, pathname) pair, or `null` when no
 * absent-plugin stub owns it. `pathname` MUST already be query-stripped.
 */
export function resolveAbsentPluginRouteStub(
  method: string,
  pathname: string,
): AbsentPluginRouteStub | null {
  for (const stub of ABSENT_PLUGIN_ROUTE_STUBS) {
    if (stub.method === method && stub.path === pathname) {
      return stub;
    }
  }
  return null;
}
