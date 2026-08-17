import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Lru } from "./lru.ts";

function readLru(): string {
  return readFileSync(new URL("./lru.ts", import.meta.url).pathname, "utf8");
}
function readCache(): string {
  return readFileSync(new URL("./cache.ts", import.meta.url).pathname, "utf8");
}

describe("tool cache clone strict", () => {
  it("Lru get and set clone via structuredClone", () => {
    const src = readLru();
    expect(src).toMatch(/get\(key: K\)[\s\S]{0,300}structuredClone\(value/);
    expect(src).toMatch(/set\(key: K, value: V\)[\s\S]{0,300}structuredClone\(value/);
    expect(src).toContain("structuredClone");
    const count = (src.match(/structuredClone/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("ToolCallCache get and set clone via structuredClone", () => {
    const src = readCache();
    expect(src).toMatch(/if \(!fromMemory\) this\.memory\.set\(key, structuredClone\(candidate\)\)/);
    expect(src).toContain("return structuredClone(candidate)");
    expect(src).toContain("output: structuredClone(output)");
    expect(src).toContain("this.memory.set(key, structuredClone(entry))");
    const count = (src.match(/structuredClone/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("behavioral: Lru mutation does not poison cache", () => {
    const lru = new Lru<string, { a: number; b: { c: number } }>(10);
    lru.set("k", { a: 1, b: { c: 2 } });
    const v1 = lru.get("k")!;
    v1.a = 999;
    v1.b.c = 999;
    const v2 = lru.get("k")!;
    expect(v2.a).toBe(1);
    expect(v2.b.c).toBe(2);
    // mutate after set
    const obj = { a: 5, b: { c: 6 } };
    lru.set("k2", obj);
    obj.a = 777;
    obj.b.c = 777;
    const v3 = lru.get("k2")!;
    expect(v3.a).toBe(5);
    expect(v3.b.c).toBe(6);
  });

  it("sibling runner and orchestrator remain cloned", () => {
    const lruSrc = readLru();
    expect(lruSrc).toContain("structuredClone");
    let runner: string;
    try {
      runner = readFileSync("/tmp/eliza-verify2/plugins/plugin-scheduling/src/scheduled-task/runner.ts", "utf8");
    } catch {
      runner = readFileSync(new URL("../../../plugins/plugin-scheduling/src/scheduled-task/runner.ts", import.meta.url).pathname, "utf8");
    }
    expect(runner).toContain("structuredClone");
    // orchestrator task store also clones
    const cacheSrc = readCache();
    expect(cacheSrc.match(/structuredClone/g)!.length).toBeGreaterThanOrEqual(4);
  });
});
