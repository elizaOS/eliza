import type http from "node:http";
import { ensureRouteAuthorized, ensureRouteMinRole } from "./auth.ts";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJsonError } from "./response";

export type CompatRouteAuthTier = "public" | "session" | "OWNER";

export type CompatRoutePolicyMatcher =
  | { kind: "exact"; path: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "regex"; pattern: RegExp };

export interface CompatRouteAuthPolicy {
  id: string;
  tier: CompatRouteAuthTier;
  methods?: readonly string[];
  matcher: CompatRoutePolicyMatcher;
}

const METHODS = {
  GET: ["GET"],
  POST: ["POST"],
} as const;

const publicExact = (
  id: string,
  method: keyof typeof METHODS,
  path: string,
): CompatRouteAuthPolicy => ({
  id,
  tier: "public",
  methods: METHODS[method],
  matcher: { kind: "exact", path },
});

const sessionExact = (
  id: string,
  method: keyof typeof METHODS,
  path: string,
): CompatRouteAuthPolicy => ({
  id,
  tier: "session",
  methods: METHODS[method],
  matcher: { kind: "exact", path },
});

const ownerExact = (
  id: string,
  method: keyof typeof METHODS,
  path: string,
): CompatRouteAuthPolicy => ({
  id,
  tier: "OWNER",
  methods: METHODS[method],
  matcher: { kind: "exact", path },
});

const sessionPrefix = (id: string, prefix: string): CompatRouteAuthPolicy => ({
  id,
  tier: "session",
  matcher: { kind: "prefix", prefix },
});

const ownerPrefix = (id: string, prefix: string): CompatRouteAuthPolicy => ({
  id,
  tier: "OWNER",
  matcher: { kind: "prefix", prefix },
});

const publicPrefix = (id: string, prefix: string): CompatRouteAuthPolicy => ({
  id,
  tier: "public",
  matcher: { kind: "prefix", prefix },
});

const sessionRegex = (
  id: string,
  method: keyof typeof METHODS,
  pattern: RegExp,
): CompatRouteAuthPolicy => ({
  id,
  tier: "session",
  methods: METHODS[method],
  matcher: { kind: "regex", pattern },
});

export const COMPAT_ROUTE_AUTH_POLICIES: readonly CompatRouteAuthPolicy[] = [
  publicExact("i18n.locale", "GET", "/api/i18n/locale"),
  publicExact("cloud.pair-popup", "GET", "/pair"),
  publicExact(
    "auth.bootstrap.exchange",
    "POST",
    "/api/auth/bootstrap/exchange",
  ),
  publicExact("auth.setup", "POST", "/api/auth/setup"),
  publicExact("auth.login.password", "POST", "/api/auth/login/password"),
  publicExact("auth.status", "GET", "/api/auth/status"),
  publicExact("auth.pair", "POST", "/api/auth/pair"),
  publicExact("embed.auth", "POST", "/api/embed/auth"),
  publicExact("tts.elevenlabs-passthrough", "POST", "/api/tts/elevenlabs"),

  sessionExact("runtime.mode", "GET", "/api/runtime/mode"),
  sessionPrefix("cloud.compat", "/api/cloud/compat/"),
  sessionPrefix("cloud.v1", "/api/cloud/v1/"),
  sessionPrefix("cloud.billing", "/api/cloud/billing/"),

  sessionExact("dev.stack", "GET", "/api/dev/stack"),
  sessionExact("dev.route-catalog", "GET", "/api/dev/route-catalog"),
  sessionExact("dev.cursor-screenshot", "GET", "/api/dev/cursor-screenshot"),
  sessionExact("dev.console-log", "GET", "/api/dev/console-log"),
  sessionExact("dev.voice-latency", "GET", "/api/dev/voice-latency"),
  sessionExact(
    "dev.device-resource-metrics",
    "GET",
    "/api/dev/device-resource-metrics",
  ),
  sessionExact("dev.inference-timing", "GET", "/api/dev/inference-timing"),
  sessionExact("dev.boot-history", "GET", "/api/dev/boot-history"),
  sessionExact("dev.health", "GET", "/api/dev/health"),
  sessionExact("dev.route-timings", "GET", "/api/dev/route-timings"),

  sessionExact("auth.password.change", "POST", "/api/auth/password/change"),
  sessionExact("auth.logout", "POST", "/api/auth/logout"),
  sessionExact("auth.me", "GET", "/api/auth/me"),
  sessionExact("auth.sessions", "GET", "/api/auth/sessions"),
  sessionRegex(
    "auth.sessions.revoke",
    "POST",
    /^\/api\/auth\/sessions\/[^/]+\/revoke$/,
  ),
  sessionExact("first-run.status", "GET", "/api/first-run/status"),
  sessionExact(
    "background.run-due-tasks",
    "POST",
    "/api/background/run-due-tasks",
  ),
  sessionPrefix("sensitive-requests", "/api/sensitive-requests"),
  sessionPrefix("local-inference", "/api/local-inference/"),
  sessionPrefix("voice.local-inference", "/api/voice/"),
  sessionPrefix("voice.v1-local-inference", "/v1/voice/"),
  sessionPrefix("automations", "/api/automations"),
  sessionExact("tts.cloud", "POST", "/api/tts/cloud"),
  sessionPrefix("workbench", "/api/workbench"),
  sessionPrefix("plugins.management", "/api/plugins"),
  sessionPrefix("catalog", "/api/catalog"),
  sessionExact("first-run.submit", "POST", "/api/first-run"),
  sessionRegex("plugins.ui-spec", "GET", /^\/api\/plugins\/[^/]+\/ui-spec$/),
  sessionExact("agents.list", "GET", "/api/agents"),
  sessionExact("config.read", "GET", "/api/config"),

  ownerPrefix("secrets", "/api/secrets/"),
  ownerExact("drop.status", "GET", "/api/drop/status"),
  ownerExact("agent.reset", "POST", "/api/agent/reset"),
  ownerPrefix("credential-tunnel", "/api/credential-tunnel"),
  ownerPrefix("database.rows", "/api/database/"),

  // Device-secret bearer auth is enforced by internal-routes.ts. The
  // dispatcher declares it public so the handler's host-secret auth can run.
  publicPrefix("internal.device-secret", "/api/internal/"),
] as const;

const COMPAT_MANAGED_PREFIXES = [
  "/api/auth/",
  "/api/background/",
  "/api/catalog",
  "/api/cloud/",
  "/api/config",
  "/api/credential-tunnel/",
  "/api/database/",
  "/api/dev/",
  "/api/drop/",
  "/api/embed/",
  "/api/first-run",
  "/api/i18n/",
  "/api/internal/",
  "/api/local-inference/",
  "/api/voice/",
  "/api/plugins",
  "/api/runtime/",
  "/api/secrets/",
  "/api/sensitive-requests",
  "/api/tts/",
  "/api/workbench",
  "/api/agents",
  "/v1/voice/",
  "/pair",
] as const;

function methodMatches(policy: CompatRouteAuthPolicy, method: string): boolean {
  return !policy.methods || policy.methods.includes(method);
}

function pathMatches(
  matcher: CompatRoutePolicyMatcher,
  pathname: string,
): boolean {
  switch (matcher.kind) {
    case "exact":
      return pathname === matcher.path;
    case "prefix":
      return prefixMatches(pathname, matcher.prefix);
    case "regex":
      return matcher.pattern.test(pathname);
  }
}

function prefixMatches(pathname: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function resolveCompatRouteAuthPolicy(
  method: string,
  pathname: string,
): CompatRouteAuthPolicy | null {
  const normalizedMethod = method.toUpperCase();
  return (
    COMPAT_ROUTE_AUTH_POLICIES.find(
      (policy) =>
        methodMatches(policy, normalizedMethod) &&
        pathMatches(policy.matcher, pathname),
    ) ?? null
  );
}

export function isCompatManagedRoute(pathname: string): boolean {
  return COMPAT_MANAGED_PREFIXES.some((prefix) =>
    prefixMatches(pathname, prefix),
  );
}

type CompatRoutePolicyDecision = "allowed" | "denied" | "unmanaged";

export async function enforceCompatRouteAuthPolicy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  method: string,
  pathname: string,
): Promise<CompatRoutePolicyDecision> {
  const policy = resolveCompatRouteAuthPolicy(method, pathname);
  if (!policy) {
    if (!isCompatManagedRoute(pathname)) return "unmanaged";
    sendJsonError(res, 401, "Unauthorized");
    return "denied";
  }

  if (policy.tier === "public") return "allowed";

  const authorized =
    policy.tier === "OWNER"
      ? await ensureRouteMinRole(req, res, state, "OWNER")
      : await ensureRouteAuthorized(req, res, state);
  return authorized ? "allowed" : "denied";
}
