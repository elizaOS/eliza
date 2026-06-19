#!/usr/bin/env node
// Deep-link contract smoke test for the hosted-web Eliza app (Topology A).
//
// Every backend-issued URL (email links, Stripe/OAuth redirects, shared chat /
// approval / ballot links) MUST resolve in the app at its existing SPA path.
// If any of these 404s after the apex cutover, a live link in the wild breaks.
// This script is the automated gate for that contract (PLAN.md §6.2): it hits
// every required path against a base URL and asserts each is SERVED — i.e. the
// SPA shell (HTML 200 carrying the React mount) or a redirect to one — never a
// 404 or a non-HTML asset error.
//
// Usage:
//   node packages/app/scripts/smoke-deeplinks.mjs <baseUrl>
//   node packages/app/scripts/smoke-deeplinks.mjs https://staging.eliza-cloud.pages.dev
//   SMOKE_BASE_URL=http://localhost:4173 node packages/app/scripts/smoke-deeplinks.mjs
//
// Default base is a local `vite preview` (http://localhost:4173). Run a static
// preview of the web build first, e.g.:
//   bun run --cwd packages/app build:web
//   bunx serve packages/app/dist -s -l 4173   # or any SPA-fallback static server
//
// Note: a plain `vite preview` does NOT apply the Cloudflare `_redirects` SPA
// fallback, so unknown paths can 404 there. For a faithful test of the served
// contract, point this at a Cloudflare Pages preview deploy (which honours
// functions/ + public/_redirects), or any static server with SPA fallback.
//
// Exit code 0 = every required deep link resolves; non-zero = at least one
// broke (gates the cutover).

import process from "node:process";

const DEFAULT_BASE = "http://localhost:4173";

// Concrete sample values substituted into parameterised routes. The values are
// arbitrary — the contract is that the SPA SERVES the path shape, not that the
// id exists (the client resolves the id at runtime against the API).
const SAMPLE = {
  paymentRequestId: "smoke-payment-id",
  appId: "smoke-app-id",
  chargeId: "smoke-charge-id",
  characterRef: "smoke-character",
  approvalId: "smoke-approval-id",
  ballotId: "smoke-ballot-id",
  requestId: "smoke-request-id",
};

/**
 * The full required deep-link contract. `expect` is the acceptable outcome:
 *   "spa"      → HTML 200 carrying the SPA shell (the common case)
 *   "redirect" → a 3xx redirect (server- or edge-issued) is acceptable too;
 *                an SPA 200 that client-redirects is ALSO accepted (the app
 *                does /dashboard → my-agents as a client <Navigate>, which a
 *                static fetch sees as an SPA 200).
 */
const REQUIRED_PATHS = [
  { path: "/", expect: "spa", note: "apex landing / open-app" },
  { path: "/login", expect: "spa", note: "Steward login" },
  {
    path: "/auth/cli-login",
    expect: "spa",
    note: "device-code (Remote) handoff",
  },
  {
    path: "/auth/callback/email",
    expect: "spa",
    note: "email magic-link callback",
  },
  {
    path: "/auth/success",
    expect: "spa",
    note: "OAuth success redirect target",
  },
  { path: "/app-auth/authorize", expect: "spa", note: "app OAuth authorize" },
  {
    path: "/invite/accept",
    expect: "spa",
    note: "org invite (token in query)",
  },
  {
    path: "/payment/success",
    expect: "spa",
    note: "payment provider redirect",
  },
  {
    path: `/payment/${SAMPLE.paymentRequestId}`,
    expect: "spa",
    note: "external payment request (id IS the link)",
  },
  {
    path: `/payment/app-charge/${SAMPLE.appId}/${SAMPLE.chargeId}`,
    expect: "spa",
    note: "app-charge payment",
  },
  {
    path: `/chat/${SAMPLE.characterRef}`,
    expect: "spa",
    note: "public shared chat (no-login funnel)",
  },
  {
    path: `/approve/${SAMPLE.approvalId}`,
    expect: "spa",
    note: "public approval link",
  },
  {
    path: `/ballot/${SAMPLE.ballotId}`,
    expect: "spa",
    note: "public ballot link",
  },
  {
    path: `/sensitive-requests/${SAMPLE.requestId}`,
    expect: "spa",
    note: "public sensitive-request link",
  },
  {
    path: "/dashboard",
    expect: "redirect",
    note: "redirect → my-agents (client <Navigate> = SPA 200, or 3xx)",
  },
  { path: "/terms-of-service", expect: "spa", note: "legal" },
  { path: "/privacy-policy", expect: "spa", note: "legal" },
  { path: "/bsc", expect: "spa", note: "bsc promo" },
];

function resolveBaseUrl() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const raw = arg ?? process.env.SMOKE_BASE_URL ?? DEFAULT_BASE;
  return raw.replace(/\/+$/, "");
}

function isSpaShell(body, contentType) {
  if (!contentType.includes("text/html")) return false;
  // The app mounts React at <div id="root">; index.html always contains it.
  // Accept either the mount node or the <title> token-replaced shell so the
  // check is robust to minor index.html changes.
  return body.includes('id="root"') || body.includes("<!doctype html");
}

async function checkOne(baseUrl, spec) {
  const url = `${baseUrl}${spec.path}`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
  } catch (error) {
    return {
      ...spec,
      ok: false,
      status: 0,
      detail: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";

  // A 3xx is always acceptable (server/edge redirect into the app).
  if (status >= 300 && status < 400) {
    const location = res.headers.get("location") ?? "";
    return {
      ...spec,
      ok: true,
      status,
      detail: `redirect → ${location || "(no location)"}`,
    };
  }

  // 404 is the failure we exist to catch.
  if (status === 404) {
    return { ...spec, ok: false, status, detail: "404 — deep link NOT served" };
  }

  if (status !== 200) {
    return {
      ...spec,
      ok: false,
      status,
      detail: `unexpected status (want 200 SPA shell or 3xx)`,
    };
  }

  const body = await res.text();
  if (!isSpaShell(body, contentType)) {
    return {
      ...spec,
      ok: false,
      status,
      detail: `200 but not the SPA shell (content-type=${contentType || "?"}) — likely a non-HTML asset or wrong fallback`,
    };
  }

  return { ...spec, ok: true, status, detail: "SPA shell served" };
}

async function main() {
  const baseUrl = resolveBaseUrl();
  process.stdout.write(`\nDeep-link smoke test against: ${baseUrl}\n\n`);

  const results = [];
  for (const spec of REQUIRED_PATHS) {
    // Sequential to keep output ordered and avoid hammering a preview server.
    results.push(await checkOne(baseUrl, spec));
  }

  const pad = (s, n) => String(s).padEnd(n);
  let failures = 0;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failures += 1;
    process.stdout.write(
      `  ${pad(mark, 5)} ${pad(r.status, 4)} ${pad(r.path, 48)} ${r.detail}\n`,
    );
  }

  const total = results.length;
  process.stdout.write(
    `\n${total - failures}/${total} deep links resolved` +
      (failures ? ` — ${failures} BROKEN\n` : " — contract intact\n") +
      "\n",
  );

  if (failures > 0) {
    process.stdout.write(
      "One or more backend-issued deep links did not resolve. Do NOT cut over.\n" +
        "If testing a plain `vite preview` (no SPA fallback), use a Cloudflare\n" +
        "Pages preview or an SPA-fallback static server instead.\n\n",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(
    `smoke-deeplinks failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
