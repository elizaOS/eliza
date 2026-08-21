/**
 * Serving contract for the Pages middleware (functions/_middleware.ts) and the
 * Pages config files it complements: /assets/* misses 404 instead of the SPA
 * fallback, /sw.js is never cached, and the config files stay inside what
 * Cloudflare Pages actually supports. Drives the real onRequest handler with a
 * hand-rolled next() — no module mocks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  onRequest,
  resolveCanonicalPageRedirect,
} from "../functions/_middleware";
import {
  type PagesProxyEnv,
  proxyToApiWorker,
  resolveApiWorkerTarget,
} from "../functions/_proxy";

const ORIGIN = "https://cloud.eliza.app";

// The Pages static layer bakes `public/_headers` values into next() responses;
// the aggregated Cache-Control below is what it really produces when more than
// one rule matches, which is exactly what the middleware must repair.
const spaFallback = () =>
  new Response("<!doctype html><html><body>app</body></html>", {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ETag: '"index-etag"',
    },
  });

const assetHit = () =>
  new Response("export const chunk = 1;", {
    status: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache, public, max-age=31536000, immutable",
      ETag: '"asset-etag"',
    },
  });

const run = (
  request: Request,
  next: (input?: Request) => Promise<Response>,
  env: PagesProxyEnv = {},
): Promise<Response> => onRequest({ request, env, next });

describe("pages middleware /assets/* serving", () => {
  it("converts an asset miss (SPA fallback) into an uncacheable 404", async () => {
    const response = await run(
      new Request(`${ORIGIN}/assets/bogus-deadbeef1234.js`),
      async () => spaFallback(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("Not Found");
  });

  it("strips conditional validators so a poisoned client cannot 304 the fallback back to freshness", async () => {
    let forwarded: Request | undefined;
    const response = await run(
      new Request(`${ORIGIN}/assets/bogus-deadbeef1234.js`, {
        headers: {
          "If-None-Match": '"index-etag"',
          "If-Modified-Since": "Mon, 06 Jul 2026 00:00:00 GMT",
          Accept: "*/*",
        },
      }),
      async (input) => {
        forwarded = input;
        return spaFallback();
      },
    );

    expect(forwarded).toBeDefined();
    expect(forwarded?.headers.get("If-None-Match")).toBeNull();
    expect(forwarded?.headers.get("If-Modified-Since")).toBeNull();
    expect(forwarded?.headers.get("Accept")).toBe("*/*");
    expect(response.status).toBe(404);
  });

  it("serves real asset hits with the canonical immutable Cache-Control", async () => {
    const response = await run(
      new Request(`${ORIGIN}/assets/index-JIO74l6r.js`),
      async () => assetHit(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("Content-Type")).toBe("application/javascript");
    expect(response.headers.get("ETag")).toBe('"asset-etag"');
    expect(await response.text()).toBe("export const chunk = 1;");
  });

  it("passes non-ok asset responses through untouched", async () => {
    const response = await run(
      new Request(`${ORIGIN}/assets/gone.js`),
      async () =>
        new Response("gone", {
          status: 410,
          headers: { "Content-Type": "text/plain" },
        }),
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});

describe("pages middleware /sw.js serving", () => {
  it("rewrites the service worker Cache-Control to no-store", async () => {
    const response = await run(
      new Request(`${ORIGIN}/sw.js`),
      async () =>
        new Response("self.addEventListener('fetch', () => {});", {
          status: 200,
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
          },
        }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/javascript");
    expect(await response.text()).toBe(
      "self.addEventListener('fetch', () => {});",
    );
  });
});

describe("pages middleware SPA fallback and embed surface", () => {
  it("leaves the SPA fallback untouched for non-asset routes", async () => {
    const response = await run(
      new Request(`${ORIGIN}/chat/some-deep-link`),
      async () => spaFallback(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("relaxes frame-ancestors only for a matched /embed platform", async () => {
    const response = await run(
      new Request(`${ORIGIN}/embed?platform=telegram`),
      async () => {
        const fallback = spaFallback();
        fallback.headers.set("X-Frame-Options", "SAMEORIGIN");
        return fallback;
      },
    );

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("fails the embed surface closed for unknown platforms", async () => {
    const response = await run(new Request(`${ORIGIN}/embed`), async () =>
      spaFallback(),
    );

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'",
    );
  });
});

describe("unified host migration", () => {
  it("redirects legacy browser routes while preserving path and query", () => {
    expect(
      resolveCanonicalPageRedirect(
        "https://elizacloud.ai/dashboard/billing?source=legacy",
      ),
    ).toBe("https://cloud.eliza.app/cloud/billing?source=legacy");
    expect(
      resolveCanonicalPageRedirect(
        "https://app.elizacloud.ai/settings?tab=billing",
      ),
    ).toBe("https://cloud.eliza.app/settings?tab=billing");
    expect(
      resolveCanonicalPageRedirect("https://www.eliza.app/downloads"),
    ).toBe("https://eliza.app/downloads");
    expect(
      resolveCanonicalPageRedirect(
        "https://eliza.app/dashboard/agents?source=bookmark",
      ),
    ).toBe("https://cloud.eliza.app/cloud/agents?source=bookmark");
  });

  it.each([
    [
      "https://elizacloud.ai/dashboard/image?source=bookmark",
      "https://cloud.eliza.app/cloud/api-explorer?source=bookmark",
    ],
    [
      "https://app.elizacloud.ai/dashboard/build/new?template=starter",
      "https://cloud.eliza.app/cloud/my-agents?template=starter",
    ],
    [
      "https://staging.eliza.app/dashboard/containers/agents/agent-7",
      "https://cloud-staging.eliza.app/cloud/agents/agent-7",
    ],
    [
      "https://app-staging.elizacloud.ai/dashboard/agents/agent-8/chat?room=1",
      "https://cloud-staging.eliza.app/cloud/agents/agent-8?room=1",
    ],
    [
      "https://eliza.app/dashboard/settings?tab=billing&payment=success",
      "https://cloud.eliza.app/cloud/billing?tab=billing&payment=success",
    ],
    [
      "https://cloud.eliza.app/dashboard/voices?source=bookmark",
      "https://cloud.eliza.app/cloud/api-explorer?source=bookmark",
    ],
    [
      "https://elizacloud.ai/dashboard/api-keys?source=legacy",
      "https://cloud.eliza.app/cloud/api-keys?source=legacy",
    ],
  ])("semantically migrates live-shaped dashboard URL %s", (legacy, target) => {
    expect(resolveCanonicalPageRedirect(legacy)).toBe(target);
  });

  it("moves protocol paths on legacy hosts to the canonical API", () => {
    expect(
      resolveCanonicalPageRedirect("https://elizacloud.ai/api/v1/models"),
    ).toBe("https://api.eliza.app/api/v1/models");
    expect(
      resolveCanonicalPageRedirect("https://app.elizacloud.ai/steward/session"),
    ).toBe("https://api.eliza.app/steward/session");
  });

  it("selects canonical production and staging API upstreams by host", () => {
    expect(
      resolveApiWorkerTarget("https://cloud.eliza.app/api/health", {}),
    ).toBe("https://api.eliza.app/api/health");
    expect(
      resolveApiWorkerTarget(
        "https://cloud-staging.eliza.app/api/health?full=1",
        {},
      ),
    ).toBe("https://api-staging.eliza.app/api/health?full=1");
  });

  it("proxies exact protocol roots and OIDC discovery through the bound API Worker", async () => {
    const requests: Request[] = [];
    const apiWorker = {
      fetch: async (request: Request) => {
        requests.push(request);
        return new Response("bound", { status: 200 });
      },
    };
    for (const path of [
      "/api",
      "/steward",
      "/.well-known/openid-configuration",
      "/.well-known/oidc/jwks.json",
    ]) {
      const response = await run(
        new Request(`${ORIGIN}${path}`),
        async () => spaFallback(),
        { API_WORKER: apiWorker },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("bound");
    }
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api",
      "/steward",
      "/.well-known/openid-configuration",
      "/.well-known/oidc/jwks.json",
    ]);
  });

  it("preserves the canonical browser origin across the Steward service binding", async () => {
    const requests: Request[] = [];
    const apiWorker = {
      fetch: async (request: Request) => {
        requests.push(request);
        return Response.json({ nonce: "Tk9iR2buAPsSuxF0T" });
      },
    };

    for (const origin of [
      "https://eliza.app",
      "https://cloud.eliza.app",
      "https://staging.eliza.app",
      "https://cloud-staging.eliza.app",
    ]) {
      const response = await proxyToApiWorker({
        request: new Request(`${origin}/steward/auth/nonce`, {
          headers: { Accept: "application/json" },
        }),
        env: { API_WORKER: apiWorker },
      });
      expect(response.status).toBe(200);
    }

    expect(
      requests.map((request) => ({
        requestOrigin: new URL(request.url).origin,
        browserOrigin: request.headers.get("Origin"),
      })),
    ).toEqual([
      {
        requestOrigin: "https://api.eliza.app",
        browserOrigin: "https://eliza.app",
      },
      {
        requestOrigin: "https://api.eliza.app",
        browserOrigin: "https://cloud.eliza.app",
      },
      {
        requestOrigin: "https://api-staging.eliza.app",
        browserOrigin: "https://staging.eliza.app",
      },
      {
        requestOrigin: "https://api-staging.eliza.app",
        browserOrigin: "https://cloud-staging.eliza.app",
      },
    ]);
  });

  it("preserves an explicit cross-origin Origin for Steward to reject", async () => {
    let forwarded: Request | undefined;
    await proxyToApiWorker({
      request: new Request(`${ORIGIN}/steward/auth/nonce`, {
        headers: { Origin: "https://attacker.example" },
      }),
      env: {
        API_WORKER: {
          fetch: async (request) => {
            forwarded = request;
            return new Response(null, { status: 400 });
          },
        },
      },
    });

    expect(forwarded?.headers.get("Origin")).toBe("https://attacker.example");
  });

  it("fails closed when the deployed API service binding is missing", async () => {
    const response = await proxyToApiWorker({
      request: new Request(`${ORIGIN}/api/health`),
      env: {},
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves static robots.txt with no-store cache and text/plain type", async () => {
    const publicDir = join(import.meta.dirname, "..", "public");
    writeFileSync(
      join(publicDir, "robots.txt"),
      "User-agent: *\nDisallow: /api/\nSitemap: https://eliza.app/sitemap.xml\n",
      "utf8",
    );

    const response = await run(
      new Request(`${ORIGIN}/robots.txt`),
      async () => spaFallback(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toContain("Sitemap:");
  });

  it("serves static sitemap.xml with no-store cache and application/xml type", async () => {
    const publicDir = join(import.meta.dirname, "..", "public");
    writeFileSync(
      join(publicDir, "sitemap.xml"),
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
      "utf8",
    );

    const response = await run(
      new Request(`${ORIGIN}/sitemap.xml`),
      async () => spaFallback(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/xml; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toContain("<urlset");
  });

  it("returns 404 for unknown crawl endpoints instead of SPA HTML", async () => {
    const response = await run(
      new Request(`${ORIGIN}/bogus-crawl-endpoint.xml`),
      async () => spaFallback(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("Not Found");
  });

  it("returns 404 for unknown crawl .txt endpoints instead of SPA HTML", async () => {
    const response = await run(
      new Request(`${ORIGIN}/random-note.txt`),
      async () => spaFallback(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("Not Found");
  });
});

describe("pages config files stay within Cloudflare Pages semantics", () => {
  const publicDir = join(import.meta.dirname, "..", "public");
  const headers = readFileSync(join(publicDir, "_headers"), "utf8");
  const redirects = readFileSync(join(publicDir, "_redirects"), "utf8");

  const configLines = (raw: string): string[] =>
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

  it("keeps the /* no-cache rule as the only Cache-Control in _headers", () => {
    // The primary #15182 cache fix: index.html (and every SPA route) must stay
    // no-cache. It must also be the ONLY Cache-Control rule — _headers
    // aggregates same-named headers across matching rules instead of
    // overriding, so a second rule would comma-join with this one. All other
    // cache policy is owned by functions/_middleware.ts.
    const cacheControlLines = configLines(headers).filter((line) =>
      line.toLowerCase().startsWith("cache-control:"),
    );

    expect(cacheControlLines).toEqual(["Cache-Control: no-cache"]);
  });

  it("contains no _redirects rule with a status Cloudflare Pages ignores", () => {
    // Pages supports only 200 rewrites and 3xx redirects; anything else (like
    // the former `/assets/* /index.html 404`) is silently dropped and the
    // request falls through to the SPA catch-all — dead config that reads as
    // if asset misses were handled.
    const statuses = configLines(redirects)
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 3)
      .map((parts) => Number(parts[2]));

    for (const status of statuses) {
      expect(
        status === 200 || (status >= 301 && status <= 308),
        `unsupported _redirects status ${status}`,
      ).toBe(true);
    }
  });

  it("keeps the SPA catch-all as the final _redirects rule", () => {
    const lines = configLines(redirects);

    expect(lines.at(-1)).toBe("/*  /index.html  200");
  });
});
