/**
 * CORS middleware for the Cloud API on Cloudflare Workers.
 *
 * The SPA (`elizacloud.ai`, `www.elizacloud.ai`) and the Worker
 * (`api.elizacloud.ai`) live on different origins, so first-party auth
 * cookies (`steward-token`, etc.) only flow when CORS reflects a specific
 * origin AND sets `Access-Control-Allow-Credentials: true`. With
 * `origin: "*"` the browser silently drops the cookie on cross-origin
 * fetches, which surfaces as 401 on every authenticated route.
 *
 * Origin policy:
 *   - `https://elizacloud.ai` / `https://www.elizacloud.ai` (production SPA)
 *   - `https://milady.ai` / `https://www.milady.ai` (Milady app frontend)
 *   - `https://eliza.app` / `https://eliza.ai` / `https://www.eliza.ai` (legacy)
 *   - `*.eliza-cloud-enq.pages.dev` (Pages branch + PR previews)
 *   - `http://localhost:*` (local dev)
 *   - else: omit the `Access-Control-Allow-Origin` header (browser blocks).
 *
 * Non-browser callers (servers, SDKs hitting the API with `Bearer eliza_*`)
 * are unaffected — they don't enforce CORS.
 */

import { cors } from "hono/cors";

import { CORS_ALLOW_HEADER_NAMES, CORS_ALLOW_METHOD_NAMES } from "@/lib/cors-constants";

const STATIC_ALLOWED_ORIGINS = new Set<string>([
  "https://elizacloud.ai",
  "https://www.elizacloud.ai",
  "https://milady.ai",
  "https://www.milady.ai",
]);
const PAGES_PREVIEW_SUFFIX = ".eliza-cloud-enq.pages.dev";

function isAllowedOrigin(origin: string): boolean {
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
    return true;
  }
  try {
    const host = new URL(origin).hostname;
    return host.endsWith(PAGES_PREVIEW_SUFFIX) || host === PAGES_PREVIEW_SUFFIX.slice(1);
  } catch {
    return false;
  }
}

export const corsMiddleware = cors({
  origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : null),
  credentials: true,
  allowMethods: [...CORS_ALLOW_METHOD_NAMES],
  allowHeaders: [...CORS_ALLOW_HEADER_NAMES],
  maxAge: 86400,
});
