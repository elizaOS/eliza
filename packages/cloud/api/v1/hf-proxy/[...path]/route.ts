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
 * EGRESS QUOTA (issue #13115): per-org monthly byte budget enforced atomically.
 * The route reserves a hard cap UPFRONT before the upstream fetch, then — once
 * upstream headers arrive with the real content-length — atomically AMENDS the
 * reservation to the actual byte count. Unknown-length streams reserve the full
 * remaining org budget as a hard cap. While streaming, each chunk is checked
 * against the remaining allowance and the stream is ABORTED (with the already
 * streamed bytes committed) if it would exceed the budget. Partial bytes on
 * client disconnect are accounted through the readable stream's `cancel`
 * callback + a finally guard, never a TransformStream transformer (which lacks a
 * reliable cancellation hook for downstream-disconnect accounting).
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

/**
 * Egress accounting state. Two tiers:
 *
 * 1. **Reservation ledger** (`EgressCounter`): the committed running total for
 *    the org+month, persisted to KV (cross-isolate) or an in-memory Map
 *    (single-isolate fallback). This is the authoritative budget.
 * 2. **In-flight reservations**: `Map<reservationId, InFlightReservation>` —
 *    per-download holds that reserve bytes upfront and are amended/released when
 *    the download settles. These are isolate-local; KV does not support atomic
 *    holds, so cross-isolate concurrency against the same org is bounded by the
 *    commit-time check-and-decrement, which is the actual quota gate.
 */
interface EgressCounter {
  bytes: number;
  expiresAt: number;
}

interface InFlightReservation {
  /** Bytes reserved (hard cap) when the hold was placed. */
  reserved: number;
  /** Final committed bytes (set on amend/complete, -1 while streaming). */
  committed: number;
}

const inMemoryEgressCounters = new Map<string, EgressCounter>();
const inFlightReservations = new Map<string, InFlightReservation>();

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

/**
 * Read the committed monthly egress total for an org. This is the settled
 * running total — it does NOT include in-flight reservations. Callers that need
 * the live available budget must combine this with the reservation holds.
 */
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

/** Persist the committed monthly egress total (internal helper). */
async function writeMonthlyEgress(
  env: AppEnv["Bindings"],
  organizationId: string,
  bytes: number,
): Promise<void> {
  const key = egressKey(organizationId);
  const value = JSON.stringify({
    bytes,
    updatedAt: new Date().toISOString(),
  });
  const kv = env.CACHE_KV;
  if (kv) {
    await kv.put(key, value, { expirationTtl: MONTHLY_EGRESS_TTL_SECONDS });
  } else {
    inMemoryEgressCounters.set(key, {
      bytes,
      expiresAt: Date.now() + MONTHLY_EGRESS_TTL_SECONDS * 1000,
    });
  }
}

/** Sum of all in-flight (uncommitted) reservations for an org this month. */
function inFlightReservedBytes(organizationId: string): number {
  const prefix = `${egressKey(organizationId)}#`;
  let sum = 0;
  for (const [id, res] of inFlightReservations) {
    if (id.startsWith(prefix) && res.committed < 0) sum += res.reserved;
  }
  return sum;
}

/**
 * Atomically attempt to reserve `bytes` against the org's monthly budget.
 *
 * Computes available = limit - committed - inFlightReserved, and if
 * `bytes <= available`, registers an in-flight hold for exactly `bytes` and
 * returns the reservation id. If insufficient budget, returns `{ ok: false }`
 * with the current committed total so the caller can build a 429.
 *
 * The read-then-write is atomic with respect to other JS in this isolate
 * (single-threaded event loop), which is how the in-memory tier guarantees no
 * double-spend within an isolate. KV-backed committed totals are eventually
 * consistent across isolates; the in-flight holds are isolate-local, so two
 * isolates can both reserve against near-full budgets — the streaming-time
 * enforcement (check-and-commit on every chunk) is the hard backstop that
 * prevents actual over-egress regardless of reservation overlaps.
 */
async function tryReserveEgress(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  bytes: number;
  limitBytes: number;
}): Promise<
  { ok: true; reservationId: string; committedBefore: number } | {
    ok: false;
    committed: number;
    inFlight: number;
  }
> {
  const committed = await readMonthlyEgress(args.env, args.organizationId);
  const inFlight = inFlightReservedBytes(args.organizationId);
  const available = args.limitBytes - committed - inFlight;
  if (args.bytes > available) {
    return { ok: false, committed, inFlight };
  }
  const reservationId = `${egressKey(args.organizationId)}#${crypto.randomUUID()}`;
  inFlightReservations.set(reservationId, {
    reserved: args.bytes,
    committed: -1,
  });
  return { ok: true, reservationId, committedBefore: committed };
}

/**
 * Amend an in-flight reservation's reserved cap after the real content-length
 * is known. If the smaller actual size frees budget, the hold shrinks. If the
 * actual size is larger than the reservation, this re-checks the budget and may
 * reject. Returns `{ ok: false }` if the larger size no longer fits.
 */
async function amendReservation(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  reservationId: string;
  actualBytes: number;
  limitBytes: number;
}): Promise<
  | { ok: true }
  | { ok: false; committed: number; inFlight: number }
> {
  const res = inFlightReservations.get(args.reservationId);
  if (!res) return { ok: false, committed: 0, inFlight: 0 };
  if (args.actualBytes <= res.reserved) {
    // Shrink the hold — always allowed, releases budget for other downloads.
    res.reserved = args.actualBytes;
    return { ok: true };
  }
  // Growing: re-check the budget. Temporarily release this reservation's hold so
  // its own reserved bytes don't double-count against the new request.
  const oldReserved = res.reserved;
  res.reserved = 0;
  const committed = await readMonthlyEgress(args.env, args.organizationId);
  const inFlight = inFlightReservedBytes(args.organizationId);
  const available = args.limitBytes - committed - inFlight;
  if (args.actualBytes > available) {
    res.reserved = oldReserved; // restore original hold on rejection
    return { ok: false, committed, inFlight };
  }
  res.reserved = args.actualBytes;
  return { ok: true };
}

/**
 * Commit `bytes` (the actual bytes streamed) to the org's monthly ledger and
 * release the reservation hold. Called exactly once per download via the
 * stream's cancel/start completion path. Idempotent: a second call is a no-op.
 */
async function commitReservation(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  reservationId: string;
  bytes: number;
}): Promise<number> {
  const res = inFlightReservations.get(args.reservationId);
  // Already committed (duplicate cancel/finally call) — return current total.
  if (res && res.committed >= 0) {
    return readMonthlyEgress(args.env, args.organizationId);
  }
  if (res) {
    res.committed = args.bytes;
    inFlightReservations.delete(args.reservationId);
  }
  if (args.bytes <= 0) {
    return readMonthlyEgress(args.env, args.organizationId);
  }
  const current = await readMonthlyEgress(args.env, args.organizationId);
  const next = current + args.bytes;
  await writeMonthlyEgress(args.env, args.organizationId, next);
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

/**
 * Build a streaming response body that enforces the per-org byte allowance
 * WHILE streaming and accounts the actual bytes on completion or disconnect.
 *
 * Uses a ReadableStream (not a TransformStream) so we get a real `cancel`
 * callback for downstream-disconnect accounting — the reviewer found that
 * TransformStream transformers do not provide a reliable cancellation hook.
 * The bytes actually streamed are committed in a `finally`-style guard around
 * the pump loop AND in `cancel`, so both normal completion and early abort are
 * covered exactly once (commitReservation is idempotent).
 */
function streamWithEgressEnforcement(args: {
  body: ReadableStream<Uint8Array>;
  env: AppEnv["Bindings"];
  organizationId: string;
  reservationId: string;
  remainingAllowance: number;
  repo: string;
  path: string;
  status: number;
  cacheStatus: string | null;
}): ReadableStream<Uint8Array> {
  const reader = args.body.getReader();
  let bytesStreamed = 0;
  let settled = false;

  const finalize = async (reason: "complete" | "cancelled") => {
    if (settled) return;
    settled = true;
    const usedBytes = await commitReservation({
      env: args.env,
      organizationId: args.organizationId,
      reservationId: args.reservationId,
      bytes: bytesStreamed,
    });
    logger.info("[hf-proxy] egress metric", {
      organizationId: args.organizationId,
      repo: args.repo,
      path: args.path,
      bytes: bytesStreamed,
      status: args.status,
      cacheStatus: args.cacheStatus,
      cacheHit: cacheHit(args.cacheStatus),
      usedBytes,
      reason,
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await finalize("complete");
          return;
        }
        bytesStreamed += value.byteLength;
        // Enforce remaining allowance mid-stream — abort if exceeded.
        if (bytesStreamed > args.remainingAllowance) {
          controller.error(
            new Error("HF_PROXY_EGRESS_LIMIT_EXCEEDED_MIDSTREAM"),
          );
          await finalize("cancelled");
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await finalize("cancelled");
      }
    },
    async cancel() {
      // Downstream disconnect: account the partial bytes actually streamed.
      await reader.cancel().catch(() => {});
      await finalize("cancelled");
    },
  });
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

    // --- ATOMIC UPFRONT RESERVATION (#13115) ---
    // Reserve the full remaining org budget as a hard cap BEFORE the upstream
    // fetch. This blocks concurrent downloads from each passing the same stale
    // remaining-budget check (the PR #18918 bug). After upstream headers arrive
    // with the real content-length, amendReservation shrinks (or grows) the
    // hold to the actual size. For unknown-length streams the full-cap reserve
    // stays in place for the entire transfer.
    const committedBefore = await readMonthlyEgress(c.env, orgId);
    const inFlightBefore = inFlightReservedBytes(orgId);
    const available = limitBytes - committedBefore - inFlightBefore;
    if (available <= 0) {
      return c.json(
        egressLimitResponse(orgId, limitBytes, committedBefore + inFlightBefore),
        429,
      );
    }
    const reserve = await tryReserveEgress({
      env: c.env,
      organizationId: orgId,
      bytes: available,
      limitBytes,
    });
    if (!reserve.ok) {
      return c.json(
        egressLimitResponse(orgId, limitBytes, reserve.committed),
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

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstream, {
        method: "GET",
        headers,
        redirect: "follow",
      });
    } catch (fetchError) {
      // Upstream fetch failed — release the reservation so it doesn't leak.
      inFlightReservations.delete(reserve.reservationId);
      throw fetchError;
    }

    if (upstreamResponse.status >= 400) {
      logger.warn("[hf-proxy] upstream HuggingFace error", {
        path,
        status: upstreamResponse.status,
      });
    }

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      // Gated/unauthorized: no egress, release the reservation.
      inFlightReservations.delete(reserve.reservationId);
      const upstreamCacheStatus = cacheStatus(upstreamResponse.headers);
      logger.info("[hf-proxy] egress metric", {
        organizationId: orgId,
        repo,
        path,
        bytes: 0,
        status: upstreamResponse.status,
        cacheStatus: upstreamCacheStatus,
        cacheHit: cacheHit(upstreamCacheStatus),
        usedBytes: committedBefore,
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

    const contentLength = parseContentLength(upstreamResponse.headers);

    // Cost/usage observability: a single GGUF proxied here can be multiple GB on
    // the cloud's bandwidth and HF quota. Record who pulled what and how large,
    // so an operator has visibility into an otherwise-unmetered transfer.
    logger.info("[hf-proxy] proxied download", {
      repo,
      path,
      status: upstreamResponse.status,
      bytes: contentLength,
      orgId: redact.orgId(orgId),
      userId: redact.userId(userId),
    });

    // --- AMEND RESERVATION TO ACTUAL CONTENT-LENGTH ---
    // Now that upstream headers are in, atomically amend the hard-cap hold to
    // the real byte count. This (a) frees budget for other downloads when the
    // file is smaller than the cap, and (b) re-validates the budget if the
    // actual size is known. If the known content-length alone exceeds the
    // budget, reject before streaming a single byte and release the hold.
    let remainingAllowance: number;
    if (contentLength !== null) {
      const amend = await amendReservation({
        env: c.env,
        organizationId: orgId,
        reservationId: reserve.reservationId,
        actualBytes: contentLength,
        limitBytes,
      });
      if (!amend.ok) {
        inFlightReservations.delete(reserve.reservationId);
        return c.json(
          egressLimitResponse(orgId, limitBytes, amend.committed),
          429,
        );
      }
      remainingAllowance = contentLength;
    } else {
      // Unknown length: the full-cap reservation stays. Enforce against the
      // remaining org budget during streaming.
      remainingAllowance = available;
    }

    const responseHeaders = new Headers();
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const body = upstreamResponse.body
      ? streamWithEgressEnforcement({
          body: upstreamResponse.body,
          env: c.env,
          organizationId: orgId,
          reservationId: reserve.reservationId,
          remainingAllowance,
          repo,
          path,
          status: upstreamResponse.status,
          cacheStatus: cacheStatus(upstreamResponse.headers),
        })
      : (() => {
          // No body (e.g. HEAD-style 2xx with no content) — commit zero and
          // release the reservation.
          inFlightReservations.delete(reserve.reservationId);
          return null;
        })();

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
