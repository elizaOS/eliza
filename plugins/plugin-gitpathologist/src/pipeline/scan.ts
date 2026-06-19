/**
 * Step 1 — scan: deterministic git log parsing.
 *
 * Calls `git log` once with a NUL-separated custom format and `--name-status
 * --numstat` for file-level change info. No LLM. Diff snippets are NOT
 * captured here — narrate() pulls those per-drift via `git show` to keep
 * scan cheap.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { FileTouch, RawCommit, SurfaceSpec } from "../types.ts";

const RECORD_SEP = "\x1e";
const UNIT_SEP = "\x1f";

// Format: <RS>COMMIT<US>sha<US>parents<US>author<US>email<US>date<US>subject<US>body
// Git appends `--name-status --numstat` lines AFTER the body, inside the same
// RS-delimited record. The next commit begins with its own leading RS — so we
// MUST NOT add a trailing RS here, or the file-stats become orphan records.
const LOG_FORMAT = `${[`${RECORD_SEP}COMMIT`, "%H", "%P", "%an", "%ae", "%aI", "%s"].join(
  UNIT_SEP
)}${UNIT_SEP}%b`;

export interface ScanOptions {
  since: string;
}

export function resolveSurfacePath(surface: SurfaceSpec): string {
  if (path.isAbsolute(surface.path)) {
    return path.relative(surface.repoRoot, surface.path) || ".";
  }
  return surface.path;
}

export function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // spawnSync sets `result.error` on ENOENT (git binary missing). The status
  // is null in that case — checking status alone gives an opaque error.
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString() ?? "";
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.toString();
}

export function headSha(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
}

function inferStatus(added: number, deleted: number): FileTouch["status"] {
  if (added > 0 && deleted === 0) return "A";
  if (added === 0 && deleted > 0) return "D";
  return "M";
}

function parseFileBlock(lines: string[]): FileTouch[] {
  // git log --numstat emits one line per file: "<added>\t<deleted>\t<path>".
  // For binary files, added and deleted are "-". Status (A/M/D) is inferred
  // from the counts — coarse but sufficient for the scoring formula, which
  // only consumes churn and file count, not the precise A/M/D distinction.
  const touches: FileTouch[] = [];
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...pathParts] = parts;
    const addedStr = addedRaw ?? "0";
    const deletedStr = deletedRaw ?? "0";
    const added = addedStr === "-" ? 0 : Number.parseInt(addedStr, 10);
    const deleted = deletedStr === "-" ? 0 : Number.parseInt(deletedStr, 10);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    touches.push({ path: filePath, added, deleted, status: inferStatus(added, deleted) });
  }
  return touches;
}

export function scan(surface: SurfaceSpec, options: ScanOptions): RawCommit[] {
  const surfacePath = resolveSurfacePath(surface);
  const args = [
    "log",
    "--no-color",
    `--since=${normalizeSince(options.since)}`,
    `--pretty=format:${LOG_FORMAT}`,
    "--numstat",
    "--no-renames",
    "--",
    surfacePath,
  ];
  const raw = runGit(surface.repoRoot, args);
  if (!raw.trim()) return [];

  const records = raw.split(RECORD_SEP).filter((r) => r.trim());
  const commits: RawCommit[] = [];
  for (const record of records) {
    if (!record.startsWith("COMMIT")) continue;
    const rest = record.slice("COMMIT".length);
    const fields = rest.split(UNIT_SEP);
    if (fields.length < 8) continue;
    const [, sha, parentsStr, author, authorEmail, date, subject, bodyAndFiles] = fields;
    if (!sha || !date) continue;
    const lines = (bodyAndFiles ?? "").split("\n");
    const splitIdx = findFileBlockStart(lines);
    const body = lines.slice(0, splitIdx).join("\n").trim();
    const fileLines = lines.slice(splitIdx).filter((l) => l.length > 0);
    const files = parseFileBlock(fileLines);
    commits.push({
      sha,
      parents: parentsStr ? parentsStr.split(" ").filter(Boolean) : [],
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      date,
      subject: subject ?? "",
      body,
      files,
      diffSnippet: "",
    });
  }
  return commits;
}

function findFileBlockStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    const first = line.split("\t")[0] ?? "";
    // --numstat lines start with a number (or "-" for binary).
    if (/^\d+$/.test(first) || first === "-") return i;
  }
  return lines.length;
}

const RELATIVE_SINCE = /^(\d+)\s*(d|w|m|y)$/;

export function normalizeSince(since: string): string {
  const match = since.trim().match(RELATIVE_SINCE);
  if (!match) return since;
  const n = match[1] ?? "0";
  const unit = match[2] ?? "d";
  const map: Record<string, string> = {
    d: "days",
    w: "weeks",
    m: "months",
    y: "years",
  };
  return `${n} ${map[unit] ?? "days"} ago`;
}

export function fetchDiffSnippet(
  repoRoot: string,
  sha: string,
  surfacePath: string,
  maxBytes = 16 * 1024
): string {
  const args = ["show", "--no-color", "-U2", "--format=", sha, "--", surfacePath];
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return "";
  const out = result.stdout.toString();
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n... [truncated]` : out;
}
