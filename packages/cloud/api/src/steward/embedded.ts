// Boots cloud API src steward embedded Worker infrastructure under Cloudflare runtime constraints.
import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_TTL_SECONDS = 60;
// Keep in lockstep with STEWARD_AUTH_UPSTREAM_TIMEOUT_MS in
// packages/cloud/shared/src/lib/auth/steward-client.ts. Inlined so this module
// (and the thin login path that loads it) does not pull the JWT/jose graph.
const STEWARD_AUTH_UPSTREAM_TIMEOUT_MS = 25_000;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

async function sha256TextHex(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value).buffer);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Steward's request-signature middleware HMACs this exact ordered list with a
 * shared secret and compares against `X-Steward-Signature: v1=<hex>`. Keep
 * this in lockstep with `canonicalRequest` in
 * Steward-Fi/steward:packages/api/src/middleware/authorization-signature.ts —
 * the upstream is authoritative; if it grows a new header or reorders, this
 * proxy starts shipping 401s and Magic Link / sensitive auth flows break.
 */
async function buildStewardCanonicalRequest(
  method: string,
  pathAndSearch: string,
  headers: Headers,
  body: ArrayBuffer,
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  const authHash = await sha256TextHex(headers.get("authorization") ?? "");
  const apiKeyHash = await sha256TextHex(headers.get("x-steward-key") ?? "");
  const platformKeyHash = await sha256TextHex(
    headers.get("x-steward-platform-key") ?? "",
  );
  const signerIdHash = await sha256TextHex(
    headers.get("x-steward-signer-id") ?? "",
  );
  const signerSecretHash = await sha256TextHex(
    headers.get("x-steward-signer-secret") ?? "",
  );
  const quorumIdHash = await sha256TextHex(
    headers.get("x-steward-key-quorum-id") ?? "",
  );
  const quorumCredentialsHash = await sha256TextHex(
    headers.get("x-steward-key-quorum-credentials") ?? "",
  );
  return [
    "steward-request-signature-v1",
    method.toUpperCase(),
    pathAndSearch,
    headers.get("x-steward-tenant") ?? "",
    authHash,
    apiKeyHash,
    platformKeyHash,
    signerIdHash,
    signerSecretHash,
    quorumIdHash,
    quorumCredentialsHash,
    headers.get("x-steward-request-timestamp") ?? "",
    headers.get("x-steward-request-expires-at") ?? "",
    headers.get("idempotency-key") ?? "",
    bodyHash,
  ].join("\n");
}

function stripStewardPrefix(pathname: string): string {
  if (pathname === "/steward") return "/";
  if (pathname.startsWith("/steward/"))
    return pathname.slice("/steward".length);
  return pathname;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const PUBLIC_STEWARD_TENANT_CONFIG = {
  features: {
    showFundingQR: true,
    showTransactionHistory: true,
    showSpendDashboard: true,
    showPolicyControls: true,
    showApprovalQueue: true,
    showSecretManager: false,
    enableSolana: true,
    showChainSelector: false,
    allowAddressExport: true,
  },
};

function isPublicStewardTenantConfigPath(pathname: string): boolean {
  return stripStewardPrefix(pathname).replace(/\/+$/, "") === "/tenants/config";
}

function isAuthProvidersPath(pathname: string): boolean {
  return stripStewardPrefix(pathname).replace(/\/+$/, "") === "/auth/providers";
}

function resolveStewardUpstream(
  env: AppEnv["Bindings"],
  requestUrl: URL,
): string | null {
  const candidates = [env.STEWARD_API_URL, env.NEXT_PUBLIC_STEWARD_API_URL];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0)
      continue;
    try {
      const url = new URL(candidate.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (
        url.origin === requestUrl.origin &&
        url.pathname.replace(/\/+$/, "") === "/steward"
      ) {
        continue;
      }
      return trimTrailingSlash(url.toString());
    } catch {
      // error-policy:J3 malformed configured upstream candidate; skip it and
      // try the next. All-invalid falls through to null (no upstream).
    }
  }
  return null;
}

type ProvidersData = {
  passkey?: boolean;
  email?: boolean;
  siwe?: boolean;
  siws?: boolean;
  google?: boolean;
  discord?: boolean;
  github?: boolean;
  oauth?: string[];
  [key: string]: unknown;
};

type ProvidersBody = ProvidersData & {
  ok?: boolean;
  data?: ProvidersData;
};

function hasOAuthCreds(
  env: AppEnv["Bindings"],
  provider: "google" | "discord" | "github",
): boolean {
  const id = env[`${provider.toUpperCase()}_CLIENT_ID` as keyof typeof env];
  const secret =
    env[`${provider.toUpperCase()}_CLIENT_SECRET` as keyof typeof env];
  return (
    typeof id === "string" &&
    id.length > 0 &&
    typeof secret === "string" &&
    secret.length > 0
  );
}

/**
 * Isolate-local cache for GET /auth/providers (#18049).
 *
 * The enabled provider set changes at deploy/config time (OAuth env + Steward
 * config), not per request. A short TTL cuts warm multi-sample p95 when the
 * upstream leg is still material after the thin entry path removes cold
 * bootstrap.
 *
 * Staleness bound (hard ceiling **60s from original fetch**):
 * - Isolate entry expires after PROVIDERS_CACHE_TTL_MS (60s), or sooner when
 *   `ELIZA_DEPLOY_COMMIT` changes (new deploy / key mismatch).
 * - Browser/shared `Cache-Control` is `public, max-age=<remaining>` only —
 *   **no** `stale-while-revalidate`. On hits we emit the *remaining* lifetime
 *   so isolate age + downstream max-age never compose past 60s from fetch
 *   (a hit at t=59s gets max-age=1, not a fresh max-age=60).
 * - No cross-isolate shared store; each Worker isolate has its own entry.
 */
export const PROVIDERS_CACHE_TTL_MS = 60_000;
/** Fresh-miss browser policy (full remaining budget at t=0). */
export const PROVIDERS_BROWSER_CACHE_CONTROL = "public, max-age=60";

type ProvidersCacheEntry = {
  body: ArrayBuffer;
  status: number;
  contentType: string;
  /** Absolute epoch ms when the isolate entry becomes unusable. */
  expiresAt: number;
  /** Absolute epoch ms of the upstream fetch that produced this body. */
  fetchedAt: number;
  deployCommit: string | null;
};

let providersResponseCache: ProvidersCacheEntry | null = null;

function providersCacheKey(env: AppEnv["Bindings"]): string | null {
  return env.ELIZA_DEPLOY_COMMIT?.trim() || null;
}

/**
 * Cache-Control for a response whose origin fetch was `ageMs` ago.
 * Always `public, max-age=<remaining>` with remaining ∈ [0, 60] seconds and
 * no stale-while-revalidate, so total age from fetch cannot exceed 60s.
 */
export function providersCacheControlForAgeMs(ageMs: number): string {
  const remainingMs = Math.max(0, PROVIDERS_CACHE_TTL_MS - Math.max(0, ageMs));
  const maxAgeSec = Math.ceil(remainingMs / 1000);
  return `public, max-age=${maxAgeSec}`;
}

function readProvidersCache(env: AppEnv["Bindings"]): Response | null {
  const entry = providersResponseCache;
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) return null;
  if (entry.deployCommit !== providersCacheKey(env)) return null;
  const ageMs = now - entry.fetchedAt;
  if (ageMs >= PROVIDERS_CACHE_TTL_MS) return null;
  return new Response(entry.body.slice(0), {
    status: entry.status,
    headers: {
      "content-type": entry.contentType,
      "cache-control": providersCacheControlForAgeMs(ageMs),
      age: String(Math.floor(ageMs / 1000)),
      "x-eliza-providers-cache": "hit",
    },
  });
}

async function writeProvidersCache(
  response: Response,
  env: AppEnv["Bindings"],
): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().arrayBuffer();
  const fetchedAt = Date.now();
  providersResponseCache = {
    body,
    status: response.status,
    contentType,
    fetchedAt,
    expiresAt: fetchedAt + PROVIDERS_CACHE_TTL_MS,
    deployCommit: providersCacheKey(env),
  };

  const headers = new Headers(response.headers);
  headers.set("cache-control", providersCacheControlForAgeMs(0));
  headers.set("age", "0");
  headers.set("x-eliza-providers-cache", "miss");
  return new Response(body.slice(0), {
    status: response.status,
    headers,
  });
}

/** Test helper — clears the isolate providers cache between cases. */
export function resetProvidersResponseCacheForTests(): void {
  providersResponseCache = null;
}

/** Test helper — force the current isolate entry past its expiry. */
export function expireProvidersResponseCacheForTests(): void {
  if (providersResponseCache) {
    providersResponseCache.expiresAt = Date.now() - 1;
  }
}

/**
 * Test helper — rewind/advance the isolate entry's clocks by `deltaMs`
 * (positive = age the entry as if that many ms already elapsed).
 */
export function ageProvidersResponseCacheForTests(deltaMs: number): void {
  if (!providersResponseCache) return;
  providersResponseCache.fetchedAt -= deltaMs;
  providersResponseCache.expiresAt -= deltaMs;
}

/**
 * The deployed Steward 0.3.9 image's `/auth/providers` returns `false` for
 * google/discord/github even when the OAuth env vars are populated, while the
 * `/auth/oauth/<provider>/authorize` flow still works. Patch the proxied
 * response so the frontend renders the buttons that actually function.
 */
async function patchProvidersResponse(
  upstream: Response,
  env: AppEnv["Bindings"],
): Promise<Response> {
  if (!upstream.ok) return upstream;
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return upstream;

  let parsed: ProvidersBody;
  try {
    parsed = (await upstream.clone().json()) as ProvidersBody;
  } catch {
    return upstream;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return upstream;
  }
  const providerData = parsed.data ?? parsed;
  const oauth = new Set<string>(providerData.oauth ?? []);
  const patched: ProvidersData = { ...providerData };

  for (const provider of ["google", "discord", "github"] as const) {
    if (!patched[provider] && hasOAuthCreds(env, provider)) {
      patched[provider] = true;
      oauth.add(provider);
    }
  }
  patched.oauth = [...oauth];

  const body = parsed.data
    ? { ...parsed, data: patched }
    : { ...parsed, ...patched };
  return Response.json(body, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

export const embeddedStewardHandler: MiddlewareHandler<AppEnv> = async (c) => {
  const url = new URL(c.req.url);
  if (c.req.method === "GET" && isPublicStewardTenantConfigPath(url.pathname)) {
    return c.json({ ok: true, data: PUBLIC_STEWARD_TENANT_CONFIG });
  }

  if (c.req.method === "GET" && isAuthProvidersPath(url.pathname)) {
    const cached = readProvidersCache(c.env);
    if (cached) return cached;
  }

  const upstream = resolveStewardUpstream(c.env, url);
  if (!upstream) {
    return c.json(
      {
        success: false,
        error: "steward_upstream_not_configured",
        message:
          "Set STEWARD_API_URL or NEXT_PUBLIC_STEWARD_API_URL to an external Steward API.",
      },
      503,
    );
  }

  const upstreamUrl = new URL(`${upstream}${stripStewardPrefix(url.pathname)}`);
  upstreamUrl.search = url.search;

  // The Steward backend gates mutating sensitive paths (/auth, /agents,
  // /vault, …) on BOTH a freshness header (X-Steward-Request-Expires-At) and
  // an HMAC-SHA256 of a canonical request string keyed by a shared secret
  // (`X-Steward-Signature: v1=<hex>`). The SDK does not send these on
  // browser-driven flows, so the Worker proxy signs them here on behalf of
  // the SPA. Without this, /auth/email/send (Magic Link) returns
  // `Request expiry header required` — see Steward
  // packages/api/src/middleware/{request-expiry,authorization-signature}.ts.
  const method = c.req.method.toUpperCase();
  const isMutating = MUTATING_METHODS.has(method);
  const rawSecret = c.env.STEWARD_REQUEST_SIGNING_SECRET;
  const signingSecret =
    typeof rawSecret === "string" && rawSecret.length > 0 ? rawSecret : null;

  let bodyBytes: ArrayBuffer | null = null;
  if (isMutating) {
    bodyBytes = await c.req.raw.clone().arrayBuffer();
  }

  const init: RequestInit = {
    method,
    headers: new Headers(c.req.raw.headers),
    body: bodyBytes,
    // Don't forward cf-specific properties that confuse fetch on cross-zone calls.
    redirect: "manual",
    // This proxy carries the magic-link send/verify legs, which Steward has
    // been observed serving in up to 15s — bound it above that instead of
    // leaving it unbounded (the one upstream fetch the DoS-timeout sweep
    // missed).
    signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
  };
  const headers = init.headers as Headers;
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  // Strip the host header that Workers carries from the inbound request — the
  // upstream fetch sets its own.
  headers.delete("host");

  // Forward the real inbound origin so Steward's origin-gated auth checks pass.
  // Steward's SIWE/SIWS `GET /auth/nonce` rejects a request that carries
  // neither an allowed `Origin` nor `Referer` ("SIWE nonce requests require an
  // allowed Origin or Referer"). The SDK calls Steward through THIS same-origin
  // proxy, so on that GET the browser sends no `Origin` at all, and its
  // `Referer` is a fetch-forbidden header that never survives the Worker
  // subrequest. The outer Pages proxy fills this gap with the browser-facing
  // origin before its service binding rewrites the URL to the API host. Direct
  // API requests have no outer proxy, so use their own request origin as the
  // fallback. A real browser `Origin` (cross-origin/POST legs) is preserved.
  // `Origin` is not part of the signed canonical request (see the hashed-header
  // set above), so this ordering is safe for signed mutating legs.
  if (!headers.has("origin")) {
    headers.set("origin", url.origin);
  }

  // Pin the tenant per-env. Steward's email/passkey routes resolve tenant
  // from `X-Steward-Tenant || body.tenantId || STEWARD_DEFAULT_TENANT_ID`
  // (auth.ts:2171,2200,2246), so forcing the header keeps those flows scoped
  // even when the SPA's `NEXT_PUBLIC_STEWARD_TENANT_ID` isn't inlined.
  // OAuth `/authorize` is NOT covered: it reads tenant only from the
  // `tenant_id` query param (auth.ts:2294), so OAuth tenant isolation still
  // depends on the SPA building the URL with the right id — that's wired
  // separately via `NEXT_PUBLIC_STEWARD_TENANT_ID` in cloud-frontend's
  // wrangler.toml `[env.preview.vars]`.
  const pinnedTenantId = c.env.STEWARD_TENANT_ID;
  if (typeof pinnedTenantId === "string" && pinnedTenantId.trim().length > 0) {
    headers.set("x-steward-tenant", pinnedTenantId.trim());
  }

  if (isMutating && signingSecret && bodyBytes) {
    const expiresAt = Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS;
    headers.set("x-steward-request-expires-at", String(expiresAt));
    // Steward's idempotency middleware requires Idempotency-Key on every
    // signed mutating request. Use the SPA-supplied value when present so
    // retries dedup, otherwise stamp a fresh UUID v4 just to satisfy the
    // gate — without it Steward rejects with "Signed requests require an
    // Idempotency-Key header" (packages/api/src/middleware/idempotency.ts).
    if (!headers.get("idempotency-key")) {
      headers.set("idempotency-key", crypto.randomUUID());
    }
    const canonical = await buildStewardCanonicalRequest(
      method,
      `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers,
      bodyBytes,
    );
    const signature = await hmacSha256Hex(signingSecret, canonical);
    headers.set("x-steward-signature", `v1=${signature}`);
  }

  let response: Response;
  try {
    response = await fetch(upstreamUrl.toString(), init);
  } catch (error) {
    logger.error("[embedded-steward] upstream transport failure", {
      message: error instanceof Error ? error.message : String(error),
      path: url.pathname,
    });
    return c.json(
      {
        success: false,
        error: "steward_upstream_unavailable",
        code: "steward_upstream_unavailable",
        message: "Steward upstream unavailable",
      },
      502,
    );
  }
  if (c.req.method === "GET" && isAuthProvidersPath(url.pathname)) {
    const patched = await patchProvidersResponse(response, c.env);
    return writeProvidersCache(patched, c.env);
  }
  return response;
};
