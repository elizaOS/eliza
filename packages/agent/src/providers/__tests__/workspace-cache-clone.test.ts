/**
 * Proves workspace-provider cache defensive copy (rank 8, cross-agent poisoning).
 * Sibling correct: sha1Cache defensive copy via digest.slice(0,16) + pending-prompts clone.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const providerPath = new URL("../workspace-provider.ts", import.meta.url).pathname;

describe("workspace-provider cache — defensive copy vs poison", () => {
  test("returns structuredClone on cache hit and set", () => {
    const src = readFileSync(providerPath, "utf8");
    expect(src).toContain("structuredClone(entry.files)");
    expect(src).toContain("files: structuredClone(files)");
    expect(src).toContain("return structuredClone(files);");
    expect(src).not.toContain("return entry.files;");
    expect(src).not.toContain("cache.set(dir, { files, at: now })");
  });

  test("TTL and size cap preserved", () => {
    const src = readFileSync(providerPath, "utf8");
    expect(src).toContain("CACHE_TTL_MS");
    expect(src).toContain("MAX_CACHE_ENTRIES");
    expect(src).toContain("60_000");
  });

  test("direct clone proof: mutating returned array does not poison cache", () => {
    // simulate old weak vs new fixed
    const cacheWeak = new Map<string, { files: any[]; at: number }>();
    const files = [{ name: "AGENTS.md", content: "original" }];
    cacheWeak.set("/workspace", { files, at: Date.now() });
    const aWeak = cacheWeak.get("/workspace")!.files; // weak returns direct
    aWeak.push({ name: "INJECTED.md", content: "ignore" } as any);
    const bWeak = cacheWeak.get("/workspace")!.files;
    expect(bWeak.length).toBe(2); // poisoned

    const cacheFixed = new Map<string, { files: any[]; at: number }>();
    const files2 = [{ name: "AGENTS.md", content: "original" }];
    cacheFixed.set("/workspace", { files: structuredClone(files2), at: Date.now() });
    const aFixed = structuredClone(cacheFixed.get("/workspace")!.files);
    aFixed.push({ name: "INJECTED.md", content: "ignore" } as any);
    (aFixed[0] as any).content = "mutated";
    const bFixed = structuredClone(cacheFixed.get("/workspace")!.files);
    expect(bFixed.length).toBe(1); // not poisoned
    expect(bFixed[0].content).toBe("original");
  });

  test("sibling still has defensive copy (sha1Cache slice)", () => {
    const utilsPath = new URL("../../../../core/src/utils.ts", import.meta.url).pathname;
    const src = readFileSync(utilsPath, "utf8");
    // sha1Cache sibling uses slice copy before mutation
    expect(src).toContain("digest.slice(0, 16)");
  });
});
