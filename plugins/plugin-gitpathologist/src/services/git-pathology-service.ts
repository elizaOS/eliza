/**
 * GitPathologyService — orchestrates the gitpathologist pipeline.
 *
 * One service per agent runtime. Actions call {@link runReport}; the service
 * handles cache check, scan → classify → score → inflect → narrate, and cache
 * write. No internal background work; pure on-demand.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { createReportCache, defaultCacheDir, makeCacheKey } from "../cache/report-cache.ts";
import { classify } from "../pipeline/classify.ts";
import { findInflections } from "../pipeline/inflect.ts";
import { narrate } from "../pipeline/narrate.ts";
import { headSha as readHeadSha, resolveSurfacePath, scan } from "../pipeline/scan.ts";
import { score } from "../pipeline/score.ts";
import { scrubSecretsDeep } from "../secret-scrubber.ts";
import type {
  AnalysisOptions,
  CachedReportSummary,
  PathologyReport,
  SurfaceSpec,
} from "../types.ts";

export const GIT_PATHOLOGY_SERVICE_NAME = "git_pathology";
const LOG_PREFIX = "[GitPathologyService]";

const DEFAULT_OPTIONS: AnalysisOptions = {
  since: "14d",
  budget: 20,
  cache: "auto",
};

function defaultBudget(): number {
  const raw = process.env.GITPATHOLOGIST_BUDGET?.trim();
  if (!raw) return DEFAULT_OPTIONS.budget;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_OPTIONS.budget;
}

export class GitPathologyService extends Service {
  static serviceType: string = GIT_PATHOLOGY_SERVICE_NAME;
  capabilityDescription =
    "Forensic git-history analysis: per-surface health timeline, drift inflection detection, rot post-mortem.";

  static async start(runtime: IAgentRuntime): Promise<GitPathologyService> {
    logger.info(`${LOG_PREFIX} starting`);
    return new GitPathologyService(runtime);
  }

  async stop(): Promise<void> {
    // No background work to stop.
  }

  async runReport(
    surface: SurfaceSpec,
    overrides: Partial<AnalysisOptions> = {}
  ): Promise<PathologyReport> {
    const options = { ...DEFAULT_OPTIONS, budget: defaultBudget(), ...overrides };
    const cacheDir = defaultCacheDir(surface.repoRoot);
    const cache = createReportCache(cacheDir);
    const cacheKey = makeCacheKey({ surface: surface.path, since: options.since });
    const currentHead = readHeadSha(surface.repoRoot);

    if (options.cache !== "force") {
      const cached = cache.read(cacheKey);
      if (cached && cached.headSha === currentHead) {
        logger.info(`${LOG_PREFIX} cache hit ${cacheKey.slice(0, 12)} surface=${surface.path}`);
        return scrubSecretsDeep(cached);
      }
      if (options.cache === "read-only") {
        throw new Error(
          `gitpathology cache miss for ${surface.path} (HEAD changed or no prior report)`
        );
      }
    }

    const raw = scan(surface, { since: options.since });
    if (raw.length === 0) {
      const empty = scrubSecretsDeep(emptyReport(surface, options, currentHead, cacheKey));
      cache.write(empty);
      return empty;
    }

    const chronological = [...raw].reverse();
    const classified = classify(chronological);
    const points = score(classified);
    const { peaks, drifts } = findInflections(points);
    const { rotCauses, llmCalls } = await narrate(this.runtime ?? null, {
      surfacePath: resolveSurfacePath(surface),
      repoRoot: surface.repoRoot,
      timeline: points,
      drifts,
      budget: options.budget,
    });

    const oldest = points[0]?.date ?? new Date().toISOString();
    const newest = points[points.length - 1]?.date ?? new Date().toISOString();
    const authors = Array.from(new Set(points.map((p) => p.author))).sort();

    const report: PathologyReport = {
      surface: surface.path,
      repoRoot: surface.repoRoot,
      window: { since: oldest, until: newest },
      commitCount: points.length,
      authors,
      timeline: points,
      peaks,
      drifts,
      rotCauses,
      llmCalls,
      headSha: currentHead,
      generatedAt: new Date().toISOString(),
      cacheKey,
    };

    const safeReport = scrubSecretsDeep(report);
    cache.write(safeReport);
    logger.info(
      `${LOG_PREFIX} report written ${cacheKey.slice(0, 12)} surface=${surface.path} commits=${points.length} llm=${llmCalls}`
    );
    return safeReport;
  }

  listReports(repoRoot: string): CachedReportSummary[] {
    return createReportCache(defaultCacheDir(repoRoot)).list();
  }
}

function emptyReport(
  surface: SurfaceSpec,
  options: AnalysisOptions,
  headSha: string,
  cacheKey: string
): PathologyReport {
  const now = new Date().toISOString();
  return {
    surface: surface.path,
    repoRoot: surface.repoRoot,
    window: { since: options.since, until: now },
    commitCount: 0,
    authors: [],
    timeline: [],
    peaks: [],
    drifts: [],
    rotCauses: [],
    llmCalls: 0,
    headSha,
    generatedAt: now,
    cacheKey,
  };
}
