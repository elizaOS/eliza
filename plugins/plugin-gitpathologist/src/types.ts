/**
 * Shared types for @elizaos/plugin-gitpathologist.
 *
 * The pipeline produces a {@link PathologyReport} for a given {@link SurfaceSpec}.
 * Phases:
 *   scan      → {@link RawCommit}[]
 *   classify  → {@link ClassifiedCommit}[]
 *   score     → {@link CommitHealthPoint}[]
 *   inflect   → peaks + drifts
 *   narrate   → {@link RotCause}[]
 */

export type CommitType =
  | "feature"
  | "fix"
  | "refactor"
  | "revert"
  | "chore"
  | "wip"
  | "merge"
  | "other";

export type RotCategory =
  | "rushed-fix"
  | "scope-creep"
  | "bad-merge"
  | "revert-cycle"
  | "churn-spiral"
  | "other";

export interface SurfaceSpec {
  /** Path or glob, relative to the repo root. */
  path: string;
  /** Repository root. Defaults to runtime workspace cwd. */
  repoRoot: string;
}

export interface AnalysisOptions {
  /** ISO date or relative window (e.g. "14d", "4w"). Default "14d". */
  since: string;
  /** Maximum LLM narration calls. Default 20. */
  budget: number;
  /** Cache policy. */
  cache: "auto" | "force" | "read-only";
}

export interface FileTouch {
  path: string;
  added: number;
  deleted: number;
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";
  /** Previous path when status is R (rename) or C (copy). */
  fromPath?: string;
}

export interface RawCommit {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  files: FileTouch[];
  /** Truncated diff for narration phase. Empty when scan was metadata-only. */
  diffSnippet: string;
}

export interface ClassifiedCommit extends RawCommit {
  type: CommitType;
  scope?: string;
  riskFlags: string[];
  /** Whether classification came from rules (cheap) or the LLM (batched). */
  classifiedBy: "rule" | "llm";
}

export interface CommitHealthPoint extends ClassifiedCommit {
  /** Per-commit health delta. Negative = rot-leaning. */
  delta: number;
  /** Running exponentially-weighted moving average. */
  score: number;
  /** Total touched lines (added + deleted). */
  churn: number;
}

export interface InflectionPoint {
  sha: string;
  date: string;
  author: string;
  score: number;
  delta: number;
  reasonShort: string;
}

export interface RotCause {
  shaRange: [string, string];
  category: RotCategory;
  evidence: string[];
  narrative: string;
}

export interface PathologyReport {
  surface: string;
  repoRoot: string;
  window: { since: string; until: string };
  commitCount: number;
  authors: string[];
  timeline: CommitHealthPoint[];
  peaks: InflectionPoint[];
  drifts: InflectionPoint[];
  rotCauses: RotCause[];
  /** Counter of LLM calls made for this analysis. */
  llmCalls: number;
  /** Sha of repo HEAD at time of analysis — used for incremental cache. */
  headSha: string;
  generatedAt: string;
  cacheKey: string;
}

export type Operation = "report" | "trace" | "diff" | "list";

export interface OperationParams {
  operation: Operation;
  surface?: string;
  compareTo?: string;
  symptom?: string;
  since?: string;
  budget?: number;
  cache?: AnalysisOptions["cache"];
}

export interface CachedReportSummary {
  cacheKey: string;
  surface: string;
  generatedAt: string;
  headSha: string;
  commitCount: number;
  sizeBytes: number;
}
