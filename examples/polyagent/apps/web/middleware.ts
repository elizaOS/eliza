import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ALLOWED_PATHS = new Set([
  "/",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
]);

/**
 * Production and staging origins for CORS requests
 */
const PRODUCTION_ORIGINS = [
  "https://polyagent.market",
  "https://www.polyagent.market",
  "https://app.polyagent.market",
  "https://privy.polyagent.market",
  "https://staging.polyagent.market",
  "https://app.staging.polyagent.market",
] as const;

/**
 * Development-only origins - only included when NODE_ENV is not 'production'
 */
const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
] as const;

/**
 * Parse additional CORS origins from environment variable.
 * CORS_ALLOWED_ORIGINS can be a comma-separated list of origins.
 * This allows adding preview domains, new subdomains, etc. without code changes.
 */
function getEnvOrigins(): string[] {
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
  if (!envOrigins) return [];

  return envOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Allowed origins for CORS requests.
 * Includes: production origins, env-driven origins, and dev origins (in non-production).
 * Set CORS_ALLOWED_ORIGINS env var to add additional origins (comma-separated).
 */
const ALLOWED_ORIGINS = new Set<string>([
  ...PRODUCTION_ORIGINS,
  ...getEnvOrigins(),
  ...(process.env.NODE_ENV !== "production" ? DEV_ORIGINS : []),
]);

/**
 * Check if origin is allowed for CORS
 */
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function isAssetRequest(pathname: string) {
  return (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets") ||
    pathname.startsWith("/static") ||
    pathname.startsWith("/images") ||
    pathname.startsWith("/fonts") ||
    pathname.startsWith("/.well-known") ||
    pathname.startsWith("/_vercel") ||
    pathname.startsWith("/monitoring") ||
    /\.[^/]+$/.test(pathname)
  );
}

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api");
}

/**
 * Check if this is an agent API route (handled separately in vercel.json)
 * Agent routes use Bearer token auth, not cookies, so they can have wildcard CORS
 */
function isAgentApiRequest(pathname: string) {
  return pathname.startsWith("/api/agents");
}

/**
 * Add CORS headers to response for API requests
 */
function addCorsHeaders(
  response: NextResponse,
  origin: string | null,
): NextResponse {
  // For credentialed requests, must use specific origin (not *)
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    // Vary header prevents caching issues when origin changes
    response.headers.set("Vary", "Origin");
  }

  response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version, x-admin-token, x-dev-admin-token",
  );
  response.headers.set("Access-Control-Max-Age", "86400");

  return response;
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const origin = request.headers.get("origin");

  // Skip CORS handling for agent routes - handled in vercel.json with wildcard
  // Agent routes use Bearer token auth (not cookies), so they can use wildcard CORS
  if (isAgentApiRequest(pathname)) {
    return NextResponse.next();
  }

  // Handle CORS preflight (OPTIONS) requests for API routes
  if (request.method === "OPTIONS" && isApiRequest(pathname)) {
    const response = new NextResponse(null, { status: 204 });
    return addCorsHeaders(response, origin);
  }

  // Handle API requests with CORS headers
  if (isApiRequest(pathname)) {
    const response = NextResponse.next();
    return addCorsHeaders(response, origin);
  }

  // Waitlist mode handling
  const waitlistFlag =
    process.env.WAITLIST_MODE ?? process.env.NEXT_PUBLIC_WAITLIST_MODE ?? "";
  const waitlistEnabled = ["true", "1", "yes", "on"].includes(
    waitlistFlag.toLowerCase(),
  );

  if (!waitlistEnabled) {
    return NextResponse.next();
  }

  if (ALLOWED_PATHS.has(pathname) || isAssetRequest(pathname)) {
    return NextResponse.next();
  }

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/";
  redirectUrl.search = search;

  return NextResponse.redirect(redirectUrl);
}

export const config = {
  // Run on everything (assets/API are allowed through in handler)
  matcher: ["/(.*)"],
};
