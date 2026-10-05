/**
 * Public return page for a shared checkout link paid by someone without an Eliza session.
 * It renders fixed copy only: no session id, account, plan or payment state is read or shown,
 * and the outcome parameter is never payment authority (the webhook/confirm path is).
 */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const COPY = {
  paid: {
    title: "Check your subscription in Eliza",
    body: "You can close this page. Eliza shows your subscription after payment is verified.",
  },
  canceled: {
    title: "Checkout closed",
    body: "Return to Eliza to check your subscription or try again. You can close this page.",
  },
} as const;

export function renderPayerPage(outcome: string | undefined): string {
  const copy = outcome === "paid" ? COPY.paid : COPY.canceled;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${copy.title}</title><style>body{margin:0;font:18px/1.5 system-ui,sans-serif;background:#f7f7f5;color:#1d1d1b;display:grid;min-height:100vh;place-items:center}main{max-width:28rem;padding:2rem 1.25rem;text-align:center}h1{font-size:1.6rem;margin:0 0 .75rem}@media (prefers-color-scheme:dark){body{background:#151514;color:#f2f2ef}}</style></head><body><main><h1>${copy.title}</h1><p>${copy.body}</p></main></body></html>`;
}

const app = new Hono<AppEnv>();
app.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  return c.html(renderPayerPage(c.req.query("outcome")));
});
export default app;
