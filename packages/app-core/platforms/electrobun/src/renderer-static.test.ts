/** Exercises renderer static behavior with deterministic app-core test fixtures. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getRendererAssetContentType,
  resolveRendererAsset,
  resolveRendererAssetByteRange,
} from "./renderer-static";

describe("renderer static assets", () => {
  it("serves cloud media and font assets with browser-native content types", () => {
    expect(getRendererAssetContentType(".webm")).toBe("video/webm");
    expect(getRendererAssetContentType(".mp4")).toBe("video/mp4");
    expect(getRendererAssetContentType(".webp")).toBe("image/webp");
    expect(getRendererAssetContentType(".woff2")).toBe("font/woff2");
  });

  it("resolves the original MIME extension for precompressed assets", () => {
    const rendererDir = path.join(path.sep, "app", "dist");
    const indexPath = path.join(rendererDir, "index.html");
    const gzPath = path.join(rendererDir, "assets", "app.js.gz");
    const files = new Set([indexPath, gzPath]);

    const resolved = resolveRendererAsset({
      rendererDir,
      urlPath: "/assets/app.js",
      existsSync: (filePath) => files.has(filePath),
      statSync: () => ({ isDirectory: () => false }),
    });

    expect(resolved).toEqual({
      filePath: gzPath,
      isGzipped: true,
      mimeExt: ".js",
    });
  });

  it("resolves browser media byte ranges", () => {
    expect(resolveRendererAssetByteRange("bytes=0-1", 10)).toEqual({
      start: 0,
      end: 1,
    });
    expect(resolveRendererAssetByteRange("bytes=5-", 10)).toEqual({
      start: 5,
      end: 9,
    });
    expect(resolveRendererAssetByteRange("bytes=-4", 10)).toEqual({
      start: 6,
      end: 9,
    });
    expect(resolveRendererAssetByteRange("bytes=11-", 10)).toBeNull();
    expect(resolveRendererAssetByteRange("items=0-1", 10)).toBeNull();
  });
});
