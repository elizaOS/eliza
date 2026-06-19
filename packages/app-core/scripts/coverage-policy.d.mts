export const coverageThresholds: Readonly<{
  lines: number;
  functions: number;
  statements: number;
  branches: number;
}>;

export const coverageSummaryReporters: readonly string[];

export const coverageDocReferences: readonly string[];

export const coverageSurfaceGlobs: Readonly<Record<string, readonly string[]>>;

export function formatCompactCoverageThresholds(): string;

export function formatCoverageThresholdSentence(): string;
