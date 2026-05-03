/**
 * Core proxy handler.
 *
 * Implements the full credential injection flow:
 *   1. Parse target from request path (alias or direct)
 *   2. Find matching secret route for (tenantId, host, path, method)
 *   3. Decrypt credential from secret vault
 *   4. Build outbound request with injected credential
 *   5. Forward request, stream response back
 *   6. Log audit entry
 *   7. Zero credential from memory
 */

import type { SecretRoute } from "@stwd/db";
import { getDb, secretRoutes, secrets } from "@stwd/db";
import { KeyStore } from "@stwd/vault";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { recordAudit } from "../middleware/audit";
import {
  checkProxyRateLimit,
  isProxyRedisAvailable,
  trackProxySpend,
} from "../middleware/redis-enforcement";
import { resolveTarget } from "./alias";
import { matchHost, matchPath } from "./matching";

// ─── Keystore singleton ──────────────────────────────────────────────────────

let _keyStore: KeyStore | null = null;

function getKeyStore(): KeyStore {
  if (!_keyStore) {
    const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
    if (!masterPassword) {
      throw new Error("STEWARD_MASTER_PASSWORD is required for secret decryption");
    }
    _keyStore = new KeyStore(masterPassword);
  }
  return _keyStore;
}

// ─── Route matching ──────────────────────────────────────────────────────────

/**
 * Find the best matching secret route for a request.
 *
 * Routes are matched by:
 *   - tenant_id (exact)
 *   - host_pattern (exact match or wildcard)
 *   - path_pattern (prefix match with wildcard)
 *   - method (* or exact match)
 *   - enabled = true
 *
 * Returns the highest-priority matching route, or null.
 */
async function findMatchingRoute(
  tenantId: string,
  host: string,
  path: string,
  method: string,
): Promise<SecretRoute | null> {
  const db = getDb();

  // Fetch all enabled routes for this tenant, ordered by priority desc
  const routes = await db
    .select()
    .from(secretRoutes)
    .where(and(eq(secretRoutes.tenantId, tenantId), eq(secretRoutes.enabled, true)))
    .orderBy(desc(secretRoutes.priority));

  // Match in priority order (first match wins)
  for (const route of routes) {
    if (!matchHost(route.hostPattern, host)) continue;
    if (!matchPath(route.pathPattern ?? "/*", path)) continue;
    if (route.method !== "*" && route.method?.toUpperCase() !== method.toUpperCase()) continue;
    return route;
  }

  return null;
}

// matchHost and matchPath imported from ./matching

// ─── Secret decryption ───────────────────────────────────────────────────────

/**
 * Decrypt a secret by its ID using the vault keystore.
 * Returns the plaintext credential value.
 */
async function decryptSecret(secretId: string): Promise<string> {
  const db = getDb();
  const [secret] = await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1);

  if (!secret) {
    throw new Error(`Secret ${secretId} not found`);
  }

  const keyStore = getKeyStore();
  return keyStore.decrypt({
    ciphertext: secret.ciphertext,
    iv: secret.iv,
    tag: secret.authTag,
    salt: secret.salt,
  });
}

// ─── Credential injection ────────────────────────────────────────────────────

/**
 * Inject a credential into the outbound request based on the route config.
 */
function injectCredential(
  headers: Headers,
  url: URL,
  body: ReadableStream<Uint8Array> | null,
  route: SecretRoute,
  credential: string,
): { headers: Headers; url: URL; body: ReadableStream<Uint8Array> | null } {
  const formattedValue = (route.injectFormat ?? "{value}").replace("{value}", credential);

  switch (route.injectAs) {
    case "header":
      headers.set(route.injectKey, formattedValue);
      break;

    case "query":
      url.searchParams.set(route.injectKey, formattedValue);
      break;

    case "body":
      // Body injection is complex (need to parse/modify JSON).
      // For now, only header and query injection are supported.
      // Body injection will be added when we have a concrete use case.
      console.warn(
        `[proxy] Body injection requested for ${route.hostPattern} but not yet implemented`,
      );
      break;

    default:
      console.warn(`[proxy] Unknown inject_as: ${route.injectAs}`);
  }

  return { headers, url, body };
}

// ─── Main proxy handler ──────────────────────────────────────────────────────

/**
 * Handle a proxied request.
 *
 * This is the catch-all handler mounted on the Hono app.
 * Auth middleware has already run, so agentId and tenantId are available.
 */
export async function handleProxy(c: Context): Promise<Response> {
  const startTime = Date.now();
  const agentId = c.get("agentId") as string;
  const tenantId = c.get("tenantId") as string;
  const method = c.req.method;

  // 1. Resolve target URL from request path
  const target = resolveTarget(c.req.path);
  if (!target) {
    return c.json(
      {
        ok: false,
        error:
          "Could not resolve target from request path. Use a named alias (e.g. /openai/...) or /proxy/hostname/path",
      },
      400,
    );
  }

  // 2. Find matching secret route
  const route = await findMatchingRoute(tenantId, target.host, target.path, method);
  if (!route) {
    return c.json(
      {
        ok: false,
        error: `No credential route configured for ${target.host}${target.path}`,
      },
      403,
    );
  }

  // 2.5. Redis rate-limit check (per agent + host)
  const rlResult = await checkProxyRateLimit(agentId, target.host);
  if (!rlResult.allowed) {
    c.header("Retry-After", String(Math.ceil(rlResult.resetMs / 1000)));
    c.header("X-RateLimit-Remaining", "0");
    c.header("X-RateLimit-Reset", String(Math.ceil(rlResult.resetMs / 1000)));
    return c.json(
      {
        ok: false,
        error: `Rate limit exceeded for ${target.host}. Retry after ${Math.ceil(rlResult.resetMs / 1000)}s`,
      },
      429,
    );
  }

  // 3. Decrypt credential
  let credential: string;
  try {
    credential = await decryptSecret(route.secretId);
  } catch (err) {
    console.error(`[proxy] Failed to decrypt secret ${route.secretId}:`, err);
    return c.json({ ok: false, error: "Failed to decrypt credential" }, 500);
  }

  // 4. Build outbound request
  const outboundUrl = new URL(target.url);
  const outboundHeaders = new Headers();

  // Forward original headers, stripping auth and hop-by-hop headers
  const skipHeaders = new Set([
    "authorization",
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
  ]);

  for (const [key, value] of c.req.raw.headers.entries()) {
    if (!skipHeaders.has(key.toLowerCase())) {
      outboundHeaders.set(key, value);
    }
  }

  // Set the correct host header for the target
  outboundHeaders.set("host", outboundUrl.host);

  // Inject credential
  injectCredential(outboundHeaders, outboundUrl, null, route, credential);

  // 5. Forward request to real API (streaming passthrough)
  let response: Response;
  try {
    response = await fetch(outboundUrl.toString(), {
      method,
      headers: outboundHeaders,
      body: method !== "GET" && method !== "HEAD" ? c.req.raw.body : undefined,
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: "half",
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    console.error(`[proxy] Upstream request failed:`, err);

    // Audit the failure
    recordAudit({
      agentId,
      tenantId,
      targetHost: target.host,
      targetPath: target.path,
      method,
      statusCode: 502,
      latencyMs,
    });

    return c.json({ ok: false, error: "Upstream request failed" }, 502);
  } finally {
    // 6. Zero credential from memory
    // In JS we can't truly zero strings, but we can dereference immediately.
    // The credential variable goes out of scope here.
    credential = "";
  }

  const latencyMs = Date.now() - startTime;

  // 7. Audit log (fire-and-forget)
  recordAudit({
    agentId,
    tenantId,
    targetHost: target.host,
    targetPath: target.path,
    method,
    statusCode: response.status,
    latencyMs,
  });

  // 7.5. Spend tracking for LLM API responses (fire-and-forget)
  //
  // For known LLM hosts, we need to read the response body to extract token
  // usage for cost estimation. We buffer the response body, parse it, track
  // the cost, and still return the body to the client.
  //
  // For non-LLM hosts or streaming responses, we pass through without buffering.
  let responseBody: ReadableStream<Uint8Array> | ArrayBuffer | null = response.body;
  const contentType = response.headers.get("content-type") || "";
  const isJsonResponse = contentType.includes("application/json");
  const isLLMHost =
    isProxyRedisAvailable() &&
    (target.host === "api.openai.com" || target.host === "api.anthropic.com");

  if (
    isLLMHost &&
    isJsonResponse &&
    response.status >= 200 &&
    response.status < 300 &&
    response.body
  ) {
    try {
      const bodyBuffer = await response.arrayBuffer();
      const bodyText = new TextDecoder().decode(bodyBuffer);
      const parsedResponse = JSON.parse(bodyText);

      // Try to get the request body for model detection
      // We clone what we can from the original request
      let requestBodyParsed: any = null;
      try {
        // The request body may have been consumed, so we extract model from response
        requestBodyParsed = { model: parsedResponse?.model };
      } catch {
        // Ignore — cost estimator handles missing request body
      }

      // Track spend asynchronously
      trackProxySpend(agentId, tenantId, target.host, requestBodyParsed, parsedResponse).catch(
        (err) => console.error("[proxy] Spend tracking failed:", err),
      );

      responseBody = bodyBuffer;
    } catch {
      // If body parsing fails, just pass through the original response body
      // This can happen with streaming responses
    }
  }

  // 8. Build response — stream body through without buffering
  const responseHeaders = new Headers();
  const skipResponseHeaders = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
  ]);

  for (const [key, value] of response.headers.entries()) {
    if (!skipResponseHeaders.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// ─── Exports for testing ─────────────────────────────────────────────────────

export { findMatchingRoute };
