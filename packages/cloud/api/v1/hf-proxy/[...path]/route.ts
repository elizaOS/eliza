/**
 * GET /api/v1/hf-proxy/[...path]
 *
 * Authenticated, server-side HuggingFace download proxy. Devices never hold a
 * local HuggingFace token: when linked to Eliza Cloud they route every gated
 * eliza-1 bundle `resolve` request through here, and the cloud attaches its own
 * `HF_TOKEN` so gated repos download without exposing a key to the client.
 *
 * The catch-all path is the exact HuggingFace `resolve` suffix the client built
 * (`<repo>/resolve/<rev>/<file>`), so the upstream URL is reconstructed 1:1 and
 * the body is streamed back unbuffered, preserving the headers a resumable
 * downloader depends on (content-length, content-range, accept-ranges, etag,
 * content-type). `Range` is forwarded so 206 partial-content resume works.
 *
 * SECURITY: only paths containing a `/resolve/` segment on huggingface.co are
 * forwarded — the route never proxies an arbitrary host or path, and the
 * upstream host is fixed (no client-controlled hostname), so it cannot be used
 * as an open SSRF relay. The target repo is additionally scoped to the curated
 * eliza-1 org (`ALLOWED_REPO_PREFIX`): the cloud's own `HF_TOKEN` may only be
 * spent proxying the shipping catalog, never an arbitrary user-chosen repo.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger, redact } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const HF_UPSTREAM_HOST = "https://huggingface.co";
const DEFAULT_MONTHLY_EGRESS_LIMIT_BYTES = 500 * 1024 ** 3;
const MONTHLY_EGRESS_TTL_SECONDS = 35 * 24 * 60 * 60;

/**
 * Only repos under this org may be proxied. The curated eliza-1 catalog lives at
 * `elizaos/eliza-1` (`ELIZA_1_HF_REPO` in `@elizaos/shared/local-inference`);
 * scoping to the org prefix keeps the cloud's `HF_TOKEN` from being used to
 * download arbitrary — including gated third-party — HuggingFace repos on the
 * cloud's bandwidth/quota.
 *
 * This literal is deliberately not imported from the shared barrel (that barrel
 * transitively pulls node-oriented helpers into this Cloudflare Worker route for
 * a single constant). Instead it MUST stay in sync with the org segment of
 * `ELIZA_1_HF_REPO`; `packages/cloud/api/__tests__/hf-proxy-route.test.ts`
 * asserts the two agree so a future rename of the shared repo can't silently
 * un-scope the allowlist. Exported for that test.
 */
export const ALLOWED_REPO_PREFIX = "elizaos/";

/**
 * A HuggingFace resolve path is `<owner>/<repo>/resolve/<rev>/<file>`. Return the
 * `<owner>/<repo>` slug, or `null` if the path is not a well-formed resolve path.
 */
export function repoFromResolvePath(path: string): string | null {
  const resolveIdx = path.indexOf("/resolve/");
  if (resolveIdx <= 0) return null;
  const repo = path.slice(0, resolveIdx);
  // Require exactly `<owner>/<repo>` — reject empty segments.
  const segments = repo.split("/");
  if (segments.length !== 2 || segments.some((s) => s.length === 0))
    return null;
  return repo;
}

/** Response headers worth preserving for a resumable streaming download. */
const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "content-disposition",
] as const;

const app = new Hono<AppEnv>();

interface EgressCounter {
  bytes: number;
  expiresAt: number;
}

const inMemoryEgressCounters = new Map<string, EgressCounter>();

function monthlyEgressLimitBytes(env: AppEnv["Bindings"]): number {
  const raw = env.HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES;
  const parsed =
    typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MONTHLY_EGRESS_LIMIT_BYTES;
}

function monthBucket(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function egressKey(organizationId: string, now = new Date()): string {
  return `hf-proxy:egress:${organizationId}:${monthBucket(now)}`;
}

async function readMonthlyEgress(
  env: AppEnv["Bindings"],
  organizationId: string,
): Promise<number> {
  const key = egressKey(organizationId);
  const kv = env.CACHE_KV;
  if (kv) {
    const raw = await kv.get(key);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw) as { bytes?: unknown };
      return typeof parsed.bytes === "number" ? parsed.bytes : 0;
    } catch {
      return 0;
    }
  }

  const now = Date.now();
  const counter = inMemoryEgressCounters.get(key);
  if (!counter || counter.expiresAt <= now) {
    inMemoryEgressCounters.delete(key);
    return 0;
  }
  return counter.bytes;
}

async function addMonthlyEgress(
  env: AppEnv["Bindings"],
  organizationId: string,
  bytes: number,
): Promise<number> {
  if (bytes <= 0) return readMonthlyEgress(env, organizationId);

  const key = egressKey(organizationId);
  const kv = env.CACHE_KV;
  const current = await readMonthlyEgress(env, organizationId);
  const next = current + bytes;
  const value = JSON.stringify({
    bytes: next,
    updatedAt: new Date().toISOString(),
  });
  if (kv) {
    await kv.put(key, value, { expirationTtl: MONTHLY_EGRESS_TTL_SECONDS });
  } else {
    inMemoryEgressCounters.set(key, {
      bytes: next,
      expiresAt: Date.now() + MONTHLY_EGRESS_TTL_SECONDS * 1000,
    });
  }
  return next;
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cacheStatus(headers: Headers): string | null {
  return headers.get("cf-cache-status") ?? headers.get("x-cache") ?? null;
}

function cacheHit(value: string | null): boolean | null {
  if (!value) return null;
  return /\bhit\b/i.test(value);
}

function egressLimitResponse(
  organizationId: string,
  limitBytes: number,
  usedBytes: number,
) {
  return {
    error: "HuggingFace proxy monthly egress budget exceeded.",
    code: "HF_PROXY_EGRESS_LIMIT",
    organization_id: organizationId,
    limit_bytes: limitBytes,
    used_bytes: usedBytes,
  };
}

function streamWithEgressAccounting(args: {
  body: ReadableStream<Uint8Array>;
  env: AppEnv["Bindings"];
  organizationId: string;
  repo: string;
  path: string;
  status: number;
  cacheStatus: string | null;
}): ReadableStream<Uint8Array> {
  let bytes = 0;
  return args.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      async flush() {
        const record = addMonthlyEgress(
          args.env,
          args.organizationId,
          bytes,
        ).then((usedBytes) => {
          logger.info("[hf-proxy] egress metric", {
            organizationId: args.organizationId,
            repo: args.repo,
            path: args.path,
            bytes,
            status: args.status,
            cacheStatus: args.cacheStatus,
            cacheHit: cacheHit(args.cacheStatus),
            usedBytes,
          });
        });
        await record;
      },
    }),
  );
}

app.get("/*", async (c) => {
  try {
    // Auth: a real cloud session or org API key. We require a valid linked
    // account and capture the identity for usage attribution below.
    const account = await requireUserOrApiKeyWithOrg(c);
    const userId = account.id;
    const orgId = account.organization_id;
    if (!orgId) {
      return c.json({ error: "Organization is required." }, 403);
    }

    const hfToken = c.env.HF_TOKEN?.trim();
    if (!hfToken) {
      logger.error("[hf-proxy] HF_TOKEN binding is not configured");
      return c.json(
        { error: "HuggingFace proxy is not configured on this deployment." },
        503,
      );
    }

    const path = (c.req.param("*") ?? "").replace(/^\/+/, "");
    // Only forward genuine HuggingFace download paths.
    if (!path.includes("/resolve/")) {
      return c.json(
        { error: "Only HuggingFace resolve paths are proxied." },
        400,
      );
    }

    // Scope the cloud HF_TOKEN to the curated eliza-1 catalog. Any repo outside
    // the allowed org is refused — the token must never be spent on arbitrary
    // third-party downloads on the cloud's bandwidth/quota.
    const repo = repoFromResolvePath(path);
    if (!repo?.startsWith(ALLOWED_REPO_PREFIX)) {
      logger.warn("[hf-proxy] rejected out-of-catalog repo", {
        repo: repo ?? "[unparseable]",
        orgId: redact.orgId(orgId),
        userId: redact.userId(userId),
      });
      return c.json(
        { error: "This HuggingFace repo is not available through the proxy." },
        403,
      );
    }

    const limitBytes = monthlyEgressLimitBytes(c.env);
    const usedBytes = await readMonthlyEgress(c.env, orgId);
    if (usedBytes >= limitBytes) {
      return c.json(egressLimitResponse(orgId, limitBytes, usedBytes), 429);
    }

    const incomingUrl = new URL(c.req.url);
    const upstream = new URL(`${HF_UPSTREAM_HOST}/${path}`);
    // Preserve the original query (e.g. ?download=true) verbatim.
    upstream.search = incomingUrl.search;

    const headers = new Headers();
    headers.set("authorization", `Bearer ${hfToken}`);
    headers.set("user-agent", "ElizaCloud-HfProxy/1.0");
    const range = c.req.header("range");
    if (range) headers.set("range", range);

    const upstreamResponse = await fetch(upstream, {
      method: "GET",
      headers,
      redirect: "follow",
    });

    if (upstreamResponse.status >= 400) {
      logger.warn("[hf-proxy] upstream HuggingFace error", {
        path,
        status: upstreamResponse.status,
      });
    }

    // Cost/usage observability: a single GGUF proxied here can be multiple GB on
    // the cloud's bandwidth and HF quota. Record who pulled what and how large,
    // so an operator has visibility into an otherwise-unmetered transfer.
    const contentLength = parseContentLength(upstreamResponse.headers);
    logger.info("[hf-proxy] proxied download", {
      repo,
      path,
      status: upstreamResponse.status,
      bytes: contentLength,
      orgId: redact.orgId(orgId),
      userId: redact.userId(userId),
    });

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      const upstreamCacheStatus = cacheStatus(upstreamResponse.headers);
      logger.info("[hf-proxy] egress metric", {
        organizationId: orgId,
        repo,
        path,
        bytes: 0,
        status: upstreamResponse.status,
        cacheStatus: upstreamCacheStatus,
        cacheHit: cacheHit(upstreamCacheStatus),
        usedBytes,
      });
      return c.json(
        {
          error: "HuggingFace repo is gated or unauthorized.",
          code: "HF_GATED",
          repo,
        },
        upstreamResponse.status as 401 | 403,
      );
    }

    if (contentLength !== null && usedBytes + contentLength > limitBytes) {
      return c.json(egressLimitResponse(orgId, limitBytes, usedBytes), 429);
    }

    const responseHeaders = new Headers();
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const body = upstreamResponse.body
      ? streamWithEgressAccounting({
          body: upstreamResponse.body,
          env: c.env,
          organizationId: orgId,
          repo,
          path,
          status: upstreamResponse.status,
          cacheStatus: cacheStatus(upstreamResponse.headers),
        })
      : null;

    // Stream the body straight through — never buffer a multi-GB GGUF.
    return new Response(body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
