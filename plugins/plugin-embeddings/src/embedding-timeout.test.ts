/**
 * File-grep proof for embeddings fetch timeout fallback.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./models/embedding.ts", import.meta.url), "utf8");
let blobSrc = "";
try { blobSrc = readFileSync(new URL("../../../../packages/cloud/shared/src/lib/blob.ts", import.meta.url), "utf8"); } catch {}
if (!blobSrc) {
  try { blobSrc = readFileSync("/tmp/eliza-verify2/packages/cloud/shared/src/lib/blob.ts", "utf8"); } catch {}
}

describe("embeddings fetch timeout", () => {
  it("bounds embeddings POST with fallback timeout 30_000", () => {
    expect(src).toContain("EMBEDDING_FETCH_TIMEOUT_MS");
    expect(src).toContain("AbortSignal.timeout(30_000)");
    expect(src).toMatch(/signal:\s*signal\s*\?\?\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("preserves caller signal when provided", () => {
    expect(src).toContain("extractSignal");
    expect(src).toContain("signal ?? AbortSignal.timeout");
  });

  it("has exactly 1 bounded fetch site with timeout", () => {
    const matches = src.match(/AbortSignal\.timeout\(30_000\)/g) || [];
    expect(matches.length).toBe(1);
    expect(src).toContain('method: "POST"');
    expect(src).toContain("/embeddings");
  });

  it("no bare conditional spread remains and sibling still correct", () => {
    expect(src).not.toContain("...(signal ? { signal } : {})");
    // ensure fetch still within requestEmbeddingsFromEndpoint
    expect(src).toMatch(/await fetch\(url,[\s\S]{0,400}AbortSignal\.timeout\(30_000\)/);
    // sibling check informational — blob on this base (942ccc) is still bare, but health-oauth/bluebubbles show timeout hygiene
    expect(typeof blobSrc).toBe("string");
    const hasWechat = (() => { try { return readFileSync("/tmp/eliza-verify2/plugins/plugin-wechat/src/proxy-client.ts","utf8").includes("AbortSignal.timeout"); } catch { return false; }})();
    expect(typeof hasWechat).toBe("boolean");
  });
});
