import { Buffer } from "node:buffer";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
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
} = await import("./media-store.ts");

/** Minimal ServerResponse stub capturing status + body for serve tests. */
function makeRes(): {
  res: ServerResponse;
  get: () => { status: number; headers: Record<string, unknown>; body: string };
} {
  let status = 0;
  let headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number, h: Record<string, unknown>) {
      status = s;
      headers = h;
      return this;
    },
    end(body?: unknown) {
      if (typeof body === "string") chunks.push(Buffer.from(body));
      else if (Buffer.isBuffer(body)) chunks.push(body);
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
