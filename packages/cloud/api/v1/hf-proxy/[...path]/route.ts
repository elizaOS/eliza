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
 *
 * EGRESS & CONCURRENCY: a per-organization Durable Object (`HF_PROXY_GATES`)
 * atomically reserves bytes and holds a concurrent-download slot for every
 * request. This replaces the original non-atomic KV read/put counter, which
 * lost increments under concurrency and let concurrent requests all read the
 * same pre-update value. The DO also enforces a per-org concurrent-download
 * cap so one org cannot saturate the Worker's subrequests.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger, redact } from "@/lib/utils/logger";
import type {
  AppEnv,
  RuntimeDurableObjectStub,
} from "@/types/cloud-worker-env";

const HF_UPSTREAM_HOST = "https://huggingface.co";
const DEFAULT_MONTHLY_EGRESS_LIMIT_BYTES = 500 * 1024 ** 3;
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 4;
const GATE_ORIGIN = "https://hf-proxy-gate.internal";
const GATE_TIMEOUT_MS = 3_000;
const GATE_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

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

// ---- Egress policy helpers ----

function parseSafeInteger(value: unknown, minimum: number): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function monthlyEgressLimitBytes(env: AppEnv["Bindings"]): number {
  return (
    parseSafeInteger(env.HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES, 1) ??
    DEFAULT_MONTHLY_EGRESS_LIMIT_BYTES
  );
}

function maxConcurrentDownloads(env: AppEnv["Bindings"]): number {
  return (
    parseSafeInteger(env.HF_PROXY_MAX_CONCURRENT_DOWNLOADS, 1) ??
    DEFAULT_MAX_CONCURRENT_DOWNLOADS
  );
}

function monthBucket(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) return null;
  return parseSafeInteger(value, 0);
}

function cacheStatus(headers: Headers): string | null {
  return headers.get("cf-cache-status") ?? headers.get("x-cache") ?? null;
}

function cacheHit(value: string | null): boolean | null {
  if (!value) return null;
  return /\bhit\b/i.test(value);
}

// ---- Durable Object gate client ----

function getGateStub(
  env: AppEnv["Bindings"],
  orgId: string,
): RuntimeDurableObjectStub | null {
  const ns = env.HF_PROXY_GATES;
  if (!ns) return null;
  return ns.getByName(orgId);
}

interface ReserveDecision {
  admitted: boolean;
  usedBytes: number;
  limitBytes: number;
  activeDownloads: number;
  maxConcurrent: number;
}

async function gateReserve(
  stub: RuntimeDurableObjectStub,
  requestId: string,
  estimatedBytes: number,
  limitBytes: number,
  maxConcurrent: number,
  bucket: string,
): Promise<ReserveDecision> {
  const response = await stub.fetch(
    new Request(`${GATE_ORIGIN}/reserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        estimatedBytes,
        limitBytes,
        maxConcurrent,
        monthBucket: bucket,
      }),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    }),
  );
  const body = (await response.json()) as Partial<ReserveDecision> & {
    error?: string;
    code?: string;
  };
  if (!response.ok && response.status !== 429) {
    throw new HfProxyGateError(
      body.error ?? "HF proxy gate is unavailable",
      body.code,
    );
  }
  if (!body || typeof body.admitted !== "boolean") {
    throw new HfProxyGateError(
      "HF proxy gate returned an invalid reserve response",
    );
  }
  return body as ReserveDecision;
}

async function gateSettle(
  stub: RuntimeDurableObjectStub,
  requestId: string,
  actualBytes: number,
  bucket: string,
): Promise<void> {
  const response = await stub.fetch(
    new Request(`${GATE_ORIGIN}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        actualBytes,
        monthBucket: bucket,
      }),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    }),
  );
  if (!response.ok) {
    throw new HfProxyGateError(
      `HF proxy gate settlement failed with status ${response.status}`,
    );
  }
}

async function gateCancel(
  stub: RuntimeDurableObjectStub,
  requestId: string,
  bucket: string,
): Promise<void> {
  const response = await stub.fetch(
    new Request(`${GATE_ORIGIN}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, monthBucket: bucket }),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    }),
  );
  if (!response.ok) {
    throw new HfProxyGateError(
      `HF proxy gate cancellation failed with status ${response.status}`,
    );
  }
}

async function gateHeartbeat(
  stub: RuntimeDurableObjectStub,
  requestId: string,
  bucket: string,
): Promise<void> {
  const response = await stub.fetch(
    new Request(`${GATE_ORIGIN}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, monthBucket: bucket }),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    }),
  );
  if (!response.ok) {
    throw new HfProxyGateError(
      `HF proxy gate heartbeat failed with status ${response.status}`,
    );
  }
}

function startGateHeartbeat(
  stub: RuntimeDurableObjectStub,
  requestId: string,
  bucket: string,
  onFailure: (error: unknown) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await gateHeartbeat(stub, requestId, bucket);
        schedule();
      } catch (error) {
        // error-policy:J1 The caller aborts the active upstream operation and
        // exposes the lease failure at the response boundary.
        stopped = true;
        onFailure(error);
      }
    }, GATE_HEARTBEAT_INTERVAL_MS);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}

async function cancelUpstreamBody(
  response: Response,
  reason: string,
): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch (error) {
    // error-policy:J6 The proxy response is already terminal; upstream body
    // cancellation is best-effort teardown and must not hide gate cleanup.
    logger.warn("[hf-proxy] upstream body cancellation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class HfProxyGateError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "HfProxyGateError";
    this.code = code;
  }
}

function concurrencyLimitResponse(
  organizationId: string,
  activeDownloads: number,
  maxConcurrent: number,
) {
  return {
    error: "HuggingFace proxy concurrent download limit reached.",
    code: "HF_PROXY_CONCURRENCY_LIMIT",
    organization_id: organizationId,
    active_downloads: activeDownloads,
    max_concurrent: maxConcurrent,
  };
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

/**
 * Wrap the upstream body so every byte is counted as it flows through, and the
 * final actual byte count is settled against the gate regardless of whether the
 * stream completes or is cancelled mid-way. The explicit readable wrapper
 * observes consumer cancellation reliably and reserves any bytes beyond the
 * upstream Content-Length before forwarding them.
 */
function streamWithEgressAccounting(args: {
  body: ReadableStream<Uint8Array>;
  gateStub: RuntimeDurableObjectStub;
  requestId: string;
  monthBucket: string;
  organizationId: string;
  repo: string;
  path: string;
  status: number;
  cacheStatusValue: string | null;
  initialReservedBytes: number;
  limitBytes: number;
  maxConcurrent: number;
}): ReadableStream<Uint8Array> {
  const reader = args.body.getReader();
  let bytes = 0;
  let reservedBytes = args.initialReservedBytes;
  let settled = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatFailure: unknown;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const scheduleHeartbeat = (): void => {
    if (settled) return;
    heartbeatTimer = setTimeout(async () => {
      try {
        await gateHeartbeat(args.gateStub, args.requestId, args.monthBucket);
        scheduleHeartbeat();
      } catch (error) {
        // error-policy:J1 The stream boundary exposes heartbeat failure to its
        // consumer after cancelling the upstream reader here.
        heartbeatFailure = error;
        try {
          await reader.cancel(error);
        } catch (cancelError) {
          // error-policy:J6 Heartbeat failure is already preserved for the
          // consumer; reader cancellation is best-effort teardown.
          logger.warn("[hf-proxy] upstream reader cancellation failed", {
            error:
              cancelError instanceof Error
                ? cancelError.message
                : String(cancelError),
          });
        }
      }
    }, GATE_HEARTBEAT_INTERVAL_MS);
  };
  scheduleHeartbeat();

  const settleOnce = async (finalBytes: number): Promise<void> => {
    if (settled) return;
    settled = true;
    stopHeartbeat();
    try {
      await gateSettle(
        args.gateStub,
        args.requestId,
        finalBytes,
        args.monthBucket,
      );
      logger.info("[hf-proxy] egress metric", {
        organizationId: args.organizationId,
        repo: args.repo,
        path: args.path,
        bytes: finalBytes,
        status: args.status,
        cacheStatus: args.cacheStatusValue,
        cacheHit: cacheHit(args.cacheStatusValue),
      });
    } catch (error) {
      // error-policy:J1 The response stream exposes failed settlement instead
      // of reporting accounting success or silently leaking its slot.
      logger.warn("[hf-proxy] egress settle failed", {
        requestId: args.requestId,
        actualBytes: finalBytes,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (heartbeatFailure) throw heartbeatFailure;
        if (result.done) {
          await settleOnce(bytes);
          controller.close();
          return;
        }

        const nextBytes = bytes + result.value.byteLength;
        if (nextBytes > reservedBytes) {
          const reserve = await gateReserve(
            args.gateStub,
            args.requestId,
            nextBytes,
            args.limitBytes,
            args.maxConcurrent,
            args.monthBucket,
          );
          if (!reserve.admitted) {
            await reader.cancel("HF proxy egress limit reached");
            await settleOnce(bytes);
            controller.error(
              new HfProxyGateError(
                "HF proxy egress limit reached while streaming",
              ),
            );
            return;
          }
          reservedBytes = nextBytes;
        }

        bytes = nextBytes;
        controller.enqueue(result.value);
      } catch (error) {
        // error-policy:J1 The response stream exposes upstream/accounting
        // failures to its consumer after settling bytes already delivered.
        await settleOnce(bytes);
        controller.error(error);
      }
    },
    async cancel(reason) {
      stopHeartbeat();
      try {
        await reader.cancel(reason);
      } finally {
        // error-policy:J6 Cancellation releases the upstream reader and settles
        // the partial transfer before teardown completes.
        await settleOnce(bytes);
      }
    },
  });
}

app.get("/*", async (c) => {
  const requestId = crypto.randomUUID();
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

    // ---- Atomic egress reservation + concurrency check via Durable Object ----
    const gateStub = getGateStub(c.env, orgId);
    if (!gateStub) {
      // No DO binding: fail closed. We never silently fall back to the old
      // non-atomic KV counter, which could reset an org's budget.
      logger.error("[hf-proxy] HF_PROXY_GATES binding is missing");
      return c.json(
        {
          error: "HuggingFace proxy egress accounting is not configured.",
          code: "HF_PROXY_GATE_UNAVAILABLE",
        },
        503,
      );
    }

    const limitBytes = monthlyEgressLimitBytes(c.env);
    const maxConcurrent = maxConcurrentDownloads(c.env);
    const bucket = monthBucket();

    // Reserve with zero estimated bytes initially; the actual content-length is
    // only known after the upstream fetch. We hold the concurrency slot first.
    let reserve: ReserveDecision;
    try {
      reserve = await gateReserve(
        gateStub,
        requestId,
        0,
        limitBytes,
        maxConcurrent,
        bucket,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[hf-proxy] egress reserve failed", {
        requestId,
        orgId: redact.orgId(orgId),
        error: message,
      });
      return c.json(
        {
          error: "HuggingFace proxy egress accounting is unavailable.",
          code: "HF_PROXY_GATE_UNAVAILABLE",
        },
        503,
      );
    }

    if (!reserve.admitted) {
      // Distinguish egress-exhausted from concurrency-exhausted.
      if (reserve.activeDownloads >= reserve.maxConcurrent) {
        return c.json(
          concurrencyLimitResponse(
            orgId,
            reserve.activeDownloads,
            reserve.maxConcurrent,
          ),
          429,
        );
      }
      return c.json(
        egressLimitResponse(orgId, reserve.limitBytes, reserve.usedBytes),
        429,
      );
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

    const upstreamAbortController = new AbortController();
    let upstreamHeartbeatFailure: unknown;
    const stopUpstreamHeartbeat = startGateHeartbeat(
      gateStub,
      requestId,
      bucket,
      (error) => {
        upstreamHeartbeatFailure = error;
        upstreamAbortController.abort(error);
      },
    );

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstream, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: upstreamAbortController.signal,
      });
    } catch (error) {
      // Upstream fetch failed: release the slot without charging.
      stopUpstreamHeartbeat();
      await gateCancel(gateStub, requestId, bucket);
      throw upstreamHeartbeatFailure ?? error;
    }

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
      });
      // Gated/unauthorized: release the concurrency slot without charging.
      stopUpstreamHeartbeat();
      await cancelUpstreamBody(upstreamResponse, "HF upstream unauthorized");
      await gateCancel(gateStub, requestId, bucket);
      return c.json(
        {
          error: "HuggingFace repo is gated or unauthorized.",
          code: "HF_GATED",
          repo,
        },
        upstreamResponse.status as 401 | 403,
      );
    }

    // Atomically update the slot with Content-Length before any body byte is
    // forwarded. Concurrent downloads therefore observe the pre-charge. When
    // length is unknown, the stream reserves each chunk before enqueueing it.
    if (contentLength !== null) {
      let sizedReserve: ReserveDecision;
      try {
        sizedReserve = await gateReserve(
          gateStub,
          requestId,
          contentLength,
          limitBytes,
          maxConcurrent,
          bucket,
        );
      } catch (error) {
        stopUpstreamHeartbeat();
        await cancelUpstreamBody(
          upstreamResponse,
          "HF proxy gate sizing failed",
        );
        await gateCancel(gateStub, requestId, bucket);
        throw error;
      }
      if (!sizedReserve.admitted) {
        stopUpstreamHeartbeat();
        await cancelUpstreamBody(
          upstreamResponse,
          "HF proxy egress limit reached",
        );
        await gateCancel(gateStub, requestId, bucket);
        return c.json(
          egressLimitResponse(
            orgId,
            sizedReserve.limitBytes,
            sizedReserve.usedBytes,
          ),
          429,
        );
      }
    }

    const responseHeaders = new Headers();
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const upstreamCacheStatus = cacheStatus(upstreamResponse.headers);

    let body: ReadableStream<Uint8Array> | null = null;
    if (upstreamResponse.body) {
      body = streamWithEgressAccounting({
        body: upstreamResponse.body,
        gateStub,
        requestId,
        monthBucket: bucket,
        organizationId: orgId,
        repo,
        path,
        status: upstreamResponse.status,
        cacheStatusValue: upstreamCacheStatus,
        initialReservedBytes: contentLength ?? 0,
        limitBytes,
        maxConcurrent,
      });
      stopUpstreamHeartbeat();
    } else {
      stopUpstreamHeartbeat();
      await gateSettle(gateStub, requestId, 0, bucket);
      logger.info("[hf-proxy] egress metric", {
        organizationId: orgId,
        repo,
        path,
        bytes: 0,
        status: upstreamResponse.status,
        cacheStatus: upstreamCacheStatus,
        cacheHit: cacheHit(upstreamCacheStatus),
      });
    }

    // Stream the body straight through — never buffer a multi-GB GGUF.
    return new Response(body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates route failures.
    return failureResponse(c, error);
  }
});

export default app;
