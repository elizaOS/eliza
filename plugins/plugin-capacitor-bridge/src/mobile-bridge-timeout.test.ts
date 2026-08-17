import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readBridge(): string {
  const p = new URL("./mobile-device-bridge-bootstrap.ts", import.meta.url).pathname;
  return readFileSync(decodeURIComponent(p), "utf8");
}

describe("mobile bridge fetch timeout strict", () => {
  it("recommended model download is bounded with AbortSignal.timeout", () => {
    const src = readBridge();
    expect(src).toMatch(/Auto-downloading recommended[\s\S]{0,400}fetch\(url,[\s\S]{0,200}signal:\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("imageUrlToBase64 is bounded with AbortSignal.timeout", () => {
    const src = readBridge();
    expect(src).toMatch(/imageUrlToBase64[\s\S]{0,400}fetch\(url,[\s\S]{0,200}signal:\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("no bare fetch without signal remains for those paths", () => {
    const src = readBridge();
    expect(src).not.toContain('fetch(url, { redirect: "follow" })');
    expect(src).not.toMatch(/const resp = await fetch\(url\);/);
    const count = (src.match(/AbortSignal\.timeout\(30_000\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("payload preserves redirect and signal ordering", () => {
    const src = readBridge();
    expect(src).toContain('redirect: "follow"');
    expect(src).toMatch(/fetch\(url,[\s\S]*?redirect:[\s\S]*?signal:/);
    expect((src.match(/AbortSignal\.timeout/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
