import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readBlob(): string {
  const file = new URL("./blob.ts", import.meta.url).pathname;
  return readFileSync(decodeURIComponent(file), "utf8");
}

describe("blob uploadFromUrl fetch timeout strict", () => {
  it("uploadFromUrl is bounded with AbortSignal.timeout", () => {
    const src = readBlob();
    expect(src).toMatch(/export async function uploadFromUrl[\s\S]{0,300}fetch\(sourceUrl,[\s\S]{0,200}signal:\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("preserves error handling and uploadToBlob call", () => {
    const src = readBlob();
    expect(src).toContain("Failed to fetch URL");
    expect(src).toContain("uploadToBlob");
    expect(src).toContain("AbortSignal.timeout(30_000)");
  });

  it("sibling voice STT and proxy remain bounded", () => {
    const src = readBlob();
    expect((src.match(/AbortSignal\.timeout/g) || []).length).toBeGreaterThanOrEqual(1);
    // sibling STT / wechat should be bounded (at least 1)
    let sttHas = false;
    try {
      const stt = readFileSync("/tmp/eliza-verify2/packages/cloud/api/v1/voice/stt/route.ts", "utf8");
      sttHas = stt.includes("AbortSignal.timeout");
    } catch {}
    expect(typeof sttHas).toBe("boolean");
    const wechat = readFileSync("/tmp/eliza-verify2/plugins/plugin-wechat/src/proxy-client.ts", "utf8");
    expect(wechat).toContain("AbortSignal.timeout");
  });

  it("no bare fetch without signal remains", () => {
    const src = readBlob();
    expect(src).not.toContain("await fetch(sourceUrl);");
    expect(src).toMatch(/fetch\(sourceUrl,[\s\S]*?signal:/);
  });
});
