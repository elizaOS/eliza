/** Optional HTTP host contributions; the runtime kernel owns no route table. */

import type { JsonValue } from "@elizaos/common";
import type {
  AccessContext,
  IAgentRuntime,
  Plugin,
  PluginAppBridge,
  X402Config,
  X402ValidationResult,
} from "@elizaos/core";
import type { AppPackageRouteContext } from "./route-helpers";
export type RouteRuntimeMode = "local" | "local-only" | "cloud" | "remote";

export interface HttpPlugin extends Plugin {
  routes?: Route[];
  appBridge?: PluginAppBridge & {
    handleAppRoutes?: (context: AppPackageRouteContext) => Promise<boolean>;
  };
}

/**
 * Supported types for route request body fields
 */
export type RouteBodyValue = JsonValue;

/**
 * Minimal request interface
 * Plugins can use this type for route handlers
 */
export interface RouteRequest {
  body?: Record<string, RouteBodyValue>;
  /** Raw UTF-8 body bytes (required for webhook HMAC verification). */
  rawBody?: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  url?: string;
}

/**
 * Minimal response interface
 * Plugins can use this type for route handlers
 */
export interface RouteResponse {
  status: (code: number) => RouteResponse;
  json: (data: unknown) => RouteResponse;
  send: (data: unknown) => RouteResponse;
  end: () => RouteResponse;
  setHeader?: (name: string, value: string | string[]) => RouteResponse;
  sendFile?: (path: string) => RouteResponse;
  headersSent?: boolean;
}

/**
 * Context passed to the return-shape route handler ({@link RouteHandler}).
 *
 * This is the canonical contract used by `dispatchRoute` for both HTTP and
 * in-process (IPC) invocations. The legacy Express-shaped `handler` field on
 * {@link Route} remains supported during the plugin-route migration; new
 * plugin routes should prefer `routeHandler` returning a
 * {@link RouteHandlerResult}.
 */
export interface RouteHandlerContext {
  body: unknown;
  /** Raw UTF-8 body when the transport preserved it (webhook signature verification). */
  rawBody?: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  method: string;
  path: string;
  runtime: IAgentRuntime;
  /** true when invoked in-process via IPC; false when invoked over HTTP. */
  inProcess: boolean;
  /** true when the HTTP transport has verified this request as loopback/local. */
  isTrustedLocal?: boolean;
  /**
   * Optional requester identity resolved by the authenticated boundary. Omitted
   * means the route is running under today's single-owner local boundary and
   * must preserve existing unfiltered behavior.
   */
  accessContext?: AccessContext;
}

/** Return-shape result produced by a {@link RouteHandler}. */
export interface RouteHandlerResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON-serializable body; the adapter stringifies on the way out. */
  body?: unknown;
  /** Optional streaming body for SSE / long responses. */
  stream?: AsyncIterable<Uint8Array | string>;
}

/** Canonical, return-shape route handler. */
export type RouteHandler = (
  ctx: RouteHandlerContext,
) => Promise<RouteHandlerResult>;

/** Express-shaped legacy route handler. */
export type LegacyRouteHandler = (
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
) => Promise<void>;

interface BaseRoute {
  type: HttpMethod;
  path: string;
  filePath?: string;
  /** Legacy Express-shaped handler. Coexists with `routeHandler` during migration. */
  handler?: LegacyRouteHandler;
  /** Canonical return-shape handler used by `dispatchRoute`. */
  routeHandler?: RouteHandler;
  isMultipart?: boolean; // Indicates if the route expects multipart/form-data (file uploads)
  /**
   * Maximum HTTP request body bytes this route permits. Hosts retain their
   * default limit when omitted; use only for a reviewed endpoint whose payload
   * contract requires a larger bounded body.
   */
  maxBodyBytes?: number;
  /**
   * When true, the route path is used as-is without the plugin-name prefix.
   * Use for legacy API paths that must remain stable (e.g. `/api/telegram-setup/status`).
   */
  rawPath?: boolean;
  /**
   * Runtime modes where this route is visible. The agent HTTP server hides
   * routes outside this list with 404 before handler logic runs
   * (packages/agent/src/api/runtime-mode/), so every host — the bare agent
   * and the app-core wrapper — enforces the same visibility contract.
   */
  modes?: ReadonlyArray<RouteRuntimeMode>;
  /** Free-form one-liner documenting why the route is scoped to those modes. */
  modeReason?: string;
  /** x402 micropayment gate: object, or `true` to use `character.settings.x402` defaults */
  x402?: X402Config | true;
  /** Runs before payment; invalid → 402 with accepts payload */
  validator?: X402RequestValidator;
  /** Optional OpenAPI-style metadata for x402 outputSchema */
  openapi?: {
    parameters?: Array<{
      name: string;
      in: "path" | "query" | "header";
      required?: boolean;
      description?: string;
      schema: {
        type: string;
        format?: string;
        pattern?: string;
        enum?: string[];
        minimum?: number;
        maximum?: number;
      };
    }>;
    requestBody?: {
      required?: boolean;
      description?: string;
      content: {
        "application/json"?: { schema: JsonValue };
        "multipart/form-data"?: { schema: JsonValue };
      };
    };
  };
  /** Shown in x402 `accepts` / wallet UIs when set */
  description?: string;
}

interface PublicRoute extends BaseRoute {
  public: true;
  name: string; // Name is required for public routes
  /**
   * Reviewed reason this route may bypass the central auth gate.
   * Public routes without this intent are rejected by route registration and
   * dispatchers.
   */
  publicReason: string;
  /**
   * A public route is unauthenticated by the central gate, so it defaults to
   * read-only (`GET`/`STATIC`): defense-in-depth against a mutating endpoint
   * being shipped world-reachable. A non-GET public route (an inbound webhook,
   * an OAuth redirect exchange, a companion-bridge callback) is authenticated
   * out-of-band instead of by the gate, so it must opt in here by naming that
   * mechanism (signature check, unguessable capability token, …). Without this,
   * a `public: true` route with a write method is rejected at registration and
   * dispatch. GET/STATIC public routes never need it.
   */
  publicWrite?: string;
}

interface PrivateRoute extends BaseRoute {
  public?: false;
  name?: string; // Name is optional for private routes
}

export type Route = PublicRoute | PrivateRoute;

/** Write methods a public route may only use when it self-authenticates. */
const PUBLIC_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function assertPublicRouteIntent(route: Route, source = "plugin"): void {
  if (
    route.maxBodyBytes !== undefined &&
    (!Number.isSafeInteger(route.maxBodyBytes) || route.maxBodyBytes <= 0)
  ) {
    throw new Error(
      `[RouteBody] Route ${source}:${route.type} ${route.path} maxBodyBytes must be a positive safe integer`,
    );
  }
  if (route.public !== true) return;
  const reason = (route as { publicReason?: unknown }).publicReason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(
      `[RouteAuth] Public route ${source}:${route.type} ${route.path} must declare publicReason`,
    );
  }
  if (PUBLIC_WRITE_METHODS.has(route.type)) {
    const publicWrite = (route as { publicWrite?: unknown }).publicWrite;
    if (typeof publicWrite !== "string" || publicWrite.trim().length === 0) {
      throw new Error(
        `[RouteAuth] Public ${route.type} route ${source}:${route.path} is unauthenticated by the central gate; a write-method public route must declare publicWrite naming its out-of-band auth (signature, capability token, …). Make it GET, gate it, or declare publicWrite.`,
      );
    }
  }
}

/** Route that may include x402 payment fields (alias for authoring clarity) */
export type PaymentEnabledRoute = Route;

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "STATIC";

export interface RouteManifest {
  method: HttpMethod;
  path: string;
  name?: string;
  public?: boolean;
  isMultipart?: boolean;
  maxBodyBytes?: number;
  filePath?: string;
  x402?: X402Config;
}

export type X402RequestValidator = (
  request: RouteRequest,
) => X402ValidationResult | Promise<X402ValidationResult>;
