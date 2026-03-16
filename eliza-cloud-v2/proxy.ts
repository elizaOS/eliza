/**
 * Proxy - Auth caching
 *
 * IMPORTANT: Uses native Response everywhere to avoid polyfill conflicts.
 * The mcp-handler package triggers undici's Response polyfill which breaks
 * NextResponse instanceof checks. We use x-middleware-next header instead.
 * See: https://github.com/vercel/next.js/issues/58611
 */

import type { NextRequest } from "next/server";
import { PrivyClient } from "@privy-io/server-auth";
import { Redis } from "@upstash/redis";

// Helper to create "next" response (continue to route handler)
// Uses internal Next.js header that NextResponse.next() sets
function middlewareNext(options?: {
  headers?: Record<string, string>;
  requestHeaders?: Headers;
}): Response {
  const headers = new Headers(options?.headers);
  headers.set("x-middleware-next", "1");

  // Forward modified request headers if provided
  if (options?.requestHeaders) {
    const headersList: string[] = [];
    options.requestHeaders.forEach((value, key) => {
      headersList.push(`${key}:${value}`);
    });
    if (headersList.length > 0) {
      headers.set(
        "x-middleware-override-headers",
        Array.from(options.requestHeaders.keys()).join(","),
      );
      options.requestHeaders.forEach((value, key) => {
        headers.set(`x-middleware-request-${key}`, value);
      });
    }
  }

  return new Response(null, { status: 200, headers });
}

// Helper to create redirect response
function middlewareRedirect(
  url: URL | string,
  options?: { headers?: Record<string, string>; deleteCookies?: string[] },
): Response {
  const headers = new Headers(options?.headers);
  headers.set("Location", url.toString());

  // Set cookies to delete
  if (options?.deleteCookies) {
    for (const cookie of options.deleteCookies) {
      headers.append(
        "Set-Cookie",
        `${cookie}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      );
    }
  }

  return new Response(null, { status: 307, headers });
}

const privyClient = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!,
);

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
  return redis;
}

const AUTH_CACHE_TTL = 300;

interface CachedAuth {
  valid: boolean;
  userId?: string;
  expiration?: number;
  cachedAt: number;
}

function hashToken(token: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(token.length, 100); i++) {
    hash = (hash << 5) - hash + token.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

async function getCachedAuth(token: string): Promise<CachedAuth | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    const cached = await client.get<CachedAuth | string>(`proxy:auth:${hashToken(token)}`);
    if (!cached) return null;
    // Handle both old string format and new object format
    if (typeof cached === "string") {
      // Skip corrupted cache entries (e.g., "[object Object]")
      if (cached === "[object Object]" || !cached.startsWith("{")) {
        return null;
      }
      return JSON.parse(cached);
    }
    // Validate it's actually a CachedAuth object
    if (typeof cached === "object" && "valid" in cached && "cachedAt" in cached) {
      return cached;
    }
    return null;
  } catch (error) {
    // Silently ignore corrupted cache entries (e.g., "[object Object]" stored incorrectly)
    // This happens when Upstash tries to auto-parse invalid JSON - just fall back to fresh auth
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("is not valid JSON")) {
      return null;
    }
    // Log other unexpected Redis errors but don't block auth
    console.warn("[Proxy] Redis cache read failed:", errorMessage);
    return null;
  }
}

async function setCachedAuth(token: string, auth: CachedAuth): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.setex(
      `proxy:auth:${hashToken(token)}`,
      AUTH_CACHE_TTL,
      JSON.stringify(auth),
    );
  } catch (error) {
    // Log Redis write errors but don't block auth - caching is best-effort
    console.warn("[Proxy] Redis cache write failed:", error instanceof Error ? error.message : String(error));
  }
}

function isJwtExpiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; claim?: unknown; reason?: unknown };
  return (
    e.code === "ERR_JWT_EXPIRED" ||
    (e.claim === "exp" && e.reason === "check_failed")
  );
}

const publicPaths = [
  "/",
  "/marketplace",
  "/payment/success",
  "/dashboard/chat",
  "/chat",
  "/api/eliza",
  "/api/models",
  "/api/fal/proxy",
  "/api/og",
  "/api/public",
  "/auth/error",
  "/auth/cli-login",
  "/api/auth/cli-session",
  "/api/set-anonymous-session",
  "/api/anonymous-session",
  "/api/affiliate",
  "/api/v1/generate-image",
  "/api/v1/generate-video",
  "/api/v1/chat",
  "/api/v1/chat/completions",
  "/api/v1/responses",
  "/api/v1/embeddings",
  "/api/v1/models",
  "/api/v1/credits/topup",
  "/api/stripe/webhook",
  "/api/crypto/webhook",
  "/api/privy/webhook",
  "/api/cron",
  "/api/v1/cron",
  "/api/mcps",
  "/api/mcp/list",
  "/api/mcp",
  "/api/a2a",
  "/api/agents",
  "/api/v1/track",
  "/api/v1/discovery", // Public discovery endpoint for agents/MCPs
  "/api/v1/discord/callback", // Discord OAuth callback (redirects from Discord)
  "/api/v1/twitter/callback", // Twitter OAuth callback
  "/api/v1/oauth/providers", // Public endpoint - list available OAuth providers
  "/api/v1/app-auth",
  "/app-auth",
  "/.well-known",
  "/api/.well-known", // JWKS endpoint for JWT verification
  "/api/internal", // Internal service-to-service API (has own auth via JWT Bearer token)
  "/api/webhooks", // Twilio, Blooio webhooks (they verify their own signatures)
  "/api/v1/telegram/webhook", // Telegram webhook (validates via bot token lookup)
  "/api/eliza-app/auth", // Eliza App public auth endpoints
  "/api/eliza-app/webhook", // Eliza App webhooks (they verify their own signatures)
  "/api/eliza-app/user", // Eliza App user endpoints (uses own session validation)
];

const publicPathPatterns = [
  /^\/api\/v1\/apps\/[^/]+\/public$/,
  /^\/api\/characters\/[^/]+\/public$/,
  /^\/api\/v1\/oauth\/[^/]+\/callback$/, // Generic OAuth callbacks (redirects from providers)
];

const protectedPaths = [
  "/dashboard",
  "/api/v1/user",
  "/api/v1/organization",
  "/api/v1/api-keys",
  "/api/v1/usage",
  "/api/v1/generations",
  "/api/v1/containers",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const startTime = Date.now();

  // Handle CORS preflight (OPTIONS) requests for API routes
  if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID, Cookie, X-Miniapp-Token, X-Anonymous-Session, X-Gateway-Secret",
        "Access-Control-Max-Age": "86400",
        "X-Proxy-Time": `${Date.now() - startTime}ms`,
      },
    });
  }

  const isPublicPath =
    publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    publicPathPatterns.some((pattern) => pattern.test(pathname));
  if (isPublicPath) {
    return middlewareNext({
      headers: { "X-Proxy-Time": `${Date.now() - startTime}ms` },
    });
  }

  const isProtectedPath = protectedPaths.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!isProtectedPath && !pathname.startsWith("/api/")) {
    return middlewareNext();
  }

  try {
    const authToken = request.cookies.get("privy-token");
    const authHeader = request.headers.get("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    const apiKey = request.headers.get("X-API-Key");

    if (apiKey || (bearerToken && bearerToken.startsWith("eliza_"))) {
      return middlewareNext({
        headers: { "X-Proxy-Time": `${Date.now() - startTime}ms` },
      });
    }

    const token = bearerToken || authToken?.value;

    if (!token) {
      if (pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return middlewareRedirect(url);
    }

    const cachedAuth = await getCachedAuth(token);
    if (cachedAuth?.valid && cachedAuth.userId) {
      if (cachedAuth.expiration) {
        const now = Math.floor(Date.now() / 1000);
        if (cachedAuth.expiration <= now) {
          await setCachedAuth(token, { valid: false, cachedAt: Date.now() });
        } else {
          const requestHeaders = new Headers(request.headers);
          requestHeaders.set("x-privy-user-id", cachedAuth.userId);
          requestHeaders.set("x-auth-cached", "true");
          return middlewareNext({
            headers: {
              "X-Proxy-Time": `${Date.now() - startTime}ms`,
              "X-Auth-Cached": "true",
            },
            requestHeaders,
          });
        }
      } else {
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set("x-privy-user-id", cachedAuth.userId);
        requestHeaders.set("x-auth-cached", "true");
        return middlewareNext({
          headers: {
            "X-Proxy-Time": `${Date.now() - startTime}ms`,
            "X-Auth-Cached": "true",
          },
          requestHeaders,
        });
      }
    }

    let user: Awaited<ReturnType<typeof privyClient.verifyAuthToken>> | null =
      null;
    try {
      user = await privyClient.verifyAuthToken(token);
    } catch (error) {
      if (isJwtExpiredError(error)) {
        await setCachedAuth(token, { valid: false, cachedAt: Date.now() });
        if (pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "Token expired" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const url = request.nextUrl.clone();
        url.pathname = "/";
        return middlewareRedirect(url, {
          deleteCookies: ["privy-token", "privy-id-token"],
        });
      }
      throw error;
    }

    if (!user) {
      await setCachedAuth(token, { valid: false, cachedAt: Date.now() });
      if (pathname.startsWith("/api/")) {
        return new Response(
          JSON.stringify({ error: "Invalid authentication token" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return middlewareRedirect(url);
    }

    await setCachedAuth(token, {
      valid: true,
      userId: user.userId,
      expiration:
        typeof (user as unknown as { expiration?: unknown }).expiration ===
        "number"
          ? ((user as unknown as { expiration: number }).expiration as number)
          : undefined,
      cachedAt: Date.now(),
    });

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-privy-user-id", user.userId);
    return middlewareNext({
      headers: { "X-Proxy-Time": `${Date.now() - startTime}ms` },
      requestHeaders,
    });
  } catch (error) {
    console.error("Proxy auth error:", error);
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Authentication failed" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/auth/error";
    url.searchParams.set("reason", "auth_failed");
    return middlewareRedirect(url);
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
