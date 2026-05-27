import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReportCache, makeCacheKey } from "../src/cache/report-cache.ts";
import type { PathologyReport } from "../src/types.ts";

function fakeReport(overrides: Partial<PathologyReport> = {}): PathologyReport {
  const cacheKey = makeCacheKey({ surface: "src/api", since: "14d" });
  return {
    surface: "src/api",
    repoRoot: "/fake",
    window: { since: "2026-04-01T00:00:00Z", until: "2026-04-15T00:00:00Z" },
    commitCount: 3,
    authors: ["alice"],
    timeline: [],
    peaks: [],
    drifts: [],
    rotCauses: [],
    llmCalls: 0,
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    generatedAt: "2026-04-15T10:00:00Z",
    cacheKey,
    ...overrides,
  };
}

describe("makeCacheKey", () => {
  it("is stable for the same input", () => {
    const a = makeCacheKey({ surface: "src/api", since: "14d" });
    const b = makeCacheKey({ surface: "src/api", since: "14d" });
    expect(a).toBe(b);
  });

  it("differs when surface or since differs", () => {
    expect(makeCacheKey({ surface: "src/api", since: "14d" })).not.toBe(
      makeCacheKey({ surface: "src/api", since: "7d" })
    );
    expect(makeCacheKey({ surface: "src/api", since: "14d" })).not.toBe(
      makeCacheKey({ surface: "src/ui", since: "14d" })
    );
  });
});

describe("createReportCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "gitpath-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads back what it writes", () => {
    const cache = createReportCache(dir);
    const report = fakeReport();
    cache.write(report);
    const back = cache.read(report.cacheKey);
    expect(back).toEqual(report);
  });

  it("returns null on miss", () => {
    const cache = createReportCache(dir);
    expect(cache.read("nonexistent")).toBeNull();
  });

  it("treats malformed cache files as misses", () => {
    const cache = createReportCache(dir);
    writeFileSync(path.join(dir, "bad.json"), "{not json", "utf8");
    expect(cache.read("bad")).toBeNull();
  });

  it("lists reports sorted newest-first", () => {
    const cache = createReportCache(dir);
    cache.write(
      fakeReport({
        cacheKey: "a",
        surface: "old",
        generatedAt: "2026-04-01T00:00:00Z",
      })
    );
    cache.write(
      fakeReport({
        cacheKey: "b",
        surface: "new",
        generatedAt: "2026-04-10T00:00:00Z",
      })
    );
    const list = cache.list();
    expect(list.length).toBe(2);
    expect(list[0]?.surface).toBe("new");
    expect(list[1]?.surface).toBe("old");
  });

  it("skips malformed cache files when listing reports", () => {
    const cache = createReportCache(dir);
    cache.write(fakeReport({ cacheKey: "good", surface: "ok" }));
    writeFileSync(path.join(dir, "bad.json"), "{not json", "utf8");

    expect(cache.list().map((entry) => entry.surface)).toEqual(["ok"]);
  });

  it("isFreshFor returns true only when HEAD matches", () => {
    const cache = createReportCache(dir);
    const head = "1111111111111111111111111111111111111111";
    cache.write(fakeReport({ headSha: head }));
    const key = makeCacheKey({ surface: "src/api", since: "14d" });
    expect(cache.isFreshFor(key, head)).toBe(true);
    expect(cache.isFreshFor(key, "2222222222222222222222222222222222222222")).toBe(false);
  });
});
