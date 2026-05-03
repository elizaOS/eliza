export type WorkbenchWorkflowCategory =
  | "repo"
  | "quality"
  | "test"
  | "build"
  | "docs"
  | "plugins";

export interface WorkbenchWorkflow {
  id: string;
  title: string;
  description: string;
  category: WorkbenchWorkflowCategory;
  command: string;
  args: string[];
  mutatesRepo: boolean;
}

const DEFAULT_WORKFLOWS: readonly WorkbenchWorkflow[] = [
  {
    id: "repo_status",
    title: "Repo Status",
    description: "Show git status with branch summary.",
    category: "repo",
    command: "git",
    args: ["status", "--short", "--branch"],
    mutatesRepo: false,
  },
  {
    id: "repo_diff_stat",
    title: "Repo Diff Stat",
    description: "Show unstaged diff statistics.",
    category: "repo",
    command: "git",
    args: ["diff", "--stat"],
    mutatesRepo: false,
  },
  {
    id: "repo_diff_cached",
    title: "Repo Diff Cached",
    description: "Show staged diff statistics.",
    category: "repo",
    command: "git",
    args: ["diff", "--cached", "--stat"],
    mutatesRepo: false,
  },
  {
    id: "recent_commits",
    title: "Recent Commits",
    description: "Show recent commit history.",
    category: "repo",
    command: "git",
    args: ["log", "--oneline", "-n", "20"],
    mutatesRepo: false,
  },
  {
    id: "check",
    title: "Check",
    description: "Run project check (typecheck + lint).",
    category: "quality",
    command: "bun",
    args: ["run", "check"],
    mutatesRepo: false,
  },
  {
    id: "typecheck",
    title: "Typecheck",
    description: "Run TypeScript typecheck.",
    category: "quality",
    command: "bun",
    args: ["run", "typecheck"],
    mutatesRepo: false,
  },
  {
    id: "lint",
    title: "Lint",
    description: "Run Biome lint checks.",
    category: "quality",
    command: "bun",
    args: ["run", "lint"],
    mutatesRepo: false,
  },
  {
    id: "test_once",
    title: "Test Once",
    description: "Run Vitest suite one time.",
    category: "test",
    command: "bun",
    args: ["run", "test:once"],
    mutatesRepo: false,
  },
  {
    id: "test_e2e",
    title: "Test E2E",
    description: "Run E2E tests.",
    category: "test",
    command: "bun",
    args: ["run", "test:e2e"],
    mutatesRepo: false,
  },
  {
    id: "pre_review_local",
    title: "Pre-Review Local",
    description: "Run local pre-review parity workflow.",
    category: "quality",
    command: "bun",
    args: ["run", "pre-review:local"],
    mutatesRepo: false,
  },
  {
    id: "build_local_plugins",
    title: "Build Local Plugins",
    description: "Build local plugin packages used by this repo.",
    category: "plugins",
    command: "bun",
    args: ["run", "build:local-plugins"],
    mutatesRepo: false,
  },
  {
    id: "build",
    title: "Build",
    description: "Run full monorepo build.",
    category: "build",
    command: "bun",
    args: ["run", "build"],
    mutatesRepo: false,
  },
  {
    id: "docs_build",
    title: "Docs Build",
    description: "Validate docs build and broken links.",
    category: "docs",
    command: "bun",
    args: ["run", "docs:build"],
    mutatesRepo: false,
  },
  {
    id: "format_fix",
    title: "Format Fix",
    description: "Apply Biome formatting changes.",
    category: "quality",
    command: "bun",
    args: ["run", "format:fix"],
    mutatesRepo: true,
  },
  {
    id: "lint_fix",
    title: "Lint Fix",
    description: "Apply Biome lint autofixes.",
    category: "quality",
    command: "bun",
    args: ["run", "lint:fix"],
    mutatesRepo: true,
  },
];

export function normalizeWorkflowId(workflowId: string): string {
  return workflowId
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

export function listDefaultWorkflows(): WorkbenchWorkflow[] {
  return DEFAULT_WORKFLOWS.map((workflow) => ({
    ...workflow,
    args: [...workflow.args],
  }));
}

export function getDefaultWorkflowIds(): string[] {
  return DEFAULT_WORKFLOWS.map((workflow) => workflow.id);
}

export function findDefaultWorkflowById(
  workflowId: string,
): WorkbenchWorkflow | undefined {
  const normalized = normalizeWorkflowId(workflowId);
  return DEFAULT_WORKFLOWS.find((workflow) => workflow.id === normalized);
}
