import type http from "node:http";
import {
  ensureRouteAuthorized,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "./auth.ts";
import {
  type CompatRuntimeState,
  isTrustedLocalRequest,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  createInMemoryLocalPaymentStore,
  type LocalPaymentContext,
  type LocalPaymentProvider,
  type LocalPaymentRequest,
  type LocalPaymentStatus,
  type LocalPaymentStore,
  localPaymentStore,
  newPaymentRequestId,
} from "./payment-store";
import { sendJson, sendJsonError } from "./response";

const ROUTE_PREFIX = "/api/payment-requests";
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_PROVIDERS: ReadonlySet<LocalPaymentProvider> = new Set([
  "wallet_native",
  "x402",
]);

export type PaymentSettledHandler = (
  request: LocalPaymentRequest,
  proof: Record<string, unknown>,
) => void | Promise<void>;

export type PaymentProofVerifier = (
  request: LocalPaymentRequest,
  proof: Record<string, unknown>,
) => Promise<{ ok: true; txRef?: string } | { ok: false; reason: string }>;

export interface PaymentRouteOptions {
  store?: LocalPaymentStore;
  now?: () => number;
  verifyProof?: PaymentProofVerifier;
  onSettled?: PaymentSettledHandler;
  publicBaseUrl?: () => string | null | undefined;
}

interface CreateBody {
  provider?: unknown;
  amountCents?: unknown;
  currency?: unknown;
  reason?: unknown;
  paymentContext?: unknown;
  expiresInMs?: unknown;
  metadata?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampTtlMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_TTL_MS);
}

function parseProvider(value: unknown): LocalPaymentProvider | string {
  const provider = optionalString(value);
  if (!provider) return "missing provider";
  if (!SUPPORTED_PROVIDERS.has(provider as LocalPaymentProvider)) {
    return "provider_not_supported_in_local_mode";
  }
  return provider as LocalPaymentProvider;
}

function parsePaymentContext(value: unknown): LocalPaymentContext | string {
  const ctx = asRecord(value);
  if (!ctx) return "missing paymentContext";
  const kind = optionalString(ctx.kind);
  if (kind === "any_payer") return { kind };
  if (kind === "verified_payer") {
    const scope = optionalString(ctx.scope);
    return scope ? { kind, scope } : { kind };
  }
  if (kind === "specific_payer") {
    const payerIdentityId = optionalString(ctx.payerIdentityId);
    if (!payerIdentityId) return "missing paymentContext.payerIdentityId";
    return { kind, payerIdentityId };
  }
  return "invalid paymentContext.kind";
}

function firstPathMatch(pathname: string): {
  id: string;
  action: "get" | "proof" | "cancel" | "expire" | "page";
} | null {
  const proof = /^\/api\/payment-requests\/([^/]+)\/proof$/.exec(pathname);
  if (proof?.[1]) return { id: decodeURIComponent(proof[1]), action: "proof" };
  const cancel = /^\/api\/payment-requests\/([^/]+)\/cancel$/.exec(pathname);
  if (cancel?.[1]) {
    return { id: decodeURIComponent(cancel[1]), action: "cancel" };
  }
  const expire = /^\/api\/payment-requests\/([^/]+)\/expire$/.exec(pathname);
  if (expire?.[1]) {
    return { id: decodeURIComponent(expire[1]), action: "expire" };
  }
  const page = /^\/api\/payment-requests\/([^/]+)\/page$/.exec(pathname);
  if (page?.[1]) return { id: decodeURIComponent(page[1]), action: "page" };
  const get = /^\/api\/payment-requests\/([^/]+)$/.exec(pathname);
  if (get?.[1]) return { id: decodeURIComponent(get[1]), action: "get" };
  return null;
}

function isOwner(
  req: http.IncomingMessage,
  state: CompatRuntimeState,
): boolean {
  if (isTrustedLocalRequest(req)) return true;
  const expected = getCompatApiToken();
  const provided = getProvidedApiToken(req);
  if (expected && provided && tokenMatches(expected, provided)) return true;
  void state;
  return false;
}

async function ensureOwnerAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  if (isOwner(req, state)) return true;
  return await ensureRouteAuthorized(req, res, state);
}

function redactRequest(
  record: LocalPaymentRequest,
  ownerView: boolean,
): Record<string, unknown> {
  const paymentContext: Record<string, unknown> = { ...record.paymentContext };
  const metadata: Record<string, unknown> = { ...record.metadata };
  if (!ownerView) {
    if (
      paymentContext.kind === "specific_payer" &&
      "payerIdentityId" in paymentContext
    ) {
      paymentContext.payerIdentityId = "[REDACTED]";
    }
    if ("callbackSecret" in metadata) {
      metadata.callbackSecret = "[REDACTED]";
    }
  }
  const view: Record<string, unknown> = {
    id: record.id,
    provider: record.provider,
    amountCents: record.amountCents,
    currency: record.currency,
    reason: record.reason,
    paymentContext,
    status: record.status,
    hostedUrl: record.hostedUrl,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    txRef: ownerView ? record.txRef : undefined,
    metadata,
  };
  return view;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAmount(record: LocalPaymentRequest): string {
  const major = record.amountCents / 100;
  return `${major.toFixed(2)} ${record.currency.toUpperCase()}`;
}

function renderHostedPage(
  record: LocalPaymentRequest,
  view: Record<string, unknown>,
): string {
  const id = escapeHtml(record.id);
  const amount = escapeHtml(formatAmount(record));
  const provider = escapeHtml(record.provider);
  const status = escapeHtml(record.status);
  const reason = record.reason ? escapeHtml(record.reason) : "";
  const summaryJson = escapeHtml(JSON.stringify(view, null, 2));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Payment request ${id}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  textarea { width: 100%; min-height: 8rem; font-family: monospace; }
  .row { margin-bottom: 1rem; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eee; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Payment request <span class="pill">${id}</span></h1>
<div class="row"><strong>Amount:</strong> ${amount}</div>
<div class="row"><strong>Provider:</strong> ${provider}</div>
<div class="row"><strong>Status:</strong> ${status}</div>
${reason ? `<div class="row"><strong>Reason:</strong> ${reason}</div>` : ""}
<h2>Submit payment proof</h2>
<form id="proof-form" method="POST" action="/api/payment-requests/${id}/proof" enctype="application/json">
  <div class="row">
    <label for="proof">Proof JSON (e.g. EIP-3009 signed authorization)</label>
    <textarea id="proof" name="proof" placeholder='{"signature":"0x..."}'></textarea>
  </div>
  <button type="submit">Submit proof</button>
</form>
<h2>Request summary (redacted)</h2>
<pre>${summaryJson}</pre>
<script>
(function(){
  var form = document.getElementById('proof-form');
  if (!form) return;
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var raw = document.getElementById('proof').value;
    var body;
    try { body = JSON.parse(raw); } catch (err) { alert('Invalid JSON'); return; }
    fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: body })
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, body: j }; }); })
      .then(function(out){ alert(out.status + ' ' + JSON.stringify(out.body)); window.location.reload(); })
      .catch(function(err){ alert('Submit failed: ' + err); });
  });
})();
</script>
</body>
</html>`;
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function buildHostedUrl(
  options: PaymentRouteOptions,
  id: string,
): string | undefined {
  const base = options.publicBaseUrl?.();
  if (!base) return undefined;
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${ROUTE_PREFIX}/${encodeURIComponent(id)}/page`;
}

async function defaultVerifyProof(): Promise<
  { ok: true; txRef?: string } | { ok: false; reason: string }
> {
  return { ok: false, reason: "no_verifier_configured" };
}

export async function handlePaymentRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  options: PaymentRouteOptions = {},
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    return false;
  }

  const store = options.store ?? localPaymentStore;
  const now = options.now?.() ?? Date.now();

  if (pathname === ROUTE_PREFIX) {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!(await ensureOwnerAuthorized(req, res, state))) return true;

    const body = (await readCompatJsonBody(req, res)) as CreateBody | null;
    if (!body) return true;

    const provider = parseProvider(body.provider);
    if (
      typeof provider === "string" &&
      !SUPPORTED_PROVIDERS.has(provider as LocalPaymentProvider)
    ) {
      sendJsonError(res, 400, provider);
      return true;
    }
    const amountCents =
      typeof body.amountCents === "number" &&
      Number.isFinite(body.amountCents) &&
      body.amountCents > 0 &&
      Number.isInteger(body.amountCents)
        ? body.amountCents
        : null;
    if (amountCents === null) {
      sendJsonError(res, 400, "invalid amountCents");
      return true;
    }
    const paymentContext = parsePaymentContext(body.paymentContext);
    if (typeof paymentContext === "string") {
      sendJsonError(res, 400, paymentContext);
      return true;
    }
    const ttlMs = clampTtlMs(body.expiresInMs);
    const id = newPaymentRequestId();
    const expiresAt = now + ttlMs;
    const hostedUrl = buildHostedUrl(options, id);
    const metadataInput = asRecord(body.metadata) ?? {};
    const record: LocalPaymentRequest = {
      id,
      provider: provider as LocalPaymentProvider,
      amountCents,
      currency: optionalString(body.currency)?.toLowerCase() ?? "usd",
      reason: optionalString(body.reason),
      paymentContext: paymentContext as LocalPaymentContext,
      status: "pending",
      hostedUrl,
      expiresAt,
      createdAt: now,
      metadata: metadataInput,
    };
    const inserted = await store.insert(record);
    sendJson(res, 201, {
      ok: true,
      paymentRequestId: inserted.id,
      hostedUrl: inserted.hostedUrl,
      expiresAt: inserted.expiresAt,
    });
    return true;
  }

  const match = firstPathMatch(pathname);
  if (!match || !SAFE_ID_RE.test(match.id)) {
    sendJsonError(res, 404, "not found");
    return true;
  }

  // Auto-expire stale requests on read paths.
  await store.expirePast(now);

  if (match.action === "get") {
    if (method !== "GET") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    const record = await store.get(match.id);
    if (!record) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    const ownerView = isOwner(req, state);
    sendJson(res, 200, {
      ok: true,
      request: redactRequest(record, ownerView),
    });
    return true;
  }

  if (match.action === "page") {
    if (method !== "GET") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    const record = await store.get(match.id);
    if (!record) {
      sendHtml(
        res,
        404,
        `<!doctype html><html><body><h1>Not found</h1><p>No payment request matches this id.</p></body></html>`,
      );
      return true;
    }
    const ownerView = isOwner(req, state);
    const view = redactRequest(record, ownerView);
    sendHtml(res, 200, renderHostedPage(record, view));
    return true;
  }

  if (match.action === "cancel") {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!(await ensureOwnerAuthorized(req, res, state))) return true;
    const existing = await store.get(match.id);
    if (!existing) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    if (
      existing.status === "settled" ||
      existing.status === "failed" ||
      existing.status === "expired" ||
      existing.status === "canceled"
    ) {
      sendJsonError(res, 409, `cannot cancel from status: ${existing.status}`);
      return true;
    }
    const updated = await store.setStatus(match.id, "canceled");
    sendJson(res, 200, {
      ok: true,
      request: redactRequest(updated as LocalPaymentRequest, true),
    });
    return true;
  }

  if (match.action === "expire") {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!(await ensureOwnerAuthorized(req, res, state))) return true;
    const existing = await store.get(match.id);
    if (!existing) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    if (
      existing.status === "settled" ||
      existing.status === "failed" ||
      existing.status === "expired" ||
      existing.status === "canceled"
    ) {
      sendJsonError(res, 409, `cannot expire from status: ${existing.status}`);
      return true;
    }
    const updated = await store.setStatus(match.id, "expired");
    sendJson(res, 200, {
      ok: true,
      request: redactRequest(updated as LocalPaymentRequest, true),
    });
    return true;
  }

  if (match.action === "proof") {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    const record = await store.get(match.id);
    if (!record) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    if (record.status !== "pending" && record.status !== "delivered") {
      sendJsonError(
        res,
        409,
        `cannot accept proof for status: ${record.status}`,
      );
      return true;
    }
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const proof = asRecord(body.proof);
    if (!proof) {
      sendJsonError(res, 400, "missing proof");
      return true;
    }

    const verify = options.verifyProof ?? defaultVerifyProof;
    const verdict = await verify(record, proof);
    if (verdict.ok === false) {
      const failed = await store.setStatus(match.id, "failed", {
        metadata: { ...record.metadata, lastFailureReason: verdict.reason },
      });
      const ownerView = isOwner(req, state);
      sendJson(res, 400, {
        ok: false,
        error: verdict.reason,
        request: redactRequest(failed as LocalPaymentRequest, ownerView),
      });
      return true;
    }

    const settled = await store.setStatus(match.id, "settled", {
      settledAt: now,
      txRef: verdict.txRef,
    });
    if (!settled) {
      sendJsonError(res, 404, "not found");
      return true;
    }
    if (options.onSettled) {
      await options.onSettled(settled, proof);
    }
    const ownerView = isOwner(req, state);
    sendJson(res, 200, {
      ok: true,
      request: redactRequest(settled, ownerView),
      event: { kind: "PaymentSettled", paymentRequestId: settled.id },
    });
    return true;
  }

  sendJsonError(res, 404, "not found");
  return true;
}

export function _resetLocalPaymentStoreForTesting(): void {
  // The exported singleton is a closure-backed store; re-create by replacing
  // its references. The store is only used in production wire-in; tests pass
  // an injected store so resetting here is best-effort.
  // No-op kept for parity with sensitive-request-routes.
}

export type { LocalPaymentContext, LocalPaymentRequest, LocalPaymentStatus };

// Internal helpers exported for the in-package store consumer.
export function _statusIsTerminal(status: LocalPaymentStatus): boolean {
  return (
    status === "settled" ||
    status === "failed" ||
    status === "expired" ||
    status === "canceled"
  );
}

// Provide the create-store factory for downstream wire-in customization.
export { createInMemoryLocalPaymentStore };
