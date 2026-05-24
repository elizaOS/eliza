#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const STEPS = [
  {
    id: "mirror-runs",
    script: "packages/scripts/mirror-benchmark-run-artifacts.mjs",
    description: "Mirror benchmark run folders into ignored reports/.",
  },
  {
    id: "trajectory-catalog",
    script: "packages/scripts/build-benchmark-trajectory-catalog.mjs",
    description: "Parse mirrored benchmark trajectories for call/cache review.",
  },
  {
    id: "trajectory-io-completeness",
    script: "packages/scripts/build-benchmark-trajectory-io-completeness.mjs",
    description: "Classify trajectory input/output pane completeness by benchmark.",
  },
  {
    id: "version-comparison",
    script: "packages/scripts/build-benchmark-version-comparison.mjs",
    description: "Build latest-vs-previous benchmark comparison viewer.",
  },
  {
    id: "gap-evidence",
    script: "packages/scripts/build-benchmark-gap-evidence.mjs",
    description: "Probe OSWorld prerequisites and expanded local benchmark slices.",
  },
  {
    id: "benchmark-review",
    script: "packages/scripts/build-benchmark-review-analysis.mjs",
    description: "Summarize one row per latest benchmark.",
  },
  {
    id: "benchmark-examples",
    script: "packages/scripts/build-benchmark-examples-manifest.mjs",
    description: "Index per-benchmark five-example evidence and task IDs.",
  },
  {
    id: "benchmark-five-example-sampler",
    script: "packages/scripts/build-benchmark-five-example-sampler.mjs",
    description: "Select five playback-linked examples per latest benchmark.",
  },
  {
    id: "benchmark-sample-review-matrix",
    script: "packages/scripts/build-benchmark-sample-review-matrix.mjs",
    description: "Classify the selected benchmark examples for sample-level review readiness.",
  },
  {
    id: "benchmark-results-corpus",
    script: "packages/scripts/build-benchmark-results-corpus-review.mjs",
    description: "Summarize packages/benchmarks/benchmark_results with SQLite trajectory evidence.",
  },
  {
    id: "corpus-remediation-matrix",
    script: "packages/scripts/build-corpus-remediation-matrix.mjs",
    description: "Build focused remediation matrix for broader corpus warnings and telemetry gaps.",
  },
  {
    id: "corpus-review-packs",
    script: "packages/scripts/build-corpus-review-packs.mjs",
    description: "Build one review pack page per broader benchmark corpus family with telemetry, playback, warnings, and manual-note links.",
  },
  {
    id: "agent-benchmark-review",
    script: "packages/scripts/build-benchmark-agent-benchmark-review.mjs",
    description: "Create first-pass agent review verdicts for every benchmark surface.",
  },
  {
    id: "benchmark-closure-matrix",
    script: "packages/scripts/build-benchmark-closure-matrix.mjs",
    description: "Join per-benchmark review, sampler, trajectory, version, and agent verdict evidence.",
  },
  {
    id: "benchmark-version-remediation-matrix",
    script: "packages/scripts/build-benchmark-version-remediation-matrix.mjs",
    description: "Build per-benchmark version-history gap and rerun matrix.",
  },
  {
    id: "benchmark-outcome-analysis",
    script: "packages/scripts/build-benchmark-outcome-analysis.mjs",
    description: "Join benchmark success, cache, playback, version, and next-action evidence.",
  },
  {
    id: "scenario-execution-union",
    script: "packages/scripts/build-scenario-execution-union.mjs",
    args: ["--json"],
    description: "Regenerate per-scenario execution coverage and findings.",
  },
  {
    id: "scenario-failure-analysis",
    script: "packages/scripts/build-scenario-failure-analysis.mjs",
    args: ["--json"],
    description: "Cluster failed scenario attempts for triage.",
  },
  {
    id: "scenario-agent-review",
    script: "packages/scripts/build-scenario-agent-review.mjs",
    description: "Create first-pass agent review verdicts for every cataloged scenario.",
  },
  {
    id: "scenario-outcome-matrix",
    script: "packages/scripts/build-scenario-outcome-matrix.mjs",
    description: "Join scenario execution, playback, verdict, category, and remediation evidence.",
  },
  {
    id: "scenario-remediation-matrix",
    script: "packages/scripts/build-scenario-remediation-matrix.mjs",
    description: "Build per-scenario remediation matrix for non-passing scenarios.",
  },
  {
    id: "scenario-review-packs",
    script: "packages/scripts/build-scenario-review-packs.mjs",
    description: "Build one review pack page per scenario with playback, outcome, failure details, rerun commands, and manual-note links.",
  },
  {
    id: "live-test-playback",
    script: "packages/scripts/build-live-test-run-playback.mjs",
    description: "Build call/event playback pages for wrapped live/e2e test runs.",
  },
  {
    id: "live-test-inventory",
    script: "packages/scripts/check-live-test-artifact-coverage.mjs",
    args: ["--json"],
    description: "Inventory live/real/e2e model-call artifact evidence.",
  },
  {
    id: "live-test-failure-triage",
    script: "packages/scripts/build-live-test-failure-triage.mjs",
    description: "Classify failed live/e2e wrapper runs with excerpts and rerun commands.",
  },
  {
    id: "live-test-model-evidence",
    script: "packages/scripts/build-live-test-model-evidence-matrix.mjs",
    description: "Join evidence, playback, structured status, failures, and rerun commands for likely-LLM scripts.",
  },
  {
    id: "live-test-prompt-response-completeness",
    script: "packages/scripts/build-live-test-prompt-response-completeness.mjs",
    description: "Summarize live/e2e structured prompt/response sidecar completeness.",
  },
  {
    id: "live-test-review-packs",
    script: "packages/scripts/build-live-test-review-packs.mjs",
    description: "Build one review pack page per likely-LLM live/e2e script with playback, prompt/response status, failures, and rerun commands.",
  },
  {
    id: "cache-analysis",
    script: "packages/scripts/build-benchmark-cache-analysis.mjs",
    description: "Summarize token/cache-hit evidence across benchmark telemetry surfaces.",
  },
  {
    id: "live-test-agent-review",
    script: "packages/scripts/build-live-test-agent-review.mjs",
    description: "Create first-pass agent review verdicts for every live/real/e2e script.",
  },
  {
    id: "goal-audit",
    script: "packages/scripts/build-benchmark-goal-audit.mjs",
    description: "Regenerate requirement-level completion audit.",
  },
  {
    id: "review-queue",
    script: "packages/scripts/build-benchmark-review-queue.mjs",
    description: "Build consolidated manual-review queue across benchmarks, scenarios, and live/e2e tests.",
  },
  {
    id: "manual-review-workspace",
    script: "packages/scripts/build-benchmark-manual-review-workspace.mjs",
    description: "Create durable per-item manual-review note stubs for the review queue.",
  },
  {
    id: "benchmark-review-packs",
    script: "packages/scripts/build-benchmark-review-packs.mjs",
    description: "Build one review pack page per code-agent benchmark with outcome, cache, samples, versions, and manual-note links.",
  },
  {
    id: "review-pack-index",
    script: "packages/scripts/build-review-pack-index.mjs",
    description: "Build a single review cockpit over benchmark, corpus, scenario, and live/e2e review packs.",
  },
  {
    id: "review-pack-agent-verdicts",
    script: "packages/scripts/build-review-pack-agent-verdicts.mjs",
    description: "Create agent verdicts for every benchmark, corpus, scenario, and live/e2e review pack row.",
  },
  {
    id: "rerun-command-catalog",
    script: "packages/scripts/build-rerun-command-catalog.mjs",
    description: "Catalog every benchmark, corpus, scenario, and live/e2e rerun command with blockers and follow-up rebuild guidance.",
  },
  {
    id: "rerun-batches",
    script: "packages/scripts/build-rerun-batch-scripts.mjs",
    description: "Generate executable batch scripts for runnable benchmark, corpus, scenario, and live/e2e rerun commands.",
  },
  {
    id: "manual-review-progress",
    script: "packages/scripts/build-manual-review-progress-board.mjs",
    description: "Join durable manual-review notes to pack, playback, gap, and rerun evidence for progress tracking.",
  },
  {
    id: "agent-review-digest",
    script: "packages/scripts/build-benchmark-agent-review-digest.mjs",
    description: "Create first-pass agent triage for high-priority review items.",
  },
  {
    id: "remediation-matrix",
    script: "packages/scripts/build-benchmark-remediation-matrix.mjs",
    description: "Build sorted remaining-work and rerun-command matrix.",
  },
  {
    id: "analysis-summary",
    script: "packages/scripts/build-benchmark-analysis-summary.mjs",
    description: "Build cross-surface analysis summary and triage entry point.",
  },
  {
    id: "global-playback-index",
    script: "packages/scripts/build-global-playback-index.mjs",
    description: "Build a single playback index across benchmark, scenario, and live/e2e surfaces.",
  },
  {
    id: "artifact-manifest",
    script: "packages/scripts/build-benchmark-artifact-manifest.mjs",
    description: "Index generated ignored report artifacts for manual review.",
  },
  {
    id: "run-contract",
    script: "packages/scripts/build-benchmark-run-contract.mjs",
    description: "Verify ignored storage, viewer entrypoints, playback coverage, and version support contract.",
  },
  {
    id: "objective-evidence-map",
    script: "packages/scripts/build-benchmark-objective-evidence-map.mjs",
    description: "Build requirement-by-requirement evidence map for the full benchmark-analysis objective.",
  },
  {
    id: "review-readiness-ledger",
    script: "packages/scripts/build-benchmark-review-readiness-ledger.mjs",
    description: "Build surface-by-surface reviewer affordance checklist for playback, I/O, cache, outcomes, versions, reruns, and notes.",
  },
  {
    id: "objective-closure",
    script: "packages/scripts/build-benchmark-objective-closure-report.mjs",
    description: "Build strict objective closure-readiness report.",
  },
  {
    id: "final-goal-readiness",
    script: "packages/scripts/build-final-goal-readiness-gate.mjs",
    description: "Build final objective readiness gate from current proof, caveat, blocker, and human-review evidence.",
  },
  {
    id: "runbook",
    script: "packages/scripts/build-benchmark-analysis-runbook.mjs",
    description: "Build rerun and manual-review runbook for the generated analysis stack.",
  },
  {
    id: "hub",
    script: "packages/scripts/build-benchmark-analysis-hub.mjs",
    description: "Regenerate unified benchmark analysis hub.",
  },
  {
    id: "artifact-manifest-final",
    script: "packages/scripts/build-benchmark-artifact-manifest.mjs",
    description: "Refresh generated artifact manifest after run-contract, runbook, and hub output.",
  },
  {
    id: "verify",
    script: "packages/scripts/verify-benchmark-analysis-reports.mjs",
    description: "Verify generated report invariants and known caveats.",
  },
];

function runStep(step) {
  process.stdout.write(`\n[benchmark-analysis] ${step.id}: ${step.description}\n`);
  const completed = spawnSync(
    process.execPath,
    [step.script, ...(step.args || [])],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  if (completed.status !== 0) {
    throw new Error(`${step.id} failed with exit ${completed.status}`);
  }
}

function main() {
  for (const step of STEPS) {
    runStep(step);
  }
  process.stdout.write(
    "\n[benchmark-analysis] complete: reports/benchmark-analysis/index.html\n",
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
