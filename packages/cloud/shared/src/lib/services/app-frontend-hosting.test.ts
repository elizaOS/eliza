/**
 * AppFrontendHosting service — unit tests for the pure serve logic.
 *
 * These exercise the real path-normalization, SEO/beacon injection, content
 * hashing, and `renderFrontendResponse` against an in-memory R2 shim (byte
 * accurate: implements both text() and arrayBuffer()). No DB — the
 * DB-integration path (deployBundle/activate) is covered by the repository
 * suite. Run:
 *   bun test packages/cloud/shared/src/lib/services/app-frontend-hosting.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AppFrontendDeployment } from "../../db/schemas/app-frontend-deployments";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  appFrontendHostingService,
  computeManifestHash,
  generateRobots,
  generateSitemap,
  inferContentType,
  injectBeacon,
  injectSeo,
  manifestHasFile,
  normalizeSitePath,
  sha256Hex,
} from "./app-frontend-hosting";

/** Byte-accurate in-memory R2 shim (text + arrayBuffer). */
function memoryBucket(objects: Map<string, Uint8Array>): RuntimeR2Bucket {
  return {
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        async text() {
          return new TextDecoder().decode(value);
        },
        async arrayBuffer() {
          return new Uint8Array(value).buffer;
        },
      };
    },
    async put(key, value) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(0);
      objects.set(key, bytes);
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

afterEach(() => setRuntimeR2Bucket(null));

describe("normalizeSitePath", () => {
  test("strips leading slashes and passes clean paths", () => {
    expect(normalizeSitePath("/index.html")).toBe("index.html");
    expect(normalizeSitePath("assets/app.js")).toBe("assets/app.js");
    expect(normalizeSitePath("/")).toBe("");
  });
  test("rejects traversal, backslashes, and nulls", () => {
    expect(normalizeSitePath("../secret")).toBeNull();
    expect(normalizeSitePath("a/../../b")).toBeNull();
    expect(normalizeSitePath("a\\b")).toBeNull();
    expect(normalizeSitePath("a\0b")).toBeNull();
  });
});

describe("inferContentType", () => {
  test("maps known extensions and defaults to octet-stream", () => {
    expect(inferContentType("index.html")).toContain("text/html");
    expect(inferContentType("app.js")).toContain("text/javascript");
    expect(inferContentType("logo.png")).toBe("image/png");
    expect(inferContentType("weird.xyz")).toBe("application/octet-stream");
  });
});

describe("computeManifestHash", () => {
  test("is deterministic and order-independent", async () => {
    const a = await computeManifestHash({
      entrypoint: "index.html",
      spaFallback: true,
      files: [
        { path: "index.html", hash: "h1", contentType: "text/html", size: 1 },
        { path: "a.js", hash: "h2", contentType: "text/javascript", size: 2 },
      ],
    });
    const b = await computeManifestHash({
      entrypoint: "index.html",
      spaFallback: true,
      files: [
        { path: "a.js", hash: "h2", contentType: "text/javascript", size: 2 },
        { path: "index.html", hash: "h1", contentType: "text/html", size: 1 },
      ],
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe("injectSeo", () => {
  test("injects missing tags before </head>", () => {
    const out = injectSeo("<html><head></head><body></body></html>", {
      title: "My App",
      description: "A great app",
      image: "https://x/og.png",
      url: "https://myapp.com",
      jsonLd: { "@context": "https://schema.org", "@type": "WebSite" },
    });
    expect(out).toContain("<title>My App</title>");
    expect(out).toContain('name="description" content="A great app"');
    expect(out).toContain('property="og:image" content="https://x/og.png"');
    expect(out).toContain('rel="canonical" href="https://myapp.com"');
    expect(out).toContain("application/ld+json");
    expect(out).toContain("<!-- eliza:seo -->");
  });
  test("does not override an existing title, and escapes injected values", () => {
    const out = injectSeo("<head><title>Original</title></head>", {
      title: 'Evil"<script>',
      description: "d",
    });
    expect(out).toContain("<title>Original</title>");
    expect(out).not.toContain("<title>Evil");
    // og:title still added, but escaped
    expect(out).toContain("&quot;&lt;script&gt;");
  });
  test("no-op without a head", () => {
    expect(injectSeo("<body>hi</body>", { title: "x" })).toBe("<body>hi</body>");
  });
  test("escapes a </script> breakout in injected JSON-LD", () => {
    const out = injectSeo("<head></head>", {
      jsonLd: { x: "</script><img src=x onerror=alert(1)>" },
    });
    expect(out).toContain("application/ld+json");
    // the literal breakout must not appear — `<` is escaped to <
    expect(out).not.toContain("</script><img");
    expect(out).toContain("\\u003c/script");
  });
});

describe("injectBeacon", () => {
  test("injects a sendBeacon script before </body> using a relative endpoint", () => {
    const out = injectBeacon("<body></body>", "app-123");
    expect(out).toContain("/api/v1/track/pageview");
    expect(out).toContain('"app-123"');
    expect(out).toContain("sendBeacon");
    expect(out).toContain("pushState");
  });
  test("no-op without a body", () => {
    expect(injectBeacon("<div></div>", "app-123")).toBe("<div></div>");
  });
});

describe("generateRobots / generateSitemap", () => {
  const manifest = {
    entrypoint: "index.html",
    spaFallback: false,
    files: [
      { path: "index.html", hash: "h0", contentType: "text/html", size: 1 },
      { path: "about.html", hash: "h1", contentType: "text/html", size: 1 },
      { path: "blog/post.html", hash: "h2", contentType: "text/html", size: 1 },
      { path: "assets/app.js", hash: "h3", contentType: "text/javascript", size: 1 },
    ],
  };

  test("robots.txt allows crawling and links the sitemap", () => {
    const out = generateRobots("https://myapp.com/");
    expect(out).toContain("User-agent: *");
    expect(out).toContain("Allow: /");
    expect(out).toContain("Sitemap: https://myapp.com/sitemap.xml");
  });

  test("sitemap.xml lists the root + every HTML page, not assets", () => {
    const out = generateSitemap(manifest, "https://myapp.com");
    expect(out).toContain("<loc>https://myapp.com/</loc>");
    expect(out).toContain("<loc>https://myapp.com/about.html</loc>");
    expect(out).toContain("<loc>https://myapp.com/blog/post.html</loc>");
    // entrypoint is not duplicated as index.html, and assets are excluded
    expect(out).not.toContain("index.html</loc>");
    expect(out).not.toContain("app.js");
    expect(out).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  test("manifestHasFile lets a site's own robots/sitemap win", () => {
    expect(manifestHasFile(manifest, "index.html")).toBe(true);
    expect(manifestHasFile(manifest, "robots.txt")).toBe(false);
  });
});

describe("renderFrontendResponse", () => {
  const app = { id: "app-1", name: "My App", description: "desc", logo_url: null };

  async function seed() {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const prefix = "app-frontends/org/app-1/dep-1/";
    const html = new TextEncoder().encode("<html><head></head><body><h1>Home</h1></body></html>");
    const js = new TextEncoder().encode("console.log('hi')");
    const htmlHash = await sha256Hex(html);
    const jsHash = await sha256Hex(js);
    objects.set(`${prefix}${htmlHash}`, html);
    objects.set(`${prefix}${jsHash}`, js);
    const deployment = {
      id: "dep-1",
      app_id: "app-1",
      r2_prefix: prefix,
      status: "active",
      manifest: {
        entrypoint: "index.html",
        spaFallback: true,
        files: [
          {
            path: "index.html",
            hash: htmlHash,
            contentType: "text/html; charset=utf-8",
            size: html.byteLength,
          },
          {
            path: "assets/app.js",
            hash: jsHash,
            contentType: "text/javascript; charset=utf-8",
            size: js.byteLength,
          },
        ],
      },
    } as unknown as AppFrontendDeployment;
    return { deployment };
  }

  test("serves the entrypoint for '/' with SEO + beacon, flagged as a document", async () => {
    const { deployment } = await seed();
    const res = await appFrontendHostingService.renderFrontendResponse({
      app,
      deployment,
      requestPath: "/",
      seo: { title: "My App", description: "desc" },
    });
    expect(res.status).toBe(200);
    expect(res.isDocument).toBe(true);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toContain("must-revalidate");
    expect(String(res.body)).toContain("<title>My App</title>");
    expect(String(res.body)).toContain("/api/v1/track/pageview");
  });

  test("serves a hashed asset with immutable caching, not a document", async () => {
    const { deployment } = await seed();
    const res = await appFrontendHostingService.renderFrontendResponse({
      app,
      deployment,
      requestPath: "/assets/app.js",
    });
    expect(res.status).toBe(200);
    expect(res.isDocument).toBe(false);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers.etag).toBeTruthy();
  });

  test("SPA fallback: unknown extensionless route serves the entrypoint", async () => {
    const { deployment } = await seed();
    const res = await appFrontendHostingService.renderFrontendResponse({
      app,
      deployment,
      requestPath: "/dashboard/settings",
    });
    expect(res.status).toBe(200);
    expect(res.isDocument).toBe(true);
    expect(String(res.body)).toContain("<h1>Home</h1>");
  });

  test("404 for a missing asset (has extension, no SPA fallback)", async () => {
    const { deployment } = await seed();
    const res = await appFrontendHostingService.renderFrontendResponse({
      app,
      deployment,
      requestPath: "/missing.js",
    });
    expect(res.status).toBe(404);
  });

  test("path traversal cannot escape the manifest", async () => {
    const { deployment } = await seed();
    const res = await appFrontendHostingService.renderFrontendResponse({
      app,
      deployment,
      requestPath: "/../../etc/passwd",
    });
    // normalized to the entrypoint fallback or 404 — never an escaped path.
    expect([200, 404]).toContain(res.status);
  });
});
