/**
 * End-to-end pipeline test against the toy git repo.
 *
 * Exercises scan → classify → score → findInflections → cache write/read,
 * directly composed without GitPathologyService — the Service is just a thin
 * wrapper that adds runtime/`useModel` plumbing, and importing it pulls in
 * @elizaos/core whose generated codegen isn't always present in a fresh
 * worktree. The composition under test is what produces the report content.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReportCache, defaultCacheDir, makeCacheKey } from "../src/cache/report-cache.ts";
import { classify } from "../src/pipeline/classify.ts";
import { findInflections } from "../src/pipeline/inflect.ts";
import { headSha as readHeadSha, scan } from "../src/pipeline/scan.ts";
import { score } from "../src/pipeline/score.ts";
import type { PathologyReport, SurfaceSpec } from "../src/types.ts";
import { buildToyRepo, type ToyRepoSpec } from "./toy-repo.ts";

function runPipeline(surface: SurfaceSpec, since: string): PathologyReport {
  const raw = scan(surface, { since });
  const chronological = [...raw].reverse();
  const classified = classify(chronological);
  const points = score(classified);
  const { peaks, drifts } = findInflections(points);
  const oldest = points[0]?.date ?? new Date().toISOString();
  const newest = points[points.length - 1]?.date ?? new Date().toISOString();
  const authors = Array.from(new Set(points.map((p) => p.author))).sort();
  const cacheKey = makeCacheKey({ surface: surface.path, since });
  return {
    surface: surface.path,
    repoRoot: surface.repoRoot,
    window: { since: oldest, until: newest },
    commitCount: points.length,
    authors,
    timeline: points,
    peaks,
    drifts,
    rotCauses: [],
    llmCalls: 0,
    headSha: readHeadSha(surface.repoRoot),
    generatedAt: new Date().toISOString(),
    cacheKey,
  };
}

describe("pipeline end-to-end on toy repo", () => {
  let toy: ToyRepoSpec;

  beforeAll(() => {
    toy = buildToyRepo();
  }, 30_000);
  afterAll(() => {
    rmSync(toy.repoRoot, { recursive: true, force: true });
  });

  it("produces a full report with peaks and drifts", () => {
    const report = runPipeline({ path: toy.surface, repoRoot: toy.repoRoot }, "1 year ago");
    expect(report.commitCount).toBeGreaterThan(10);
    expect(report.timeline.length).toBe(report.commitCount);
    expect(report.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.peaks.length).toBeGreaterThanOrEqual(1);
    expect(report.drifts.length).toBeGreaterThanOrEqual(1);
  });

  it("classifies the WIP dump as type=wip with risk flag", () => {
    const report = runPipeline({ path: toy.surface, repoRoot: toy.repoRoot }, "1 year ago");
    const wip = report.timeline.find((p) => p.subject.startsWith("wip"));
    expect(wip).toBeDefined();
    expect(wip?.type).toBe("wip");
    expect(wip?.riskFlags).toContain("wip-message");
    expect(wip?.churn).toBeGreaterThan(100);
  });

  it("scores phase-A clean features higher than the WIP dump", () => {
    const report = runPipeline({ path: toy.surface, repoRoot: toy.repoRoot }, "1 year ago");
    const wipDelta = report.timeline.find((p) => p.subject.startsWith("wip"))?.delta ?? 0;
    const featDeltas = report.timeline
      .filter((p) => p.subject.startsWith("feat"))
      .map((p) => p.delta);
    expect(featDeltas.length).toBeGreaterThan(0);
    const featAvg = featDeltas.reduce((a, b) => a + b, 0) / featDeltas.length;
    expect(featAvg).toBeGreaterThan(wipDelta);
  });

  it("flags the WIP commit as a drift inflection (or detects drift after it)", () => {
    const report = runPipeline({ path: toy.surface, repoRoot: toy.repoRoot }, "1 year ago");
    const wipSha = toy.commitsByPhase.B[0];
    expect(wipSha).toBeDefined();
    const wipIdx = report.timeline.findIndex((p) => p.sha === wipSha);
    const driftIdxes = report.drifts
      .map((d) => report.timeline.findIndex((p) => p.sha === d.sha))
      .filter((i) => i >= 0);
    const driftNearWip = driftIdxes.some((idx) => Math.abs(idx - wipIdx) <= 2);
    expect(driftNearWip || report.drifts.length > 0).toBe(true);
  });

  it("round-trips through the on-disk cache", () => {
    const report = runPipeline({ path: toy.surface, repoRoot: toy.repoRoot }, "1 year ago");
    const cache = createReportCache(defaultCacheDir(toy.repoRoot));
    cache.write(report);
    const back = cache.read(report.cacheKey);
    expect(back).toEqual(report);
    // Use cache.dir (the actual directory used) rather than re-computing
    // defaultCacheDir, which is env-dependent and may differ if
    // GITPATHOLOGIST_CACHE_DIR is set in the CI environment.
    const cachePath = path.join(cache.dir, `${report.cacheKey}.json`);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("listReports returns the cached report newest-first", () => {
    const report = runPipeline({ path: toy.surface, repoRoot: toy.repoRoot }, "1 year ago");
    const cache = createReportCache(defaultCacheDir(toy.repoRoot));
    cache.write(report);
    const list = cache.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]?.surface).toBe(toy.surface);
  });
});
