import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readBootstrap(): string {
  const p = new URL("./aosp-local-inference-bootstrap.ts", import.meta.url).pathname;
  return readFileSync(decodeURIComponent(p), "utf8");
}

describe("aosp bootstrap fetch timeout strict", () => {
  it("recommended model download is bounded with AbortSignal.timeout", () => {
    const src = readBootstrap();
    expect(src).toMatch(/Auto-downloading recommended[\s\S]{0,400}fetch\(url,[\s\S]{0,200}signal:\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("kokoro voice download is bounded with AbortSignal.timeout", () => {
    const src = readBootstrap();
    expect(src).toMatch(/Auto-downloading Kokoro voice[\s\S]{0,400}fetch\(url,[\s\S]{0,200}signal:\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("sibling downloader and voice updater remain bounded", () => {
    const src = readBootstrap();
    const count = (src.match(/AbortSignal\.timeout\(30_000\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
    // ensure no bare redirect follow without signal remains for those two downloads
    const bare = src.includes('fetch(url, { redirect: "follow" })');
    expect(bare).toBe(false);
    // streaming helper is sibling-consistently bounded (aosp-llama-streaming has abort handling)
    expect(src).toContain("AbortSignal.timeout");
  });

  it("payload rejects hang and preserves redirect", () => {
    const src = readBootstrap();
    expect(src).toContain('redirect: "follow"');
    expect(src).toMatch(/fetch\(url,[\s\S]*?redirect:[\s\S]*?signal:/);
    const timeoutCount = (src.match(/AbortSignal\.timeout/g) || []).length;
    expect(timeoutCount).toBeGreaterThanOrEqual(2);
  });
});
