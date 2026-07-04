/**
 * SOC2 verification runner that executes selected checks and aggregates evidence by control.
 */

import { execSync } from "node:child_process";
import { ALL_CHECKS } from "../controls/index.js";
import type {
  Check,
  CheckContext,
  EvidenceReport,
  ReportControlBlock,
  VerificationConfig,
} from "../types.js";

function git(cwd: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function selectChecks(
  checks: readonly Check[],
  include: string[] | undefined,
): readonly Check[] {
  if (!include || include.length === 0) return checks;
  return checks.filter((c) => include.some((p) => c.id.includes(p)));
}

export async function runVerification(
  cfg: VerificationConfig,
): Promise<EvidenceReport> {
  const ctx: CheckContext = {
    elizaRoot: cfg.elizaRoot,
    outerRoot: cfg.outerRoot,
  };
  const chosen = selectChecks(ALL_CHECKS, cfg.include);

  const results = await Promise.all(
    chosen.map(async (check) => {
      try {
        const out = await check.run(ctx);
        return { check, ...out };
      } catch (err) {
        return {
          check,
          status: "fail" as const,
          evidence: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );

  const controls: Record<string, ReportControlBlock> = {};
  let pass = 0,
    fail = 0,
    warn = 0,
    skip = 0;
  for (const r of results) {
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else if (r.status === "warn") warn++;
    else skip++;
    for (const tsc of r.check.tsc) {
      let block = controls[tsc];
      if (!block) {
        block = {
          checks: [],
          summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
        };
        controls[tsc] = block;
      }
      block.checks.push({
        id: r.check.id,
        title: r.check.title,
        severity: r.check.severity,
        status: r.status,
        evidence: r.evidence,
        ...(r.files ? { files: r.files } : {}),
      });
      block.summary[r.status]++;
    }
  }

  const denom = pass + fail;
  const readiness_score = denom === 0 ? 0 : pass / denom;
  const branch = git(cfg.elizaRoot, "rev-parse --abbrev-ref HEAD");
  const commit = git(cfg.elizaRoot, "rev-parse HEAD");

  return {
    generated_at: new Date().toISOString(),
    branch,
    commit,
    controls,
    overall: { pass, fail, warn, skip, readiness_score },
  };
}

export function hasCriticalFailures(report: EvidenceReport): boolean {
  for (const block of Object.values(report.controls)) {
    for (const c of block.checks) {
      if (c.severity === "critical" && c.status === "fail") return true;
    }
  }
  return false;
}
