import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function formatCommit(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 7);
}

function resolveGitHead(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < 12; i += 1) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return path.join(gitPath, "HEAD");
      }
      if (stat.isFile()) {
        const match = fs.readFileSync(gitPath, "utf-8").match(/gitdir:\s*(.+)/i);
        if (match?.[1]) {
          return path.join(path.resolve(current, match[1].trim()), "HEAD");
        }
      }
    } catch {
      // ignore missing .git at this level
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readCommitFromPackageJson(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { gitHead?: string; githead?: string };
    return formatCommit(pkg.gitHead ?? pkg.githead);
  } catch {
    return null;
  }
}

function readCommitFromBuildInfo(): string | null {
  const req = createRequire(import.meta.url);
  for (const candidate of ["../build-info.json", "./build-info.json"]) {
    try {
      const info = req(candidate) as { commit?: string | null };
      const formatted = formatCommit(info.commit);
      if (formatted) return formatted;
    } catch {
      // ignore missing candidate
    }
  }
  return null;
}

function readCommitFromGitHead(cwd: string): string | null {
  const headPath = resolveGitHead(cwd);
  if (!headPath) return null;
  const head = fs.readFileSync(headPath, "utf-8").trim();
  if (!head) return null;
  if (head.startsWith("ref:")) {
    const ref = head.replace(/^ref:\s*/i, "").trim();
    const refPath = path.resolve(path.dirname(headPath), ref);
    return formatCommit(fs.readFileSync(refPath, "utf-8").trim());
  }
  return formatCommit(head);
}

let cachedCommit: string | null | undefined;

export function resolveCommitHash(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  if (cachedCommit !== undefined) return cachedCommit;

  const env = options.env ?? process.env;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();

  cachedCommit =
    formatCommit(envCommit) ??
    readCommitFromBuildInfo() ??
    readCommitFromPackageJson() ??
    (() => { try { return readCommitFromGitHead(options.cwd ?? process.cwd()); } catch { return null; } })();

  return cachedCommit;
}
