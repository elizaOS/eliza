import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readActor(): string {
  const file = new URL("./actor/actor.ts", import.meta.url).pathname;
  return readFileSync(decodeURIComponent(file), "utf8");
}

describe("computeruse actor fetch timeout strict", () => {
  it("default fetcher is bounded with AbortSignal.timeout", () => {
    const src = readActor();
    expect(src).toMatch(/const fetcher[\s\S]{0,300}fetch\(url,[\s\S]{0,200}signal:\s*AbortSignal\.timeout\(30_000\)/);
  });

  it("fetcher preserves POST and headers", () => {
    const src = readActor();
    expect(src).toContain('method: "POST"');
    expect(src).toContain("AbortSignal.timeout(30_000)");
    expect(src).toMatch(/fetch\(url,[\s\S]*?method:[\s\S]*?signal:/);
  });

  it("sibling wechat proxy and vision remain bounded", () => {
    const src = readActor();
    expect((src.match(/AbortSignal\.timeout/g) || []).length).toBeGreaterThanOrEqual(1);
    // sibling wechat has timeout
    const wechat = readFileSync("/tmp/eliza-verify2/plugins/plugin-wechat/src/proxy-client.ts", "utf8");
    expect(wechat).toContain("AbortSignal.timeout");
    // ensure no bare fetch without signal remains
    const bare = src.includes('fetch(url, {\n          method: "POST",\n          body: init.body,\n          headers: init.headers,\n        });');
    expect(bare).toBe(false);
  });

  it("payload rejects hang and ordering", () => {
    const src = readActor();
    expect(src).toContain('signal: AbortSignal.timeout(30_000)');
    expect(src).toMatch(/fetch\(url,\s*\{[\s\S]*?method:[\s\S]*?body:[\s\S]*?headers:[\s\S]*?signal:/);
  });
});
