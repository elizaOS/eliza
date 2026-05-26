/**
 * Build a synthetic git repository with a planted health trajectory:
 *   phase A (5 commits) — clean feature work, low churn, conventional messages
 *   phase B (1 commit)  — WIP dump with huge churn → drift inflection
 *   phase C (4 commits) — churn-spiral: quick reverts and patches
 *   phase D (4 commits) — recovery: refactor + tests
 *
 * Each test that needs a repo calls `buildToyRepo()` and gets back a unique
 * temp dir. Caller is responsible for cleanup (rmSync recursive).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function git(repoRoot: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: repoRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Toy",
      GIT_AUTHOR_EMAIL: "toy@example.test",
      GIT_COMMITTER_NAME: "Toy",
      GIT_COMMITTER_EMAIL: "toy@example.test",
    },
  });
}

function commit(repoRoot: string, message: string, dateIso: string): void {
  execFileSync("git", ["commit", "-m", message, `--date=${dateIso}`], {
    cwd: repoRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Toy",
      GIT_AUTHOR_EMAIL: "toy@example.test",
      GIT_COMMITTER_NAME: "Toy",
      GIT_COMMITTER_EMAIL: "toy@example.test",
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
    },
  });
}

function writeFile(repoRoot: string, rel: string, content: string): void {
  const full = path.join(repoRoot, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function smallFeatureLines(seed: number): string {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push(`// line ${seed}-${i} small change`);
  return lines.join("\n");
}

function biggerLines(seed: number, n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`/* seed=${seed} bulk ${i} */`);
  return lines.join("\n");
}

const SURFACE_DIR = "src";

export interface ToyRepoSpec {
  repoRoot: string;
  surface: string;
  commitsByPhase: { A: string[]; B: string[]; C: string[]; D: string[] };
}

export function buildToyRepo(): ToyRepoSpec {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "gitpath-toy-"));
  git(repoRoot, ["init", "-q", "--initial-branch=main"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);

  const commitsByPhase = { A: [] as string[], B: [] as string[], C: [] as string[], D: [] as string[] };

  // Anchor (untracked surface starts empty)
  writeFile(repoRoot, "README", "toy repo\n");
  git(repoRoot, ["add", "README"]);
  commit(repoRoot, "chore: bootstrap toy repo", "2026-04-01T10:00:00Z");

  // Phase A — clean feature work
  const aSubjects = [
    "feat(api): add request validator",
    "feat(api): add response shaper",
    "fix(api): handle empty payload",
    "refactor(api): extract helper",
    "feat(api): paginate list endpoint",
  ];
  for (let i = 0; i < aSubjects.length; i++) {
    writeFile(repoRoot, `${SURFACE_DIR}/feature-${i}.ts`, smallFeatureLines(i));
    git(repoRoot, ["add", `${SURFACE_DIR}/feature-${i}.ts`]);
    commit(repoRoot, aSubjects[i] ?? `feat: a${i}`, `2026-04-${String(2 + i).padStart(2, "0")}T10:00:00Z`);
    commitsByPhase.A.push(readHead(repoRoot));
  }

  // Phase B — single WIP dump with huge churn (drift inflection)
  for (let f = 0; f < 8; f++) {
    writeFile(repoRoot, `${SURFACE_DIR}/dump-${f}.ts`, biggerLines(f, 80));
  }
  writeFile(repoRoot, `${SURFACE_DIR}/feature-0.ts`, biggerLines(99, 60));
  git(repoRoot, ["add", `${SURFACE_DIR}/`]);
  commit(repoRoot, "wip: huge dump, will clean up later", "2026-04-09T10:00:00Z");
  commitsByPhase.B.push(readHead(repoRoot));

  // Phase C — churn spiral (reverts + tweaks)
  const cSubjects = [
    "fix: revert part of dump",
    "fix: another patch",
    "wip: still fighting fires",
    "fix: more tweaks",
  ];
  for (let i = 0; i < cSubjects.length; i++) {
    for (let f = 0; f < 3; f++) {
      writeFile(repoRoot, `${SURFACE_DIR}/dump-${f}.ts`, biggerLines(i * 10 + f, 50 + i * 10));
    }
    git(repoRoot, ["add", `${SURFACE_DIR}/`]);
    commit(repoRoot, cSubjects[i] ?? `wip: c${i}`, `2026-04-${String(10 + i).padStart(2, "0")}T10:00:00Z`);
    commitsByPhase.C.push(readHead(repoRoot));
  }

  // Phase D — recovery: refactor + tests
  const dSubjects = [
    "refactor(api): collapse duplicate logic",
    "test(api): cover validator branches",
    "refactor(api): extract pure helpers",
    "test(api): add edge-case suite",
  ];
  for (let i = 0; i < dSubjects.length; i++) {
    writeFile(repoRoot, `${SURFACE_DIR}/clean-${i}.ts`, smallFeatureLines(100 + i));
    writeFile(repoRoot, `${SURFACE_DIR}/__tests__/clean-${i}.test.ts`, smallFeatureLines(200 + i));
    git(repoRoot, ["add", `${SURFACE_DIR}/`]);
    commit(repoRoot, dSubjects[i] ?? `refactor: d${i}`, `2026-04-${String(15 + i).padStart(2, "0")}T10:00:00Z`);
    commitsByPhase.D.push(readHead(repoRoot));
  }

  return { repoRoot, surface: SURFACE_DIR, commitsByPhase };
}

function readHead(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
    .toString()
    .trim();
}
