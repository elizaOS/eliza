export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export type CheckSeverity = "critical" | "high" | "medium" | "low";

export interface CheckResult {
  status: CheckStatus;
  evidence: string;
  files?: string[];
}

export interface Check {
  readonly id: string;
  readonly title: string;
  /** Trust Service Criteria IDs this check provides evidence for (e.g. "CC6.1", "C1.1"). */
  readonly tsc: readonly string[];
  readonly severity: CheckSeverity;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export interface CheckContext {
  /** Absolute path to the eliza monorepo root (containing packages/, .github/, etc). */
  readonly elizaRoot: string;
  /** Absolute path to the outer workspace root (the milady/ checkout) if available. */
  readonly outerRoot: string;
}

export interface VerificationConfig {
  elizaRoot: string;
  outerRoot: string;
  /** When true, the CLI returns a non-zero exit code if any critical check fails. */
  strictFail?: boolean;
  /** When set, only checks matching at least one id substring run. */
  include?: string[];
}

export interface ReportControlBlock {
  checks: Array<{
    id: string;
    title: string;
    severity: CheckSeverity;
    status: CheckStatus;
    evidence: string;
    files?: string[];
  }>;
  summary: { pass: number; fail: number; warn: number; skip: number };
}

export interface EvidenceReport {
  generated_at: string;
  branch: string;
  commit: string;
  controls: Record<string, ReportControlBlock>;
  overall: {
    pass: number;
    fail: number;
    warn: number;
    skip: number;
    readiness_score: number;
  };
}
