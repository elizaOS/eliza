import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getView,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Domain H route-level coverage gap: GET/HEAD /api/views/:id/bundle.js
// (views-routes.ts L496-635). The sibling views-routes.*.test.ts files exercise
// hero/navigate/interact/search but NOT the bundle.js branch — so its cache-bust
// + revalidation contract was previously untested at the route boundary. This
// file pins:
//   • mtime+size-derived ETag (NOT content hash) and 304 revalidation,
//   • disk re-read after an on-disk rewrite (no stale-buffer cache),
//   • fresh ETag minted on rewrite (stale validators no longer 304),
//   • live X-Content-Hash reflecting the current bytes,
//   • ?v=<bundleHash> immutable-vs-no-cache cache divergence (the core cache-bust),
//   • HEAD parity (status/ETag/Content-Length, empty body, no X-Content-Hash),
//   • not-built (missing file) 404, and the iOS/Android 403 platform gate.
// All synthetic: real temp dir, no PGLite/runtime/LLM. Expected ETag and
// X-Content-Hash are recomputed in-test from a fresh fs.stat/readFile so the
// assertions are exact rather than snapshot-fragile.

const TEST_PLUGIN = "@test/views-bundle";
const VIEW_ID = "bundle-view";
const PKG_JSON = JSON.stringify({ name: TEST_PLUGIN });

const V1_BYTES = Buffer.from("export const v=1;\n", "utf8");
// v2 is strictly LONGER than v1 so the file size alone changes the ETag even if
// the filesystem's mtime resolution is too coarse to register the rewrite.
const V2_BYTES = Buffer.from(
  "export const v=2; export const extra='a-longer-bundle-payload';\n",
  "utf8",
);

interface CapturedRes {
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeBundleCtx(
  id: string,
  opts: {
    method?: "GET" | "HEAD";
    headers?: Record<string, string>;
    search?: string;
  } = {},
): {
  ctx: ViewsRouteContext;
  res: CapturedRes;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.headers = opts.headers ?? {};
  const res: CapturedRes = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  const json = vi.fn();
  const error = vi.fn();
  const search = opts.search ?? "";
  const pathname = `/api/views/${encodeURIComponent(id)}/bundle.js`;
  const ctx: ViewsRouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    method: opts.method ?? "GET",
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    json,
    error,
    broadcastWs: vi.fn(),
  };
  return { ctx, res, json, error };
}

function headersFrom(res: CapturedRes): Record<string, string | number> {
  return res.writeHead.mock.calls[0]?.[1] as Record<string, string | number>;
}

function statusFrom(res: CapturedRes): number {
  return res.writeHead.mock.calls[0]?.[0] as number;
}

function bodyBufferFrom(res: CapturedRes): Buffer {
  const chunk = res.end.mock.calls[0]?.[0];
  if (chunk instanceof Buffer) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.alloc(0);
}

async function registerBundleView(dir: string): Promise<void> {
  await registerPluginViews(
    {
      name: TEST_PLUGIN,
      description: "Synthetic bundle test plugin.",
      views: [
        {
          id: VIEW_ID,
          label: "Bundle View",
          path: "/bundle-view",
          bundlePath: "bundle.js",
        },
      ],
    },
    dir,
  );
}

/** Recompute the route's exact ETag for the current on-disk bundle bytes. */
async function expectedEtag(bundlePath: string): Promise<string> {
  const s = await stat(bundlePath);
  return `"${createHash("sha256")
    .update(`${s.mtimeMs}-${s.size}`)
    .digest("hex")
    .slice(0, 16)}"`;
}

describe("GET/HEAD /api/views/:id/bundle.js — cache-bust + ETag revalidation", () => {
  let dir: string;
  let bundlePath: string;

  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    dir = await mkdtemp(path.join(tmpdir(), "views-bundle-"));
    bundlePath = path.join(dir, "bundle.js");
    await writeFile(path.join(dir, "package.json"), PKG_JSON);
    await writeFile(bundlePath, V1_BYTES);
    await registerBundleView(dir);
  });

  afterEach(async () => {
    clearCurrentViewState();
    unregisterPluginViews(TEST_PLUGIN);
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("serves the v1 bundle bytes with the JS content-type and an ETag", async () => {
    const { ctx, res } = makeBundleCtx(VIEW_ID);

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(statusFrom(res)).toBe(200);
    const headers = headersFrom(res);
    expect(headers["Content-Type"]).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(bodyBufferFrom(res)).toEqual(V1_BYTES);

    // ETag is derived from mtime+size, NOT the content hash.
    const etagV1 = headers.ETag as string;
    expect(etagV1).toBe(await expectedEtag(bundlePath));
    expect(etagV1).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it("returns 304 with an empty body when If-None-Match matches the current ETag", async () => {
    const etagV1 = await expectedEtag(bundlePath);
    const { ctx, res } = makeBundleCtx(VIEW_ID, {
      headers: { "if-none-match": etagV1 },
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(statusFrom(res)).toBe(304);
    expect(headersFrom(res)).toEqual({});
    // 304 body must be empty (res.end() called with no chunk).
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.end.mock.calls[0]).toHaveLength(0);
  });

  it("re-reads disk on rewrite: serves v2 bytes (not stale v1) and mints a fresh ETag", async () => {
    const etagV1 = await expectedEtag(bundlePath);

    // Rewrite with longer bytes AND bump mtime into the future so both size and
    // mtimeMs diverge (defends against coarse filesystem mtime granularity).
    await writeFile(bundlePath, V2_BYTES);
    const future = new Date(Date.now() + 60_000);
    await utimes(bundlePath, future, future);

    const { ctx, res } = makeBundleCtx(VIEW_ID);
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(statusFrom(res)).toBe(200);
    const headers = headersFrom(res);
    expect(bodyBufferFrom(res)).toEqual(V2_BYTES);
    expect(bodyBufferFrom(res)).not.toEqual(V1_BYTES);

    const etagV2 = headers.ETag as string;
    expect(etagV2).toBe(await expectedEtag(bundlePath));
    // Regression guard: a content/mtime change MUST mint a new validator.
    expect(etagV2).not.toBe(etagV1);
  });

  it("does not 304 a stale validator after a rewrite — serves fresh v2 bytes", async () => {
    const etagV1 = await expectedEtag(bundlePath);

    await writeFile(bundlePath, V2_BYTES);
    const future = new Date(Date.now() + 60_000);
    await utimes(bundlePath, future, future);

    const { ctx, res } = makeBundleCtx(VIEW_ID, {
      headers: { "if-none-match": etagV1 },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    // Old validator no longer matches → full 200 with the new bytes.
    expect(statusFrom(res)).toBe(200);
    expect(bodyBufferFrom(res)).toEqual(V2_BYTES);
  });

  it("emits an X-Content-Hash that tracks the live bytes (differs across v1/v2)", async () => {
    const { ctx: ctx1, res: res1 } = makeBundleCtx(VIEW_ID);
    await handleViewsRoutes(ctx1);
    const xchV1 = headersFrom(res1)["X-Content-Hash"] as string;
    expect(xchV1).toBe(
      `sha256-${createHash("sha256").update(V1_BYTES).digest("base64")}`,
    );

    await writeFile(bundlePath, V2_BYTES);
    const future = new Date(Date.now() + 60_000);
    await utimes(bundlePath, future, future);

    const { ctx: ctx2, res: res2 } = makeBundleCtx(VIEW_ID);
    await handleViewsRoutes(ctx2);
    const xchV2 = headersFrom(res2)["X-Content-Hash"] as string;
    expect(xchV2).toBe(
      `sha256-${createHash("sha256").update(V2_BYTES).digest("base64")}`,
    );
    expect(xchV2).not.toBe(xchV1);
  });

  it("uses Cache-Control: no-cache for a ?v= that does not match the bundle hash", async () => {
    const { ctx, res } = makeBundleCtx(VIEW_ID, { search: "?v=deadbeef" });
    await handleViewsRoutes(ctx);
    expect(headersFrom(res)["Cache-Control"]).toBe("no-cache");
  });

  it("serves immutable cache for ?v=<current bundleHash> but no-cache for a stale hash (cache-bust)", async () => {
    // bundleHash is the registration-time content sha (12 hex), NOT the ETag.
    const oldHash = getView(VIEW_ID)?.bundleHash;
    expect(oldHash).toBeTruthy();
    expect(oldHash).toMatch(/^[0-9a-f]{12}$/);
    // Sanity: bundleHash is the 12-char content sha of v1.
    expect(oldHash).toBe(
      createHash("sha256").update(V1_BYTES).digest("hex").slice(0, 12),
    );

    // Rewrite + re-register so the entry's bundleHash refreshes to the v2 content.
    await writeFile(bundlePath, V2_BYTES);
    const future = new Date(Date.now() + 60_000);
    await utimes(bundlePath, future, future);
    await registerBundleView(dir);

    const newHash = getView(VIEW_ID)?.bundleHash;
    expect(newHash).toBeTruthy();
    expect(newHash).not.toBe(oldHash);

    // Matching (current) hash → immutable long cache.
    const { ctx: ctxNew, res: resNew } = makeBundleCtx(VIEW_ID, {
      search: `?v=${newHash}`,
    });
    await handleViewsRoutes(ctxNew);
    expect(headersFrom(resNew)["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable",
    );

    // Stale (old v1) hash → must revalidate.
    const { ctx: ctxOld, res: resOld } = makeBundleCtx(VIEW_ID, {
      search: `?v=${oldHash}`,
    });
    await handleViewsRoutes(ctxOld);
    expect(headersFrom(resOld)["Cache-Control"]).toBe("no-cache");

    // The two cache directives MUST differ for old vs new hash.
    expect(headersFrom(resNew)["Cache-Control"]).not.toBe(
      headersFrom(resOld)["Cache-Control"],
    );
  });

  it("always revalidates (no-cache) when no ?v= param is present", async () => {
    const { ctx, res } = makeBundleCtx(VIEW_ID);
    await handleViewsRoutes(ctx);
    expect(headersFrom(res)["Cache-Control"]).toBe("no-cache");
  });

  it("HEAD returns 200 with ETag + Content-Length but an empty body and no X-Content-Hash", async () => {
    const { ctx, res } = makeBundleCtx(VIEW_ID, { method: "HEAD" });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(statusFrom(res)).toBe(200);
    const headers = headersFrom(res);
    expect(headers.ETag).toBe(await expectedEtag(bundlePath));
    expect(headers["Content-Length"]).toBe(0);
    expect(headers["X-Content-Hash"]).toBeUndefined();
    // HEAD body is undefined (no bytes).
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.end.mock.calls[0][0]).toBeUndefined();
  });

  it("404s via the error helper when the bundle file does not exist (not built)", async () => {
    const missingDir = await mkdtemp(
      path.join(tmpdir(), "views-bundle-missing-"),
    );
    await writeFile(
      path.join(missingDir, "package.json"),
      JSON.stringify({ name: "@test/views-bundle-missing" }),
    );
    // Register a view whose bundlePath points at a file we never write.
    await registerPluginViews(
      {
        name: "@test/views-bundle-missing",
        description: "Missing bundle plugin.",
        views: [
          {
            id: "missing-bundle-view",
            label: "Missing Bundle",
            path: "/missing-bundle",
            bundlePath: "bundle.js",
          },
        ],
      },
      missingDir,
    );

    try {
      const { ctx, res, error } = makeBundleCtx("missing-bundle-view");
      await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

      expect(error).toHaveBeenCalledTimes(1);
      const [, message, status] = error.mock.calls[0];
      expect(status).toBe(404);
      expect(String(message)).toMatch(/Bundle not built/);
      // No bytes streamed for the not-found case.
      expect(res.writeHead).not.toHaveBeenCalled();
    } finally {
      unregisterPluginViews("@test/views-bundle-missing");
      await rm(missingDir, { recursive: true, force: true });
    }
  });

  it("403s the dynamic bundle on a restricted platform (x-eliza-platform: ios)", async () => {
    const { ctx, res, error } = makeBundleCtx(VIEW_ID, {
      headers: { "x-eliza-platform": "ios" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledTimes(1);
    const [, message, status] = error.mock.calls[0];
    expect(status).toBe(403);
    expect(String(message)).toMatch(/not permitted/i);
    // Bytes must not be served.
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});
