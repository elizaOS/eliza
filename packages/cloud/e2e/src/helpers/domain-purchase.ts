/**
 * Shared mechanics for the domain-purchase e2e chain (#10691).
 *
 * One set of helpers drives BOTH lanes:
 *   - `tests/domain-purchase.real.spec.ts` — the money-gated live lane
 *     (real Cloudflare registrar, real credit debit) against staging/prod.
 *   - `tests/domain-purchase-harness.spec.ts` — the mock-stack lane
 *     (ELIZA_CF_REGISTRAR_DEV_STUB=1) that proves the harness logic —
 *     ceiling, ledger, negative paths — without spending money.
 *
 * Design rules:
 *   - The price ceiling is enforced BEFORE any buy call. A quote above the
 *     ceiling throws `PriceCeilingExceededError`; no request that can debit
 *     credits is ever issued past a failed ceiling check.
 *   - Every attempted and completed purchase is appended to a JSONL ledger
 *     (append-only; one JSON object per line) so real-money spend is always
 *     inspectable after the fact — see `docs/domain-purchase-live.md`.
 *   - Helpers throw plain Errors with full context; specs own the asserts.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { authedClient } from "./monetization";

export type AuthedFetch = ReturnType<typeof authedClient>;

// ── response envelopes (shapes read from the cloud-api route sources) ──────

/** POST /api/v1/apps/:id/domains/check (see cloud-api .../domains/check/route.ts). */
export interface CheckDomainResponse {
  success?: boolean;
  domain?: string;
  available?: boolean;
  currency?: string;
  years?: number;
  price?: {
    wholesaleUsdCents?: number;
    marginUsdCents?: number;
    totalUsdCents?: number;
    marginBps?: number;
  };
  renewal?: { totalUsdCents?: number };
  error?: string;
}

/** POST /api/v1/apps/:id/domains/buy (see cloud-api .../domains/buy/route.ts). */
export interface BuyDomainResponse {
  success?: boolean;
  domain?: string;
  appDomainId?: string;
  zoneId?: string | null;
  status?: string;
  verified?: boolean;
  expiresAt?: string | null;
  pendingZoneProvisioning?: boolean;
  alreadyRegistered?: boolean;
  debited?: { totalUsdCents?: number; currency?: string };
  error?: string;
  code?: string;
}

/** POST /api/v1/apps/:id/domains/status (see cloud-api .../domains/status/route.ts). */
export interface DomainStatusResponse {
  success?: boolean;
  domain?: string;
  registrar?: string;
  status?: string;
  verified?: boolean;
  sslStatus?: string | null;
  expiresAt?: string | null;
  live?: {
    status: string;
    completedAt: string | null;
    failureReason: string | null;
  } | null;
  error?: string;
}

/** apps.create / apps.get envelope (see cloud-api v1/apps/route.ts). */
export interface AppEnvelope {
  success?: boolean;
  app?: {
    id: string;
    app_url: string;
    deployment_status: string;
    production_url: string | null;
  };
  error?: string;
}

/** apps deploy / deploy-status envelope (see .../apps/[id]/deploy/route.ts). */
export interface DeployEnvelope {
  success?: boolean;
  deploymentId?: string | null;
  status?: "BUILDING" | "READY" | "ERROR" | "DRAFT";
  vercelUrl?: string | null;
  error?: string | null;
}

// ── purchase ledger ─────────────────────────────────────────────────────────

/**
 * One JSONL line per lifecycle event of a purchase attempt. Cloudflare
 * registrations are non-refundable, so the ledger is the durable record of
 * every domain a run tried to buy or bought and what it cost.
 *
 * `cloudflareRegistrationId` is recorded for completeness but is always null
 * today: no cloud-api response (buy, status, per-app or org domain listing)
 * exposes the registrar's registration id — only `zoneId` / `appDomainId`.
 * That is a genuine API gap, documented in docs/domain-purchase-live.md.
 */
export interface DomainLedgerEntry {
  runId: string;
  timestamp: string;
  mode: "live" | "mock-stub";
  phase: "attempt" | "purchased" | "buy-failed" | "detached" | "detach-failed";
  baseUrl: string;
  domain: string;
  appId?: string;
  quotedTotalUsdCents?: number;
  priceCeilingCents?: number;
  debitedTotalUsdCents?: number;
  zoneId?: string | null;
  appDomainId?: string | null;
  cloudflareRegistrationId?: string | null;
  expiresAt?: string | null;
  httpStatus?: number;
  detachStatus?: number;
  error?: string;
}

/**
 * Default durable ledger location. Deliberately NOT under the gitignored
 * `.logs/` / `test-results/` dirs: purchase records must survive artifact
 * cleanup and are meant to be committed as spend evidence after a paid run.
 */
export const DEFAULT_LEDGER_PATH = resolve(
  import.meta.dirname,
  "../../domain-purchase-ledger/ledger.jsonl",
);

/** Append one entry to the JSONL ledger, creating the directory if needed. */
export function appendDomainLedger(
  ledgerPath: string,
  entry: DomainLedgerEntry,
): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
}

// ── price ceiling ───────────────────────────────────────────────────────────

/** Hard default ceiling: 500 US cents. A quote above this must never be bought. */
export const DEFAULT_MAX_PRICE_CENTS = 500;

export class PriceCeilingExceededError extends Error {
  constructor(
    readonly domain: string,
    readonly quotedTotalUsdCents: number,
    readonly maxPriceCents: number,
    readonly allQuotes: DomainQuote[],
  ) {
    super(
      `price ceiling exceeded: cheapest available domain ${domain} quotes ` +
        `${quotedTotalUsdCents}¢ > ceiling ${maxPriceCents}¢ — refusing to buy. ` +
        `All quotes: ${allQuotes
          .map(
            (q) =>
              `${q.domain}=${q.available ? `${q.totalUsdCents}¢` : "unavailable"}`,
          )
          .join(", ")}`,
    );
    this.name = "PriceCeilingExceededError";
  }
}

export interface DomainQuote {
  domain: string;
  available: boolean;
  totalUsdCents: number | null;
}

/**
 * Quote `<slug>.<tld>` on every candidate TLD via the real check route (no
 * charge) and return the cheapest available candidate. Throws when nothing is
 * available at all (a fresh base36 slug should always be free — unavailability
 * signals a registrar problem, not a naming collision).
 */
export async function quoteCheapestAvailableDomain(
  authed: AuthedFetch,
  appId: string,
  slug: string,
  tlds: readonly string[],
): Promise<{
  domain: string;
  totalUsdCents: number;
  allQuotes: DomainQuote[];
}> {
  const allQuotes: DomainQuote[] = [];
  for (const tld of tlds) {
    const domain = `${slug}.${tld}`;
    const check = await authed<CheckDomainResponse>(
      "POST",
      `/api/v1/apps/${appId}/domains/check`,
      { domain },
    );
    if (check.status !== 200 || check.json.success !== true) {
      throw new Error(
        `domains/check failed for ${domain}: HTTP ${check.status} ${JSON.stringify(check.json)}`,
      );
    }
    allQuotes.push({
      domain,
      available: check.json.available === true,
      totalUsdCents:
        typeof check.json.price?.totalUsdCents === "number"
          ? check.json.price.totalUsdCents
          : null,
    });
  }
  const available = allQuotes.filter(
    (q): q is DomainQuote & { totalUsdCents: number } =>
      q.available && typeof q.totalUsdCents === "number",
  );
  if (available.length === 0) {
    throw new Error(
      `no candidate domain is available (or priced) for slug "${slug}": ` +
        JSON.stringify(allQuotes),
    );
  }
  available.sort((a, b) => a.totalUsdCents - b.totalUsdCents);
  const cheapest = available[0];
  return {
    domain: cheapest.domain,
    totalUsdCents: cheapest.totalUsdCents,
    allQuotes,
  };
}

/**
 * The money gate: throws BEFORE any buy when the cheapest quote is above the
 * ceiling. Callers must invoke this between quote and buy — never buy raw.
 */
export function assertPriceCeiling(
  candidate: {
    domain: string;
    totalUsdCents: number;
    allQuotes: DomainQuote[];
  },
  maxPriceCents: number,
): void {
  if (candidate.totalUsdCents > maxPriceCents) {
    throw new PriceCeilingExceededError(
      candidate.domain,
      candidate.totalUsdCents,
      maxPriceCents,
      candidate.allQuotes,
    );
  }
}

// ── chain steps ─────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Base36 timestamp — unique per run, embeds ordering, safe in a hostname. */
export function newRunId(): string {
  return Date.now().toString(36);
}

export async function getBalanceUsd(authed: AuthedFetch): Promise<number> {
  const res = await authed<{ balance?: number }>(
    "GET",
    "/api/v1/credits/balance",
  );
  if (res.status !== 200 || typeof res.json.balance !== "number") {
    throw new Error(
      `credits/balance failed: HTTP ${res.status} ${JSON.stringify(res.json)}`,
    );
  }
  return res.json.balance;
}

export async function createApp(
  authed: AuthedFetch,
  name: string,
  appUrl = "https://placeholder.invalid",
): Promise<string> {
  const created = await authed<AppEnvelope>("POST", "/api/v1/apps", {
    name,
    app_url: appUrl,
    skipGitHubRepo: true,
  });
  const appId = created.json.app?.id;
  if (![200, 201].includes(created.status) || !appId) {
    throw new Error(
      `apps.create failed: HTTP ${created.status} ${JSON.stringify(created.json)}`,
    );
  }
  return appId;
}

export interface DeployOptions {
  /** Live lane: repo/ref/dockerfile build hints. Mock lane: omit (APP_DEFAULT_IMAGE). */
  body?: Record<string, unknown>;
  /** Mock lane only: pump the DB-backed APP_DEPLOY worker between polls. */
  tick?: () => Promise<void>;
  pollIntervalMs: number;
  capMs: number;
}

/** POST /deploy then poll /deploy/status to READY; returns the production URL. */
export async function deployAppToReady(
  authed: AuthedFetch,
  appId: string,
  opts: DeployOptions,
): Promise<string> {
  const started = await authed<DeployEnvelope>(
    "POST",
    `/api/v1/apps/${appId}/deploy`,
    opts.body,
  );
  if (started.status !== 202 || started.json.status !== "BUILDING") {
    throw new Error(
      `apps.deploy failed to start: HTTP ${started.status} ${JSON.stringify(started.json)}`,
    );
  }

  const deadline = Date.now() + opts.capMs;
  let latest: DeployEnvelope | undefined;
  while (Date.now() < deadline) {
    if (opts.tick) await opts.tick();
    const status = await authed<DeployEnvelope>(
      "GET",
      `/api/v1/apps/${appId}/deploy/status`,
    );
    if (status.status !== 200) {
      throw new Error(`deploy/status failed: HTTP ${status.status}`);
    }
    latest = status.json;
    if (latest.status === "READY") break;
    if (latest.status === "ERROR") {
      throw new Error(`deploy failed: ${latest.error ?? "unknown error"}`);
    }
    await sleep(opts.pollIntervalMs);
  }
  if (latest?.status !== "READY" || !latest.vercelUrl) {
    throw new Error(
      `deploy did not reach READY with a production_url within ${opts.capMs}ms ` +
        `(last: ${JSON.stringify(latest)})`,
    );
  }
  return latest.vercelUrl;
}

export async function buyDomain(
  authed: AuthedFetch,
  appId: string,
  domain: string,
): Promise<{ status: number; json: BuyDomainResponse }> {
  return authed<BuyDomainResponse>(
    "POST",
    `/api/v1/apps/${appId}/domains/buy`,
    {
      domain,
    },
  );
}

/** Poll domains/status until status=active && verified, or the cap elapses. */
export async function pollDomainActive(
  authed: AuthedFetch,
  appId: string,
  domain: string,
  opts: { pollIntervalMs: number; capMs: number },
): Promise<DomainStatusResponse> {
  const deadline = Date.now() + opts.capMs;
  let latest: DomainStatusResponse = {};
  while (Date.now() < deadline) {
    const res = await authed<DomainStatusResponse>(
      "POST",
      `/api/v1/apps/${appId}/domains/status`,
      { domain },
    );
    if (res.status !== 200) {
      throw new Error(
        `domains/status failed: HTTP ${res.status} ${JSON.stringify(res.json)}`,
      );
    }
    latest = res.json;
    if (latest.status === "active" && latest.verified === true) return latest;
    await sleep(opts.pollIntervalMs);
  }
  throw new Error(
    `domain ${domain} did not reach active+verified within ${opts.capMs}ms ` +
      `(last: ${JSON.stringify(latest)})`,
  );
}

export interface ServeProbeResult {
  ok: boolean;
  url: string;
  httpStatus: number | null;
  attempts: number;
  lastError?: string;
}

/**
 * Poll candidate URLs until one answers with any HTTP status < 500. Fresh
 * registrations propagate DNS + issue TLS on-demand, so both https:// and
 * http:// candidates are probed each round until the cap.
 */
export async function probeUrlServes(
  urls: readonly string[],
  opts: { pollIntervalMs: number; capMs: number },
): Promise<ServeProbeResult> {
  const deadline = Date.now() + opts.capMs;
  let attempts = 0;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    for (const url of urls) {
      attempts += 1;
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status < 500) {
          return { ok: true, url, httpStatus: res.status, attempts };
        }
        lastError = `HTTP ${res.status} from ${url}`;
      } catch (err) {
        lastError = `${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    await sleep(opts.pollIntervalMs);
  }
  return { ok: false, url: urls[0], httpStatus: null, attempts, lastError };
}

/** DELETE /apps/:id/domains {domain} — detach (registration itself persists). */
export async function detachDomain(
  authed: AuthedFetch,
  appId: string,
  domain: string,
): Promise<number> {
  const res = await authed("DELETE", `/api/v1/apps/${appId}/domains`, {
    domain,
  });
  return res.status;
}

export async function deleteApp(
  authed: AuthedFetch,
  appId: string,
): Promise<number> {
  const res = await authed("DELETE", `/api/v1/apps/${appId}`);
  return res.status;
}
