/**
 * Phase 2 — classify: per-commit triage.
 *
 * Rules-first (cheap, deterministic). Anything matching a conventional commit
 * prefix or obvious revert/merge/WIP signal is classified directly. The
 * remainder are marked "other" by rules; a future LLM batching call can refine
 * those if a model is available — kept out of v1 to avoid LLM coupling here.
 * Score+inflect work fine with "other".
 */

import type { ClassifiedCommit, CommitType, RawCommit } from "../types.ts";

const PREFIX_MAP: Record<string, CommitType> = {
  feat: "feature",
  feature: "feature",
  fix: "fix",
  bug: "fix",
  hotfix: "fix",
  refactor: "refactor",
  perf: "refactor",
  revert: "revert",
  chore: "chore",
  docs: "chore",
  doc: "chore",
  style: "chore",
  test: "chore",
  ci: "chore",
  build: "chore",
};

const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i;
const WIP_RE = /^(?:wip|fixup!|squash!|amend!)\b/i;
const REVERT_SUBJECT_RE = /^Revert\b/;
const MERGE_SUBJECT_RE = /^Merge\b/;

export function classifyOne(commit: RawCommit): ClassifiedCommit {
  const subject = commit.subject.trim();
  const riskFlags: string[] = [];
  let type: CommitType = "other";
  let scope: string | undefined;

  if (commit.parents.length > 1) {
    type = "merge";
  } else if (MERGE_SUBJECT_RE.test(subject)) {
    type = "merge";
  } else if (REVERT_SUBJECT_RE.test(subject)) {
    type = "revert";
    riskFlags.push("revert-subject");
  } else if (WIP_RE.test(subject)) {
    type = "wip";
    riskFlags.push("wip-message");
  } else {
    const match = subject.match(CONVENTIONAL_RE);
    if (match) {
      const prefix = (match[1] ?? "").toLowerCase();
      const mapped = PREFIX_MAP[prefix];
      if (mapped) {
        type = mapped;
        scope = match[2];
      }
    }
  }

  const churn = commit.files.reduce((acc, f) => acc + f.added + f.deleted, 0);
  if (churn >= 500) riskFlags.push("large-churn");
  if (commit.files.length >= 20) riskFlags.push("wide-blast");
  if (subject.length < 12 && type === "other") riskFlags.push("terse-message");
  if (subject.includes("!:")) riskFlags.push("breaking");

  return {
    ...commit,
    type,
    scope,
    riskFlags,
    classifiedBy: "rule",
  };
}

export function classify(commits: RawCommit[]): ClassifiedCommit[] {
  return commits.map(classifyOne);
}
