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

app.get("/*", async (c) => {
  try {
    // Auth: a real cloud session or org API key. We require a valid linked
    // account and capture the identity for usage attribution below.
    const account = await requireUserOrApiKeyWithOrg(c);
    const userId = account.id;
    const orgId = account.organization_id;

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
    const contentLength = upstreamResponse.headers.get("content-length");
    logger.info("[hf-proxy] proxied download", {
      repo,
      path,
      status: upstreamResponse.status,
      bytes: contentLength ? Number(contentLength) : null,
      orgId: redact.orgId(orgId),
      userId: redact.userId(userId),
    });

    const responseHeaders = new Headers();
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    // Stream the body straight through — never buffer a multi-GB GGUF.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
