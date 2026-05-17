import { describe, expect, it } from "vitest";
import {
  getRendererAssetContentType,
  resolveRendererAsset,
} from "./renderer-static";

describe("renderer static assets", () => {
  it("serves cloud media and font assets with browser-native content types", () => {
    expect(getRendererAssetContentType(".webm")).toBe("video/webm");
    expect(getRendererAssetContentType(".mp4")).toBe("video/mp4");
    expect(getRendererAssetContentType(".webp")).toBe("image/webp");
    expect(getRendererAssetContentType(".woff2")).toBe("font/woff2");
  });

  it("resolves the original MIME extension for precompressed assets", () => {
    const files = new Set([
      "/app/dist/index.html",
      "/app/dist/assets/app.js.gz",
    ]);

    const resolved = resolveRendererAsset({
      rendererDir: "/app/dist",
      urlPath: "/assets/app.js",
      existsSync: (filePath) => files.has(filePath),
      statSync: () => ({ isDirectory: () => false }),
    });

    expect(resolved).toEqual({
      filePath: "/app/dist/assets/app.js.gz",
      isGzipped: true,
      mimeExt: ".js",
    });
  });
});
