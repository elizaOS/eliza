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
 * EGRESS QUOTA (issue #13115): per-org monthly byte budget enforced via a
 * Durable Object (`HfProxyEgressGate`) that serializes all reservation,
 * amendment, and commit operations for an org. The route reserves a hard cap
 * UPFRONT before the upstream fetch, then — once upstream headers arrive with
 * the real content-length — atomically AMENDS the reservation to the actual
 * byte count. Unknown-length streams reserve the full remaining org budget as
 * a hard cap. While streaming, each chunk is checked against the remaining
 * allowance and the stream is ABORTED (with the already-streamed bytes
 * committed) if it would exceed the budget. Partial bytes on client disconnect
 * are accounted through the readable stream's `cancel` callback + a finally
 * guard, never a TransformStream transformer (which lacks a reliable
 * cancellation hook for downstream-disconnect accounting).
 *
 * FALLBACK: when the `HF_PROXY_EGRESS_GATES` Durable Object binding is absent
 * (local development, test), the route falls back to an in-memory + KV path.
 * That path is safe within a single isolate (single-threaded JS event loop)
 * but does NOT guarantee cross-isolate atomicity — KV is eventually
 * consistent and the read-modify-write commit is racy across isolates.
 * Production deployments MUST bind the Durable Object for true atomicity.
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
 * Egress accounting state — two tiers:
 *
 * 1. **Durable Object** (`HfProxyEgressGate`): one actor per org, owning the
 *    committed running total and in-flight reservations. All operations are
 *    serialized inside the actor's single-threaded execution, so two
 *    isolates cannot both reserve against the same remaining budget or lose
 *    an increment. This is the authoritative production path.
 *
 * 2. **In-memory fallback**: when the DO binding is absent (local dev, tests),
 *    a process-local `Map` + KV read-modify-write is used. This is safe within
 *    a single isolate but NOT cross-isolate (KV is eventually consistent and
 *    the commit is a non-atomic read-modify-write).
 */

/** KV-backed committed total (fallback path only). */
interface EgressCounter {
  bytes: number;
  expiresAt: number;
}

/** Isolate-local in-flight reservation (fallback path only). */
interface InFlightReservation {
  /** Bytes reserved (hard cap) when the hold was placed. */
  reserved: number;
  /** Final committed bytes (set on amend/complete, -1 while streaming). */
  committed: number;
}

const inMemoryEgressCounters = new Map<string, EgressCounter>();
const inFlightReservations = new Map<string, InFlightReservation>();

/** Origin used for Durable Object fetch calls (not a real HTTP origin). */
const EGRESS_GATE_ORIGIN = "https://hf-proxy-egress-gate.internal";

/**
 * Resolve the egress gate DO stub for an org, or `null` if the binding is not
 * present (fallback path). All route-level egress operations go through this.
 */
function egressGate(
  env: AppEnv["Bindings"],
  organizationId: string,
): RuntimeDurableObjectStub | null {
  const namespace = env.HF_PROXY_EGRESS_GATES;
  if (!namespace) return null;
  return namespace.getByName(organizationId);
}

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
 * Reserve `bytes` against the org's monthly budget.
 *
 * When the Durable Object binding is present, this delegates to the DO, which
 * serializes the reservation atomically across all isolates. Otherwise it
 * falls back to the isolate-local in-memory path (safe within one isolate
 * only).
 */
async function tryReserveEgress(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  bytes: number;
  limitBytes: number;
}): Promise<
  | { ok: true; reservationId: string; committedBefore: number }
  | {
      ok: false;
      committed: number;
      inFlight: number;
    }
> {
  const gate = egressGate(args.env, args.organizationId);
  if (gate) {
    const resp = await gate.fetch(
      new Request(`${EGRESS_GATE_ORIGIN}/reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bytes: args.bytes,
          limitBytes: args.limitBytes,
        }),
      }),
    );
    const body = (await resp.json()) as {
      admitted: boolean;
      reservationId: string | null;
      committed: number;
      inFlight: number;
    };
    if (!body.admitted) {
      return { ok: false, committed: body.committed, inFlight: body.inFlight };
    }
    return {
      ok: true,
      reservationId: body.reservationId!,
      committedBefore: body.committed,
    };
  }

  // --- Fallback (in-memory, single-isolate) ---
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
 * is known. When the DO is present this is serialized in the actor. In the
 * fallback path, shrinking is always allowed and growing re-checks the budget.
 */
async function amendReservation(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  reservationId: string;
  actualBytes: number;
  limitBytes: number;
}): Promise<{ ok: true } | { ok: false; committed: number; inFlight: number }> {
  const gate = egressGate(args.env, args.organizationId);
  if (gate) {
    const resp = await gate.fetch(
      new Request(`${EGRESS_GATE_ORIGIN}/amend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationId: args.reservationId,
          actualBytes: args.actualBytes,
          limitBytes: args.limitBytes,
        }),
      }),
    );
    const body = (await resp.json()) as {
      ok: boolean;
      committed: number;
      inFlight: number;
    };
    return body.ok
      ? { ok: true }
      : { ok: false, committed: body.committed, inFlight: body.inFlight };
  }

  // --- Fallback (in-memory, single-isolate) ---
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
 *
 * When the DO is present, the increment happens inside the actor's
 * single-threaded storage, which is impossible to race. In the fallback path
 * it is a read-modify-write on KV/in-memory (racy across isolates).
 */
async function commitReservation(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  reservationId: string;
  bytes: number;
}): Promise<number> {
  const gate = egressGate(args.env, args.organizationId);
  if (gate) {
    const resp = await gate.fetch(
      new Request(`${EGRESS_GATE_ORIGIN}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationId: args.reservationId,
          bytes: args.bytes,
        }),
      }),
    );
    const body = (await resp.json()) as { committed: number };
    return body.committed;
  }

  // --- Fallback (in-memory, single-isolate) ---
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

/**
 * Release a reservation without committing bytes (e.g. upstream 401/403, or
 * upstream fetch error). In the DO path this removes the hold atomically.
 */
async function releaseReservation(args: {
  env: AppEnv["Bindings"];
  organizationId: string;
  reservationId: string;
}): Promise<void> {
  const gate = egressGate(args.env, args.organizationId);
  if (gate) {
    await gate.fetch(
      new Request(`${EGRESS_GATE_ORIGIN}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: args.reservationId }),
      }),
    );
    return;
  }

  // --- Fallback (in-memory, single-isolate) ---
  inFlightReservations.delete(args.reservationId);
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
        egressLimitResponse(
          orgId,
          limitBytes,
          committedBefore + inFlightBefore,
        ),
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
      await releaseReservation({
        env: c.env,
        organizationId: orgId,
        reservationId: reserve.reservationId,
      });
      throw fetchError;
    }

    if (upstreamResponse.status >= 400) {
      logger.warn("[hf-proxy] upstream HuggingFace error", {
        path,
        status: upstreamResponse.status,
      });
    }

    if (upstreamResponse.status >= 400 && upstreamResponse.status < 500) {
      // Client errors (4xx): no egress from a proxied body. Release the
      // reservation so a 404/429/etc. does not needlessly hold the budget.
      await releaseReservation({
        env: c.env,
        organizationId: orgId,
        reservationId: reserve.reservationId,
      });
    }

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      // Gated/unauthorized: the reservation was already released above; record
      // the metric and return the structured error.
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
        await releaseReservation({
          env: c.env,
          organizationId: orgId,
          reservationId: reserve.reservationId,
        });
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

    // No body (e.g. HEAD-style 2xx with no content) — release the
    // reservation and return an empty response.
    if (!upstreamResponse.body) {
      await releaseReservation({
        env: c.env,
        organizationId: orgId,
        reservationId: reserve.reservationId,
      });
      return new Response(null, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    const body = streamWithEgressEnforcement({
      body: upstreamResponse.body,
      env: c.env,
      organizationId: orgId,
      reservationId: reserve.reservationId,
      remainingAllowance,
      repo,
      path,
      status: upstreamResponse.status,
      cacheStatus: cacheStatus(upstreamResponse.headers),
    });

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
