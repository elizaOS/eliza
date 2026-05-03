import type { CreateTaskThreadInput, TaskThreadKind } from "./task-registry.js";

const CODING_RE =
  /\b(code|coding|implement|fix|debug|refactor|write|build|patch|repo|repository|branch|commit|pull request|pr|test|tests|typescript|javascript|react|server|api)\b/i;
const RESEARCH_RE =
  /\b(research|investigate|analyze|analysis|compare|evaluate|review|study|summarize|summary|deep research|report|find out|look into|explore)\b/i;
const PLANNING_RE =
  /\b(plan|planning|roadmap|strategy|spec|prd|design|architecture|scope|milestone|breakdown|sequence|timeline)\b/i;
const OPS_RE =
  /\b(deploy|release|ship|rollback|monitor|incident|ops|operations|runbook|infra|infrastructure|configure|setup|provision|container|docker|kubernetes|ci|cd)\b/i;

function collectTaskText(input: CreateTaskThreadInput): string {
  const subtasks = Array.isArray(
    (input.currentPlan as { subtasks?: unknown } | undefined)?.subtasks,
  )
    ? (
        ((input.currentPlan as { subtasks?: unknown }).subtasks as unknown[]) ??
        []
      )
        .filter((entry): entry is string => typeof entry === "string")
        .join("\n")
    : "";
  const repo =
    typeof input.metadata?.repo === "string" ? input.metadata.repo : "";
  return [input.title, input.originalRequest, subtasks, repo]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

export function inferTaskThreadKind(
  input: CreateTaskThreadInput,
): TaskThreadKind {
  if (input.kind) return input.kind;

  const text = collectTaskText(input);
  const matches: TaskThreadKind[] = [];

  if (CODING_RE.test(text) || typeof input.metadata?.repo === "string") {
    matches.push("coding");
  }
  if (RESEARCH_RE.test(text)) {
    matches.push("research");
  }
  if (PLANNING_RE.test(text)) {
    matches.push("planning");
  }
  if (OPS_RE.test(text)) {
    matches.push("ops");
  }

  const unique = Array.from(new Set(matches));
  if (unique.length === 0) return "coding";
  if (unique.length === 1) return unique[0] ?? "coding";
  return "mixed";
}
