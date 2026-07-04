/**
 * Covers the content-addressed media store (api/media-store.ts) end to end
 * against a real temp-dir filesystem: content-addressed persistence + dedup,
 * data-URL decoding, mime→extension mapping, the SVG/markup download-vs-inline
 * serve security headers, Range serving over both the HTTP and in-process/iOS
 * paths, LRU eviction selection, orphan GC, and typed fast-fail on genuine fs
 * I/O errors (induced on the real fs, not mocked).
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-store-test-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Imported after env is set so resolveStateDir resolves to the temp dir.
const {
  persistMediaBytes,
  persistDataUrl,
  isStoredMediaUrl,
  serveMediaFile,
  selectMediaToEvict,
  handleMediaRouteRequest,
  mediaFileNameFromUrl,
  gcUnreferencedMedia,
  isInlineSafeMime,
  sniffMarkupMime,
  readStoredMediaBytes,
  writeStoredMediaFile,
} = await import("./media-store.ts");

function mediaPath(fileName: string): string {
  return path.join(stateDir, "media", fileName);
}

/** Minimal ServerResponse stub capturing status + body for serve tests. */
function makeRes(): {
  res: ServerResponse;
  get: () => { status: number; headers: Record<string, unknown>; body: string };
  /**
   * Resolves once the piped read stream has finished writing. The Range path
   * pipes `createReadStream(...).pipe(res)`, which opens the file on a later
   * tick; awaiting this keeps that async read from racing `afterAll`'s temp-dir
   * cleanup and surfacing as an unhandled ENOENT.
   */
  whenEnded: () => Promise<void>;
} {
  let status = 0;
  let headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  let resolveEnded: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const res = {
    writeHead(s: number, h: Record<string, unknown>) {
      status = s;
      headers = h;
      return this;
    },
    end(body?: unknown) {
      if (typeof body === "string") chunks.push(Buffer.from(body));
      else if (Buffer.isBuffer(body)) chunks.push(body);
      resolveEnded?.();
    },
    // createReadStream(...).pipe(res) calls write/end
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
    },
  } as unknown as ServerResponse;
  return {
    res,
    whenEnded: () => ended,
    get: () => ({
      status,
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  };
}

describe("media-store", () => {
  it("persists bytes to a content-addressed served URL", () => {
    const bytes = Buffer.from("hello-png-bytes");
    const a = persistMediaBytes(bytes, "image/png");
    expect(a.url).toMatch(/^\/api\/media\/[a-f0-9]{64}\.png$/);
    expect(a.fileName.endsWith(".png")).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "media", a.fileName))).toBe(true);
  });

  it("recovers when the resolved state dir changes or the media dir is removed", () => {
    const first = persistMediaBytes(Buffer.from("first-state"), "image/png");
    fs.rmSync(path.join(stateDir, "media"), { recursive: true, force: true });

    const second = persistMediaBytes(
      Buffer.from("first-state-after-delete"),
      "image/png",
    );
    expect(fs.existsSync(mediaPath(second.fileName))).toBe(true);
    expect(fs.existsSync(mediaPath(first.fileName))).toBe(false);

    const originalStateDir = stateDir;
    const nextStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "media-store-test-next-"),
    );
    process.env.ELIZA_STATE_DIR = nextStateDir;
    try {
      const third = persistMediaBytes(Buffer.from("next-state"), "image/png");
      expect(
        fs.existsSync(path.join(nextStateDir, "media", third.fileName)),
      ).toBe(true);
    } finally {
      process.env.ELIZA_STATE_DIR = originalStateDir;
      fs.rmSync(nextStateDir, { recursive: true, force: true });
    }
  });

  it("deduplicates identical bytes (same hash + URL)", () => {
    const bytes = Buffer.from("identical-content");
    const a = persistMediaBytes(bytes, "image/jpeg");
    const b = persistMediaBytes(bytes, "image/jpeg");
    expect(a.hash).toBe(b.hash);
    expect(a.url).toBe(b.url);
  });

  it("maps mime types to extensions", () => {
    expect(persistMediaBytes(Buffer.from("a"), "audio/mpeg").url).toMatch(
      /\.mp3$/,
    );
    expect(persistMediaBytes(Buffer.from("b"), "video/mp4").url).toMatch(
      /\.mp4$/,
    );
    expect(persistMediaBytes(Buffer.from("c"), "application/pdf").url).toMatch(
      /\.pdf$/,
    );
    // Unknown mime falls back to .bin
    expect(persistMediaBytes(Buffer.from("d"), "x/y").url).toMatch(/\.bin$/);
  });

  it("persists a base64 data URL", () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("png!").toString("base64")}`;
    const out = persistDataUrl(dataUrl);
    expect(out).not.toBeNull();
    expect(out?.url).toMatch(/^\/api\/media\/[a-f0-9]{64}\.png$/);
  });

  it("returns null for a non-data URL", () => {
    expect(persistDataUrl("https://example.com/x.png")).toBeNull();
  });

  it("persists a base64 data URL with media-type parameters (RFC 2397)", () => {
    // `;charset=utf-8` before `;base64` is valid — a parser that only accepts
    // `mime(;base64)?,` rejects it and the raw base64 stays inline.
    const payload = Buffer.from("hello params").toString("base64");
    const out = persistDataUrl(
      `data:text/plain;charset=utf-8;base64,${payload}`,
    );
    expect(out).not.toBeNull();
    expect(out?.url).toMatch(/^\/api\/media\/[a-f0-9]{64}\.txt$/);
    expect(fs.readFileSync(mediaPath(out?.fileName ?? "")).toString()).toBe(
      "hello params",
    );
  });

  it("decodes a parameterized non-base64 data URL as percent-encoded text", () => {
    const out = persistDataUrl("data:text/plain;charset=utf-8,hi%20there");
    expect(out).not.toBeNull();
    expect(fs.readFileSync(mediaPath(out?.fileName ?? "")).toString()).toBe(
      "hi there",
    );
  });

  it("still routes parameterized SVG data URLs through the markup path (stored as .svg, not inline-safe)", () => {
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>";
    const out = persistDataUrl(
      `data:image/svg+xml;charset=utf-8;base64,${Buffer.from(svg).toString("base64")}`,
    );
    expect(out).not.toBeNull();
    expect(out?.fileName.endsWith(".svg")).toBe(true);
  });

  it("recognizes stored media URLs", () => {
    expect(isStoredMediaUrl("/api/media/abc.png")).toBe(true);
    expect(isStoredMediaUrl("https://example.com/x.png")).toBe(false);
  });

  it("serves a stored file with content-type + immutable cache (HEAD)", () => {
    // HEAD returns headers synchronously without piping the file body, which
    // keeps the assertion off the async read stream.
    const { url } = persistMediaBytes(Buffer.from("served-bytes"), "image/png");
    const { res, get } = makeRes();
    const handled = serveMediaFile(
      { method: "HEAD", headers: {} } as never,
      res,
      url,
    );
    expect(handled).toBe(true);
    const out = get();
    expect(out.status).toBe(200);
    expect(out.headers["Content-Type"]).toBe("image/png");
    expect(String(out.headers["Cache-Control"])).toContain("immutable");
    expect(Number(out.headers["Content-Length"])).toBe(
      Buffer.from("served-bytes").length,
    );
  });

  it("rejects a path-traversal / malformed media name", () => {
    const { res, get } = makeRes();
    const handled = serveMediaFile(
      { method: "GET", headers: {} } as never,
      res,
      "/api/media/..%2f..%2fetc%2fpasswd",
    );
    expect(handled).toBe(true);
    expect(get().status).toBe(400);
  });

  it("returns 404 for an unknown content-addressed name", () => {
    const { res, get } = makeRes();
    const handled = serveMediaFile(
      { method: "GET", headers: {} } as never,
      res,
      `/api/media/${"a".repeat(64)}.png`,
    );
    expect(handled).toBe(true);
    expect(get().status).toBe(404);
  });

  it("ignores non-media paths", () => {
    const { res } = makeRes();
    expect(
      serveMediaFile(
        { method: "GET", headers: {} } as never,
        res,
        "/api/health",
      ),
    ).toBe(false);
  });
});

describe("serve-path security headers (stored-XSS defence)", () => {
  it("sets nosniff + a sandboxed CSP on every served response", () => {
    const { url } = persistMediaBytes(Buffer.from("png-1"), "image/png");
    const { res, get } = makeRes();
    serveMediaFile({ method: "HEAD", headers: {} } as never, res, url);
    const { headers } = get();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(String(headers["Content-Security-Policy"])).toContain("sandbox");
  });

  it("serves images inline so <img> tags keep working", () => {
    const { url } = persistMediaBytes(Buffer.from("png-2"), "image/png");
    const { res, get } = makeRes();
    serveMediaFile({ method: "HEAD", headers: {} } as never, res, url);
    expect(get().headers["Content-Disposition"]).toBe("inline");
  });

  it("forces SVG to download (attachment) — never inline-rendered", () => {
    // Declared svg → stored as .svg → served as image/svg+xml + attachment.
    const { url, fileName } = persistMediaBytes(
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      "image/svg+xml",
    );
    expect(fileName.endsWith(".svg")).toBe(true);
    const { res, get } = makeRes();
    serveMediaFile({ method: "HEAD", headers: {} } as never, res, url);
    const { headers } = get();
    expect(headers["Content-Type"]).toBe("image/svg+xml");
    expect(String(headers["Content-Disposition"])).toContain("attachment");
  });

  it("reconciles markup masquerading as a PNG → stored + served as a download", () => {
    // Bytes are really an SVG but the caller declared image/png.
    const { fileName } = persistMediaBytes(
      Buffer.from("<svg onload=alert(1)></svg>"),
      "image/png",
    );
    // Stored truthfully as .svg, so the serve path forces an attachment.
    expect(fileName.endsWith(".svg")).toBe(true);
  });

  it("applies the same security headers on the in-process (iOS) path", () => {
    const { url } = persistMediaBytes(Buffer.from("png-3"), "image/png");
    const res = handleMediaRouteRequest(url, "HEAD");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.headers["Content-Disposition"]).toBe("inline");
  });

  it("classifies inline-safe vs active mime types", () => {
    expect(isInlineSafeMime("image/png")).toBe(true);
    expect(isInlineSafeMime("audio/mpeg")).toBe(true);
    expect(isInlineSafeMime("video/mp4")).toBe(true);
    expect(isInlineSafeMime("application/pdf")).toBe(true);
    expect(isInlineSafeMime("image/svg+xml")).toBe(false);
    expect(isInlineSafeMime("text/html")).toBe(false);
    expect(isInlineSafeMime("application/octet-stream")).toBe(false);
  });

  it("sniffs SVG/HTML markup from leading bytes", () => {
    expect(sniffMarkupMime(Buffer.from("<svg></svg>"))).toBe("image/svg+xml");
    expect(
      sniffMarkupMime(Buffer.from("  \n<?xml version='1.0'?><svg/>")),
    ).toBe("image/svg+xml");
    expect(sniffMarkupMime(Buffer.from("<!DOCTYPE html><html></html>"))).toBe(
      "text/html",
    );
    expect(sniffMarkupMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("selectMediaToEvict", () => {
  it("evicts nothing when within the cap", () => {
    const files = [
      { name: "a", size: 10, mtimeMs: 1 },
      { name: "b", size: 20, mtimeMs: 2 },
    ];
    expect(selectMediaToEvict(files, 100)).toEqual([]);
  });

  it("evicts oldest-first down to 90% of the cap", () => {
    const files = [
      { name: "newest", size: 40, mtimeMs: 300 },
      { name: "oldest", size: 40, mtimeMs: 100 },
      { name: "middle", size: 40, mtimeMs: 200 },
    ];
    // total 120 > cap 100, target 90 → drop oldest (80 left), still >90? no, 80<=90 stop
    expect(selectMediaToEvict(files, 100)).toEqual(["oldest"]);
  });

  it("evicts multiple oldest files when far over cap", () => {
    const files = [
      { name: "f1", size: 50, mtimeMs: 1 },
      { name: "f2", size: 50, mtimeMs: 2 },
      { name: "f3", size: 50, mtimeMs: 3 },
    ];
    // total 150, cap 60, target 54 → drop f1 (100), f2 (50<=54) stop
    expect(selectMediaToEvict(files, 60)).toEqual(["f1", "f2"]);
  });
});

describe("handleMediaRouteRequest (in-process / iOS path)", () => {
  it("returns the file bytes as a Buffer body for GET", () => {
    const bytes = Buffer.from("route-bytes");
    const { url } = persistMediaBytes(bytes, "image/png");
    const res = handleMediaRouteRequest(url, "GET");
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/png");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(bytes)).toBe(true);
  });

  it("omits the body for HEAD but keeps headers", () => {
    const { url } = persistMediaBytes(Buffer.from("head-bytes"), "image/png");
    const res = handleMediaRouteRequest(url, "HEAD");
    expect(res.status).toBe(200);
    expect(res.body).toBeUndefined();
    expect(Number(res.headers["Content-Length"])).toBe(
      Buffer.from("head-bytes").length,
    );
  });

  it("404s an unknown file and 400s a malformed name", () => {
    expect(
      handleMediaRouteRequest(`/api/media/${"a".repeat(64)}.png`, "GET").status,
    ).toBe(404);
    expect(handleMediaRouteRequest("/api/media/..%2fetc", "GET").status).toBe(
      400,
    );
  });

  it("405s a non-GET/HEAD method", () => {
    expect(handleMediaRouteRequest("/api/media/x.png", "POST").status).toBe(
      405,
    );
  });

  it("advertises Accept-Ranges: bytes so the WebView knows seeking works", () => {
    const { url } = persistMediaBytes(Buffer.from("ranged"), "video/mp4");
    expect(handleMediaRouteRequest(url, "GET").headers["Accept-Ranges"]).toBe(
      "bytes",
    );
    // HEAD too — a player probes with HEAD before requesting ranges.
    expect(handleMediaRouteRequest(url, "HEAD").headers["Accept-Ranges"]).toBe(
      "bytes",
    );
  });

  it("serves a satisfiable Range as 206 with the exact byte slice", () => {
    const bytes = Buffer.from("0123456789");
    const { url } = persistMediaBytes(bytes, "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=2-5");
    expect(res.status).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 2-5/10");
    expect(res.headers["Content-Length"]).toBe("4");
    expect((res.body as Buffer).equals(Buffer.from("2345"))).toBe(true);
  });

  it("clamps an open-ended Range (bytes=N-) to the end of the file", () => {
    const bytes = Buffer.from("0123456789");
    const { url } = persistMediaBytes(bytes, "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=7-");
    expect(res.status).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 7-9/10");
    expect((res.body as Buffer).equals(Buffer.from("789"))).toBe(true);
  });

  it("serves a suffix Range (bytes=-N) as the last N bytes", () => {
    const bytes = Buffer.from("0123456789");
    const { url } = persistMediaBytes(bytes, "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=-3");
    expect(res.status).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 7-9/10");
    expect((res.body as Buffer).equals(Buffer.from("789"))).toBe(true);
  });

  it("clamps a too-large end to the last byte (partial overlap)", () => {
    const bytes = Buffer.from("0123456789");
    const { url } = persistMediaBytes(bytes, "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=5-999");
    expect(res.status).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 5-9/10");
    expect((res.body as Buffer).equals(Buffer.from("56789"))).toBe(true);
  });

  it("416s a Range whose start is past the end of the file", () => {
    const bytes = Buffer.from("0123456789");
    const { url } = persistMediaBytes(bytes, "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=50-60");
    expect(res.status).toBe(416);
    expect(res.headers["Content-Range"]).toBe("bytes */10");
  });

  it("416s a suffix Range (bytes=-N) against a zero-byte file", () => {
    // Regression (#12351 follow-up): the suffix branch used to skip the
    // satisfiability guard and return {start:0,end:-1} for a 0-length file,
    // yielding an invalid 206 (Content-Range: bytes 0--1/0) instead of 416.
    const { url } = persistMediaBytes(Buffer.alloc(0), "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=-5");
    expect(res.status).toBe(416);
    expect(res.headers["Content-Range"]).toBe("bytes */0");
  });

  it("ignores a malformed Range and serves the full 200", () => {
    const bytes = Buffer.from("0123456789");
    const { url } = persistMediaBytes(bytes, "audio/mpeg");
    const res = handleMediaRouteRequest(url, "GET", "bytes=abc");
    expect(res.status).toBe(200);
    expect(res.headers["Content-Length"]).toBe("10");
    expect((res.body as Buffer).equals(bytes)).toBe(true);
  });

  it("ignores a Range on a HEAD request (headers only, no 206)", () => {
    const { url } = persistMediaBytes(Buffer.from("0123456789"), "audio/mpeg");
    const res = handleMediaRouteRequest(url, "HEAD", "bytes=2-5");
    expect(res.status).toBe(200);
    expect(res.body).toBeUndefined();
  });
});

describe("serveMediaFile Range (HTTP path)", () => {
  it("answers a satisfiable Range with 206 + Content-Range + sliced bytes", async () => {
    const { url } = persistMediaBytes(Buffer.from("0123456789"), "audio/mpeg");
    const { res, get, whenEnded } = makeRes();
    const handled = serveMediaFile(
      { method: "GET", headers: { range: "bytes=2-5" } } as never,
      res,
      url,
    );
    expect(handled).toBe(true);
    await whenEnded();
    const out = get();
    expect(out.status).toBe(206);
    expect(out.headers["Content-Range"]).toBe("bytes 2-5/10");
    expect(Number(out.headers["Content-Length"])).toBe(4);
    expect(out.body).toBe("2345");
  });

  it("answers an out-of-bounds Range with 416", () => {
    const { url } = persistMediaBytes(Buffer.from("0123456789"), "audio/mpeg");
    const { res, get } = makeRes();
    serveMediaFile(
      { method: "GET", headers: { range: "bytes=50-60" } } as never,
      res,
      url,
    );
    const out = get();
    expect(out.status).toBe(416);
    expect(out.headers["Content-Range"]).toBe("bytes */10");
  });

  it("answers a suffix Range against a zero-byte file with 416 (not a mid-stream throw)", () => {
    // Regression (#12351 follow-up): for a 0-length file the suffix branch
    // returned {start:0,end:-1}; the HTTP path wrote the 206 head then
    // createReadStream({end:-1}) threw ERR_OUT_OF_RANGE after the response had
    // already started. It must return a clean 416 up front instead.
    const { url } = persistMediaBytes(Buffer.alloc(0), "audio/mpeg");
    const { res, get } = makeRes();
    serveMediaFile(
      { method: "GET", headers: { range: "bytes=-5" } } as never,
      res,
      url,
    );
    const out = get();
    expect(out.status).toBe(416);
    expect(out.headers["Content-Range"]).toBe("bytes */0");
  });
});

describe("iOS in-process binary round-trip", () => {
  // Mirrors the production chain that was broken before the fix:
  //   route handler → native bridge base64-encodes the Buffer body →
  //   iOS transport decodes bodyBase64 back to bytes.
  // Verifies binary survives the iOS path (no HTTP server on iOS).
  it("preserves exact bytes through route → bridge encode → transport decode", () => {
    // Non-UTF8 bytes that the old text-only path would have mangled.
    const original = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01,
    ]);
    const { url } = persistMediaBytes(original, "image/png");

    // 1. Route handler returns a Buffer body (in-process / iOS path).
    const routeResult = handleMediaRouteRequest(url, "GET");
    const body = routeResult.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);

    // 2. Native bridge (ios/bridge.ts): Buffer → bodyBase64 (lossless).
    const bodyBase64 = body.toString("base64");

    // 3. iOS transport (nativeResponseBody): atob → bytes.
    const binary = atob(bodyBase64);
    const decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
      decoded[i] = binary.charCodeAt(i);

    expect(Buffer.from(decoded).equals(original)).toBe(true);
  });
});

describe("mediaFileNameFromUrl", () => {
  it("extracts the stored filename from a served URL", () => {
    const name = `${"a".repeat(64)}.png`;
    expect(mediaFileNameFromUrl(`/api/media/${name}`)).toBe(name);
    expect(mediaFileNameFromUrl(`/api/media/${name}?v=1`)).toBe(name);
  });
  it("returns null for non-store / malformed URLs", () => {
    expect(mediaFileNameFromUrl("https://x/y.png")).toBeNull();
    expect(mediaFileNameFromUrl("/api/media/not-a-hash.png")).toBeNull();
    expect(mediaFileNameFromUrl("data:image/png;base64,AA")).toBeNull();
  });
});

describe("gcUnreferencedMedia", () => {
  it("removes old unreferenced files, keeps referenced + recent ones", () => {
    const referenced = persistMediaBytes(Buffer.from("keep-ref"), "image/png");
    const orphanOld = persistMediaBytes(Buffer.from("orphan-old"), "image/png");
    const orphanNew = persistMediaBytes(Buffer.from("orphan-new"), "image/png");
    // Age both the referenced and the old-orphan past the grace window.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(mediaPath(referenced.fileName), old, old);
    fs.utimesSync(mediaPath(orphanOld.fileName), old, old);

    const result = gcUnreferencedMedia(new Set([referenced.fileName]));

    expect(fs.existsSync(mediaPath(referenced.fileName))).toBe(true); // referenced
    expect(fs.existsSync(mediaPath(orphanOld.fileName))).toBe(false); // old + orphan → gone
    expect(fs.existsSync(mediaPath(orphanNew.fileName))).toBe(true); // within grace window
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });
});

// Real-fs error-path coverage for the fast-fail conversion (#12265): absence
// still returns null/false, but a genuine I/O failure now throws a typed
// ElizaError instead of being swallowed into a fabricated "media not found" /
// "restored fewer files". No mocking — the failures are induced on the real fs.
describe("readStoredMediaBytes fast-fail (#12265)", () => {
  it("returns null for a genuinely absent file (not a failure)", () => {
    expect(readStoredMediaBytes(`${"a".repeat(64)}.bin`)).toBeNull();
  });

  it("returns null for a path-traversal name rather than reading outside the store", () => {
    expect(readStoredMediaBytes("../../etc/passwd")).toBeNull();
  });

  it("throws MEDIA_STORE_READ_FAILED when a stored entry is unreadable", () => {
    // A directory sitting where the bytes should be makes readFileSync throw
    // EISDIR — a real I/O failure distinct from absence, and root-independent.
    const name = `${"d".repeat(64)}.bin`;
    fs.mkdirSync(mediaPath(name), { recursive: true });
    try {
      let caught: unknown;
      try {
        readStoredMediaBytes(name);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ElizaError);
      expect((caught as ElizaError).code).toBe("MEDIA_STORE_READ_FAILED");
      expect((caught as ElizaError).cause).toBeDefined();
    } finally {
      fs.rmdirSync(mediaPath(name));
    }
  });
});

describe("writeStoredMediaFile fast-fail (#12265)", () => {
  it("returns true on a successful write and false on a traversal name", () => {
    const name = `${"b".repeat(64)}.bin`;
    expect(writeStoredMediaFile(name, Buffer.from("ok"))).toBe(true);
    expect(readStoredMediaBytes(name)?.toString()).toBe("ok");
    expect(writeStoredMediaFile("../escape.bin", Buffer.from("x"))).toBe(false);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "throws MEDIA_STORE_WRITE_FAILED when the store dir is read-only",
    () => {
      // Real permission failure: point the store at a fresh dir, drop write
      // perms on its media/ subdir, and attempt a fresh-name write. root would
      // bypass mode bits, so skip there.
      const prev = process.env.ELIZA_STATE_DIR;
      const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), "media-store-ro-"));
      const roMedia = path.join(roRoot, "media");
      fs.mkdirSync(roMedia, { recursive: true });
      fs.chmodSync(roMedia, 0o555);
      process.env.ELIZA_STATE_DIR = roRoot;
      try {
        let caught: unknown;
        try {
          writeStoredMediaFile(`${"e".repeat(64)}.bin`, Buffer.from("x"));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ElizaError);
        expect((caught as ElizaError).code).toBe("MEDIA_STORE_WRITE_FAILED");
      } finally {
        fs.chmodSync(roMedia, 0o755);
        fs.rmSync(roRoot, { recursive: true, force: true });
        process.env.ELIZA_STATE_DIR = prev;
      }
    },
  );
});
