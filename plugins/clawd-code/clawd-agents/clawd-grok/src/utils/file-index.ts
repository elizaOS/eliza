import { execSync } from "child_process";
import { basename, resolve } from "path";
import { findGitRoot } from "./git-root.js";

const REFRESH_TTL_MS = 30_000;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".flac",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".pyc",
  ".class",
  ".wasm",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.lastIndexOf(".");
  if (ext === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(ext).toLowerCase());
}

function collectFiles(cwd: string): string[] {
  const gitRoot = findGitRoot(cwd);
  try {
    const cmd = gitRoot
      ? "git ls-files --cached --others --exclude-standard"
      : "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -5000";
    const raw = execSync(cmd, {
      cwd: gitRoot ?? cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !isBinaryPath(l));
  } catch {
    return [];
  }
}

function scoreMatch(filePath: string, query: string): number {
  const lowerPath = filePath.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerPath.includes(lowerQuery)) return -1;

  let score = 0;
  const name = basename(filePath).toLowerCase();

  if (name === lowerQuery) score += 100;
  else if (name.startsWith(lowerQuery)) score += 60;
  else if (name.includes(lowerQuery)) score += 30;

  if (lowerPath.startsWith(lowerQuery)) score += 20;

  const idx = lowerPath.indexOf(lowerQuery);
  score -= idx * 0.1;

  score -= filePath.length * 0.05;

  return score;
}

export class FileIndex {
  private files: string[] = [];
  private cwd: string;
  private baseDir: string;
  private lastRefresh = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.baseDir = findGitRoot(cwd) ?? cwd;
  }

  async refresh(): Promise<void> {
    this.files = collectFiles(this.cwd);
    this.lastRefresh = Date.now();
  }

  updateCwd(cwd: string): void {
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      this.baseDir = findGitRoot(cwd) ?? cwd;
      this.lastRefresh = 0;
    }
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > REFRESH_TTL_MS) {
      await this.refresh();
    }
  }

  async match(query: string, maxResults = 10): Promise<string[]> {
    await this.ensureFresh();
    if (!query) return this.files.slice(0, maxResults);

    const scored: { path: string; score: number }[] = [];
    for (const f of this.files) {
      const s = scoreMatch(f, query);
      if (s >= 0) scored.push({ path: f, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.path);
  }

  get size(): number {
    return this.files.length;
  }

  resolvePath(filePath: string): string {
    return resolve(this.baseDir, filePath);
  }
}
