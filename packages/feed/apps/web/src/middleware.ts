import { TOTAL_AGENT_DEFAULT_PROFILE_PICTURES } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getLegacyCanonicalOrigin,
  isLegacyCanonicalHostname,
} from '@/lib/host-routing';

/**
 * Production and staging origins for CORS requests
 */
const PRODUCTION_ORIGINS = [
  'https://babylon.market',
  'https://www.babylon.market',
  'https://app.babylon.market',
  // 'https://privy.babylon.market', // DEPRECATED — Privy removed in Phase 2
  'https://staging.babylon.market',
  'https://app.staging.babylon.market',
  'https://play.staging.babylon.market',
  // Capacitor mobile app origins.
  // Capacitor iOS sets Origin: capacitor://localhost; Android sets Origin: https://localhost.
  // These are the WebView origins for the native shell — not reachable from external browsers.
  // Attack surface is limited: an attacker would need to already control the device.
  'capacitor://localhost', // iOS Capacitor WebView
  'https://localhost', // Android Capacitor WebView
] as const;

/**
 * Development-only origins - only included when NODE_ENV is not 'production'
 */
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  // mobile
  'capacitor://localhost',
  'http://localhost:3077',
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
    .split(',')
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
  ...(process.env.NODE_ENV !== 'production' ? DEV_ORIGINS : []),
]);

/**
 * Check if origin is allowed for CORS
 */
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function isApiRequest(pathname: string) {
  return pathname.startsWith('/api');
}

/**
 * Check if this is an agent API route (handled separately in vercel.json)
 * Agent routes use Bearer token auth, not cookies, so they can have wildcard CORS
 */
function isAgentApiRequest(pathname: string) {
  return pathname.startsWith('/api/agents');
}

/**
 * Add CORS headers to response for API requests
 */
function addCorsHeaders(
  response: NextResponse,
  origin: string | null
): NextResponse {
  // For credentialed requests, must use specific origin (not *)
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    // Vary header prevents caching issues when origin changes
    response.headers.set('Vary', 'Origin');
  }

  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version, x-admin-token, x-dev-admin-token'
  );
  response.headers.set('Access-Control-Max-Age', '86400');

  return response;
}

function getHostname(request: NextRequest): string {
  const forwardedHostHeader =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    '';
  const forwardedHost = forwardedHostHeader.split(',')[0]?.trim() ?? '';
  const host =
    forwardedHost.length > 0 ? forwardedHost : request.nextUrl.hostname;
  return host.split(':')[0]?.toLowerCase() ?? '';
}

function rewriteLegacyPresetPfpAssets(
  request: NextRequest
): NextResponse | null {
  const { pathname } = request.nextUrl;
  const legacyProfile = /^\/assets\/user-profiles\/profile-(\d+)\.jpg$/.exec(
    pathname
  );
  if (legacyProfile) {
    const n = parseInt(legacyProfile[1] ?? '', 10);
    if (n >= 1 && n <= TOTAL_AGENT_DEFAULT_PROFILE_PICTURES) {
      const url = request.nextUrl.clone();
      url.pathname = `/assets/user-pfps/pfp-${String(n).padStart(3, '0')}.png`;
      return NextResponse.rewrite(url);
    }
  }
  const legacyMonkey = /^\/assets\/agent-monkeys\/monkey-(\d+)\.jpg$/.exec(
    pathname
  );
  if (legacyMonkey) {
    const n = parseInt(legacyMonkey[1] ?? '', 10);
    if (n >= 1 && n <= TOTAL_AGENT_DEFAULT_PROFILE_PICTURES) {
      const url = request.nextUrl.clone();
      url.pathname = `/assets/user-pfps/pfp-${String(n).padStart(3, '0')}.png`;
      return NextResponse.rewrite(url);
    }
  }
  return null;
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const origin = request.headers.get('origin');
  const hostname = getHostname(request);

  const legacyPfpRewrite = rewriteLegacyPresetPfpAssets(request);
  if (legacyPfpRewrite) {
    return legacyPfpRewrite;
  }

  // Redirect legacy babylon.social domains to babylon.market
  if (isLegacyCanonicalHostname(hostname)) {
    const redirectOrigin = getLegacyCanonicalOrigin(
      hostname,
      request.nextUrl.protocol
    );

    if (redirectOrigin) {
      return NextResponse.redirect(`${redirectOrigin}${pathname}${search}`);
    }
  }

  // NFT features are disabled — block both API routes and page routes.
  if (
    pathname.startsWith('/api/nft') ||
    pathname.startsWith('/api/wallet/nfts') ||
    pathname === '/nft' ||
    pathname.startsWith('/nft/')
  ) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'NFT features are currently disabled.' },
        { status: 503 }
      );
    }
    // Redirect page routes to home
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Skip CORS handling for agent routes - handled in vercel.json with wildcard
  // Agent routes use Bearer token auth (not cookies), so they can use wildcard CORS
  if (isAgentApiRequest(pathname)) {
    return NextResponse.next();
  }

  // Handle CORS preflight (OPTIONS) requests for API routes
  if (request.method === 'OPTIONS' && isApiRequest(pathname)) {
    const response = new NextResponse(null, { status: 204 });
    return addCorsHeaders(response, origin);
  }

  // Handle API requests with CORS headers
  if (isApiRequest(pathname)) {
    const response = NextResponse.next();
    return addCorsHeaders(response, origin);
  }

  // Lightweight public embeds/docs use the minimal layout.
  if (
    pathname === '/ticker' ||
    pathname.startsWith('/ticker/') ||
    pathname === '/api-docs' ||
    pathname.startsWith('/api-docs/')
  ) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-minimal-layout', '1');
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Research / model pilot form: no nav/sidebar (not linked in app).
  if (pathname === '/research' || pathname.startsWith('/research/')) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-minimal-layout', '1');
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // User signup onboarding: full-bleed page without sidebar/nav.
  if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-hide-app-chrome', '1');
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything (assets/API are allowed through in handler)
  matcher: ['/(.*)'],
};
