import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createIntegrationTelemetrySpan } from "@elizaos/agent";
import { logger } from "@elizaos/core";

const execFileAsync = promisify(execFile);

const DEFAULT_SKILLS_MARKETPLACE_URL = "https://clawhub.ai";
const LEGACY_SKILLSMP_HOST = "skillsmp.com";
const VALID_NAME = /^[a-zA-Z0-9._-]+$/;
const VALID_GIT_REF = /^[a-zA-Z0-9][\w./-]*$/;
/** Timeout for git clone/sparse-checkout (shallow + sparse should be fast). */
const GIT_TIMEOUT_MS = 15_000;
/** Timeout for marketplace API fetch calls. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Minimal scan report shape used by the marketplace installer.
 * Full type definition lives in @elizaos/plugin-agent-skills/security/types.
 */
type ScanSeverity = "info" | "warn" | "critical";

interface MarketplaceScanReport {
  scannedAt: string;
  status: "clean" | "warning" | "critical" | "blocked";
  summary: {
    scannedFiles: number;
    critical: number;
    warn: number;
    info: number;
  };
  findings: Array<{
    ruleId: string;
    severity: ScanSeverity;
    file: string;
    line: number;
    message: string;
    evidence: string;
  }>;
  manifestFindings: Array<{
    ruleId: string;
    severity: ScanSeverity;
    file: string;
    message: string;
  }>;
  skillPath: string;
}

/**
 * Run a security scan on a skill directory.
 *
 * Checks for binary files, symlink escapes, and missing SKILL.md.
 * This is a self-contained manifest check — the full content-level scan
 * (code + markdown patterns) is handled by the AgentSkillsService when
 * it loads the skill. This layer catches the most dangerous structural
 * attacks at the marketplace install boundary.
 */
async function runSkillSecurityScan(
  skillDir: string,
): Promise<MarketplaceScanReport> {
  const fsPromises = await import("node:fs/promises");
  const pathMod = await import("node:path");

  const findings: MarketplaceScanReport["findings"] = [];
  const manifestFindings: MarketplaceScanReport["manifestFindings"] = [];
  let scannedFiles = 0;

  const BINARY_EXTENSIONS = new Set([
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".wasm",
    ".bin",
    ".com",
    ".bat",
    ".cmd",
  ]);

  // Walk and check
  async function walk(dir: string): Promise<void> {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const fullPath = pathMod.join(dir, entry.name);
      const relPath = pathMod.relative(skillDir, fullPath);
      const stats = await fsPromises.lstat(fullPath);

      if (stats.isDirectory()) {
        await walk(fullPath);
      } else if (stats.isFile()) {
        scannedFiles++;
        const ext = pathMod.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          manifestFindings.push({
            ruleId: "binary-file",
            severity: "critical",
            file: relPath,
            message: `Binary executable file detected (${ext})`,
          });
        }
      } else if (stats.isSymbolicLink()) {
        const resolved = await fsPromises.realpath(fullPath).catch(() => null);
        if (!resolved?.startsWith(skillDir + pathMod.sep)) {
          manifestFindings.push({
            ruleId: "symlink-escape",
            severity: "critical",
            file: relPath,
            message: resolved
              ? "Symbolic link points outside skill directory"
              : "Symbolic link could not be resolved safely",
          });
        }
      }
    }
  }

  await walk(skillDir);

  // Check SKILL.md exists
  const skillMdPath = pathMod.join(skillDir, "SKILL.md");
  const hasSkillMd = await fsPromises
    .stat(skillMdPath)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!hasSkillMd) {
    manifestFindings.push({
      ruleId: "missing-skill-md",
      severity: "critical",
      file: "SKILL.md",
      message: "No SKILL.md file found — invalid skill package",
    });
  }

  const hasBlocking = manifestFindings.some(
    (f) =>
      f.ruleId === "binary-file" ||
      f.ruleId === "symlink-escape" ||
      f.ruleId === "missing-skill-md",
  );
  const critical = manifestFindings.filter(
    (f) => f.severity === "critical",
  ).length;
  const warn = manifestFindings.filter((f) => f.severity === "warn").length;

  let status: MarketplaceScanReport["status"] = "clean";
  if (hasBlocking) status = "blocked";
  else if (critical > 0) status = "critical";
  else if (warn > 0) status = "warning";

  const report: MarketplaceScanReport = {
    scannedAt: new Date().toISOString(),
    status,
    summary: { scannedFiles, critical, warn, info: 0 },
    findings,
    manifestFindings,
    skillPath: skillDir,
  };

  // Persist the report
  await fsPromises.writeFile(
    pathMod.join(skillDir, ".scan-results.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  return report;
}

export interface SkillsMarketplaceSearchItem {
  id: string;
  slug?: string;
  name: string;
  description: string;
  repository?: string;
  githubUrl?: string;
  path: string | null;
  tags: string[];
  score: number | null;
  source: "clawhub" | "skillsmp";
}

export interface InstalledMarketplaceSkill {
  id: string;
  name: string;
  description: string;
  repository: string;
  githubUrl: string;
  path: string;
  installPath: string;
  installedAt: string;
  source: "clawhub" | "skillsmp" | "manual";
  /** Security scan status, set after installation scan */
  scanStatus?: "clean" | "warning" | "critical" | "blocked";
}

export interface InstallSkillInput {
  slug?: string;
  githubUrl?: string;
  repository?: string;
  path?: string;
  name?: string;
  description?: string;
  source?: "clawhub" | "skillsmp" | "manual";
}

function stateDirBase(): string {
  const base = process.env.ELIZA_STATE_DIR?.trim();
  return base || path.join(os.homedir(), ".eliza");
}

function safeName(raw: string): string {
  const trimmed = raw.trim();
  const safeTrimmed = trimmed.length > 1024 ? trimmed.slice(0, 1024) : trimmed;
  const slug = safeTrimmed
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{1,1024}/g, "-")
    .replace(/^-{1,1024}|-{1,1024}$/g, "");
  if (!slug) throw new Error("Invalid skill name");
  if (!VALID_NAME.test(slug)) throw new Error(`Invalid skill name: ${raw}`);
  return slug;
}

function validateGitRef(ref: string): void {
  if (!ref || !VALID_GIT_REF.test(ref)) {
    throw new Error("Invalid git ref");
  }
}

function sanitizeSkillPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Invalid skill path");
  if (trimmed.startsWith("~")) throw new Error("Invalid skill path");
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    throw new Error("Invalid skill path");
  }
  if (trimmed.includes("\\")) throw new Error("Invalid skill path");
  const cleaned = trimmed.replace(/^\/+/, "");
  if (!cleaned) throw new Error("Invalid skill path");
  if (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) {
    throw new Error("Invalid skill path");
  }
  if (cleaned === ".") return ".";
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Invalid skill path");
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error("Invalid skill path");
  }
  return parts.join("/");
}

function assertPathWithinRoot(rootDir: string, targetPath: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target === root) return;
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Skill path escapes repository root");
  }
}

function normalizeRepo(raw: string): string {
  const repo = raw
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^github:/i, "")
    .trim();
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
    throw new Error(`Invalid repository: ${raw}`);
  }
  return repo;
}

function parseGithubUrl(rawUrl: string): {
  repository: string;
  path: string | null;
  ref: string | null;
} {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid GitHub URL: ${String(err)}`);
  }

  if (url.hostname !== "github.com") {
    throw new Error("Only github.com URLs are supported for skill install");
  }

  const treeMarker = "/tree/";
  const rawIndex = rawUrl.toLowerCase().indexOf(treeMarker);
  if (rawIndex !== -1) {
    const rawTail = rawUrl.slice(rawIndex + treeMarker.length);
    const rawPath = rawTail.split(/[?#]/)[0];
    let decoded = rawPath;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      // Keep raw path if decode fails; still scan for traversal tokens.
    }
    if (/(^|\/)\.\.(\/|$)/.test(decoded)) {
      throw new Error("Invalid skill path");
    }
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub URL must include owner/repo");
  }

  const repository = normalizeRepo(`${parts[0]}/${parts[1]}`);

  if (parts[2] === "tree" && parts.length >= 4) {
    const ref = parts[3];
    validateGitRef(ref);
    const treePath = parts.slice(4).join("/");
    const safePath = treePath ? sanitizeSkillPath(treePath) : null;
    return { repository, path: safePath, ref: ref || null };
  }

  return { repository, path: null, ref: null };
}

function installationRoot(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", ".marketplace");
}

function installsRecordPath(workspaceDir: string): string {
  return path.join(
    workspaceDir,
    "skills",
    ".cache",
    "marketplace-installs.json",
  );
}

async function ensureInstallDirs(workspaceDir: string): Promise<void> {
  await fs.mkdir(installationRoot(workspaceDir), { recursive: true });
  await fs.mkdir(path.dirname(installsRecordPath(workspaceDir)), {
    recursive: true,
  });
}

async function readInstallRecords(
  workspaceDir: string,
): Promise<Record<string, InstalledMarketplaceSkill>> {
  try {
    const raw = await fs.readFile(installsRecordPath(workspaceDir), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, InstalledMarketplaceSkill>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed;
  } catch (err) {
    const isMissingFile =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isMissingFile) {
      logger.warn(
        `[skill-marketplace] Failed to read install records: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {};
  }
}

async function writeInstallRecords(
  workspaceDir: string,
  records: Record<string, InstalledMarketplaceSkill>,
): Promise<void> {
  await ensureInstallDirs(workspaceDir);
  await fs.writeFile(
    installsRecordPath(workspaceDir),
    JSON.stringify(records, null, 2),
    "utf-8",
  );
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((t) => String(t ?? "").trim())
      .filter((t) => t.length > 0)
      .slice(0, 10);
  }
  if (raw && typeof raw === "object") {
    return Object.keys(raw as Record<string, unknown>)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 10);
  }
  return [];
}

function inferRepository(skill: Record<string, unknown>): string | null {
  const candidates = [
    skill.repository,
    skill.repo,
    skill.gitRepo,
    skill.github,
    skill.githubRepo,
    (skill.git as Record<string, unknown> | undefined)?.repo,
  ];

  for (const value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      return normalizeRepo(value);
    } catch (err) {
      logger.debug(
        `[skill-marketplace] Failed to normalize repo: ${String(err)}`,
      );
    }
  }

  // Try to extract repository from githubUrl (e.g., https://github.com/owner/repo/tree/...)
  const githubUrl = skill.githubUrl;
  if (typeof githubUrl === "string") {
    try {
      const url = new URL(githubUrl);
      if (
        url.hostname === "github.com" ||
        url.hostname.endsWith(".github.com")
      ) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return normalizeRepo(`${parts[0]}/${parts[1]}`);
        }
      }
    } catch (err) {
      logger.debug(
        `[skill-marketplace] Failed to normalize repo: ${String(err)}`,
      );
    }
  }

  return null;
}

function inferPath(skill: Record<string, unknown>): string | null {
  const candidates = [
    skill.path,
    skill.skillPath,
    skill.installPath,
    skill.directory,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const cleaned = value.replace(/^\/+/, "").trim();
    if (cleaned && !cleaned.startsWith("..") && !cleaned.includes("/.."))
      return cleaned;
  }

  // Try to extract path from githubUrl (e.g., https://github.com/owner/repo/tree/main/skills/content-marketer)
  const githubUrl = skill.githubUrl;
  if (typeof githubUrl === "string" && githubUrl.includes("/tree/")) {
    const treeIndex = githubUrl.indexOf("/tree/");
    const afterTree = githubUrl.slice(treeIndex + 6); // skip "/tree/"
    // afterTree = "main/skills/content-marketer" → skip the branch, take the rest
    const slashIndex = afterTree.indexOf("/");
    if (slashIndex !== -1) {
      const pathPart = afterTree.slice(slashIndex + 1);
      if (pathPart && !pathPart.startsWith("..") && !pathPart.includes("/.."))
        return pathPart;
    }
  }

  return null;
}

function inferName(skill: Record<string, unknown>, fallbackId: string): string {
  const candidates = [
    skill.displayName,
    skill.slug,
    skill.name,
    skill.id,
    skill.title,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const cleaned = value.trim();
    if (cleaned) return cleaned;
  }
  if (fallbackId.includes("/")) {
    return fallbackId.split("/").pop() || fallbackId;
  }
  return fallbackId;
}

function inferDescription(skill: Record<string, unknown>): string {
  const candidates = [skill.description, skill.summary, skill.shortDescription];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function resolveMarketplaceBaseUrl(): string {
  const configured =
    process.env.SKILLS_REGISTRY?.trim() ||
    process.env.CLAWHUB_REGISTRY?.trim() ||
    process.env.SKILLS_MARKETPLACE_URL?.trim();
  return configured || DEFAULT_SKILLS_MARKETPLACE_URL;
}

function isLegacySkillsmp(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === LEGACY_SKILLSMP_HOST || hostname.endsWith(".skillsmp.com")
    );
  } catch {
    return false;
  }
}

export async function searchSkillsMarketplace(
  query: string,
  opts?: { limit?: number; aiSearch?: boolean },
): Promise<SkillsMarketplaceSearchItem[]> {
  const baseUrl = resolveMarketplaceBaseUrl();
  const legacySkillsmp = isLegacySkillsmp(baseUrl);
  const endpoint = legacySkillsmp
    ? opts?.aiSearch
      ? "/api/v1/skills/ai-search"
      : "/api/v1/skills/search"
    : "/api/v1/search";
  const url = new URL(`${baseUrl}${endpoint}`);
  if (query.trim()) url.searchParams.set("q", query.trim());
  url.searchParams.set(
    "limit",
    String(Math.max(1, Math.min(opts?.limit ?? 20, 50))),
  );

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (legacySkillsmp) {
    const apiKey = process.env.SKILLSMP_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "SKILLSMP_API_KEY is not set. Add it to enable Skills marketplace search.",
      );
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const searchSpan = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation: "search_skills_marketplace",
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    searchSpan.failure({ error: err });
    const msg = String(err);
    throw new Error(
      msg.includes("aborted") || msg.includes("timeout")
        ? `Skills marketplace request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `Skills marketplace network error: ${msg}`,
    );
  }

  const payload = (await resp.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!resp.ok) {
    searchSpan.failure({ statusCode: resp.status, errorKind: "http_error" });
    const msg = (payload.error as Record<string, unknown> | undefined)?.message;
    throw new Error(
      typeof msg === "string" && msg
        ? msg
        : `Skills marketplace request failed (${resp.status})`,
    );
  }

  const buckets = [payload.results, payload.skills, payload.data];
  let list: unknown[] = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      list = bucket;
      break;
    }
    if (
      bucket &&
      typeof bucket === "object" &&
      Array.isArray((bucket as Record<string, unknown>).results)
    ) {
      list = (bucket as Record<string, unknown>).results as unknown[];
      break;
    }
    if (
      bucket &&
      typeof bucket === "object" &&
      Array.isArray((bucket as Record<string, unknown>).skills)
    ) {
      list = (bucket as Record<string, unknown>).skills as unknown[];
      break;
    }
  }

  const out: SkillsMarketplaceSearchItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const skill = entry as Record<string, unknown>;
    const slug = typeof skill.slug === "string" ? skill.slug.trim() : "";
    const repository = inferRepository(skill);
    if (!repository && !slug) continue;
    const fallbackId = repository || slug;
    const name = inferName(skill, fallbackId);
    const description = inferDescription(skill);
    const skillPath = inferPath(skill);
    const scoreValue = skill.score;
    const score =
      typeof scoreValue === "number" && Number.isFinite(scoreValue)
        ? scoreValue
        : null;
    const githubUrl =
      typeof skill.githubUrl === "string" && skill.githubUrl.trim()
        ? skill.githubUrl.trim()
        : repository
          ? `https://github.com/${repository}`
          : undefined;

    out.push({
      id: String(skill.id ?? slug ?? name),
      slug: slug || undefined,
      name,
      description,
      repository: repository || undefined,
      githubUrl,
      path: skillPath,
      tags: normalizeTags(skill.tags ?? skill.topics),
      score,
      source: legacySkillsmp ? "skillsmp" : "clawhub",
    });
  }

  searchSpan.success({ statusCode: resp.status });
  return out;
}

async function runGitCloneSubset(
  repository: string,
  ref: string | null,
  skillPath: string,
  targetDir: string,
): Promise<void> {
  if (ref) validateGitRef(ref);
  if (skillPath !== ".") {
    sanitizeSkillPath(skillPath);
  }

  await withTemporarySparseCheckout(
    repository,
    ref,
    skillPath,
    async (cloneDir) => {
      const sourceDir = path.join(cloneDir, skillPath);
      assertPathWithinRoot(cloneDir, sourceDir);
      const stat = await fs.stat(sourceDir).catch(() => null);
      if (!stat?.isDirectory()) {
        throw new Error(`Skill path not found in repository: ${skillPath}`);
      }

      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.cp(sourceDir, targetDir, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    },
  );
}

async function resolveSkillPathInRepo(
  repository: string,
  ref: string | null,
  requestedPath: string | null,
): Promise<string> {
  if (ref) validateGitRef(ref);
  if (requestedPath) return sanitizeSkillPath(requestedPath);

  // Use --no-checkout + git ls-tree to discover SKILL.md without relying on
  // sparse-checkout cone mode, which only fetches root-level files when
  // checkoutPath="." and silently omits skills/ subdirectories.
  const repoUrl = `https://github.com/${repository}.git`;
  const tmpBase = await fs.mkdtemp(path.join(stateDirBase(), "skill-probe-"));
  const cloneDir = path.join(tmpBase, "repo");
  try {
    const cloneArgs = [
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--no-checkout",
      ...(ref ? ["--branch", ref] : []),
      repoUrl,
      cloneDir,
    ];
    await execFileAsync("git", cloneArgs, { timeout: GIT_TIMEOUT_MS });

    const { stdout } = await execFileAsync(
      "git",
      ["-C", cloneDir, "ls-tree", "-r", "--name-only", "HEAD"],
      { timeout: GIT_TIMEOUT_MS },
    );
    const allPaths = stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);

    if (allPaths.includes("SKILL.md")) return ".";

    for (const filePath of allPaths) {
      const parts = filePath.split("/");
      if (
        parts.length === 3 &&
        parts[0] === "skills" &&
        parts[2] === "SKILL.md"
      ) {
        return sanitizeSkillPath(`${parts[0]}/${parts[1]}`);
      }
    }

    throw new Error(
      "Could not determine skill path automatically. Provide an explicit GitHub tree URL or path.",
    );
  } finally {
    await fs
      .rm(tmpBase, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

async function withTemporarySparseCheckout<T>(
  repository: string,
  ref: string | null,
  checkoutPath: string,
  task: (cloneDir: string) => Promise<T>,
): Promise<T> {
  const repoUrl = `https://github.com/${repository}.git`;
  const tmpBase = await fs.mkdtemp(path.join(stateDirBase(), "skill-probe-"));
  const cloneDir = path.join(tmpBase, "repo");

  try {
    const cloneArgs = [
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      ...(ref ? ["--branch", ref] : []),
      repoUrl,
      cloneDir,
    ];
    await execFileAsync("git", cloneArgs, { timeout: GIT_TIMEOUT_MS });
    await execFileAsync(
      "git",
      ["-C", cloneDir, "sparse-checkout", "set", checkoutPath],
      { timeout: GIT_TIMEOUT_MS },
    );

    return await task(cloneDir);
  } finally {
    await fs
      .rm(tmpBase, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

export async function installMarketplaceSkill(
  workspaceDir: string,
  input: InstallSkillInput,
): Promise<InstalledMarketplaceSkill> {
  await ensureInstallDirs(workspaceDir);

  let repository = input.repository?.trim()
    ? normalizeRepo(input.repository)
    : null;
  let requestedPath = input.path?.trim() ? sanitizeSkillPath(input.path) : null;
  let gitRef: string | null = null;

  if (input.githubUrl?.trim()) {
    const parsed = parseGithubUrl(input.githubUrl.trim());
    repository = parsed.repository;
    if (!requestedPath && parsed.path) requestedPath = parsed.path;
    if (parsed.ref) gitRef = parsed.ref;
  }

  if (!repository) {
    throw new Error("Install requires a repository or GitHub URL");
  }

  const skillPath = await resolveSkillPathInRepo(
    repository,
    gitRef,
    requestedPath,
  );
  const baseName =
    input.name?.trim() ||
    path.posix.basename(
      skillPath === "." ? repository.split("/")[1] : skillPath,
    );
  const id = safeName(baseName);
  const targetDir = path.join(installationRoot(workspaceDir), id);

  const exists = await fs
    .stat(targetDir)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(`Skill "${id}" is already installed`);
  }

  await runGitCloneSubset(repository, gitRef, skillPath, targetDir);

  const skillDoc = path.join(targetDir, "SKILL.md");
  const validSkill = await fs
    .stat(skillDoc)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!validSkill) {
    await fs
      .rm(targetDir, { recursive: true, force: true })
      .catch(() => undefined);
    throw new Error("Installed path does not contain SKILL.md");
  }

  // ── Security scan ─────────────────────────────────────────
  // Scan the skill directory for dangerous patterns before making it available.
  // Blocked skills are removed and an error is thrown.
  const scanReport = await runSkillSecurityScan(targetDir);
  const scanStatus = scanReport.status;

  if (scanReport.status === "blocked") {
    await fs
      .rm(targetDir, { recursive: true, force: true })
      .catch(() => undefined);
    const reasons = [
      ...scanReport.findings.map((f: { message: string }) => f.message),
      ...scanReport.manifestFindings.map((f: { message: string }) => f.message),
    ];
    throw new Error(
      `Skill "${id}" blocked by security scan: ${reasons.join("; ")}`,
    );
  }

  if (scanReport.status === "critical" || scanReport.status === "warning") {
    logger.warn(
      `[skills-marketplace] Security scan for "${id}": ${scanReport.status} ` +
        `(${scanReport.summary.critical} critical, ${scanReport.summary.warn} warnings)`,
    );
  }

  const record: InstalledMarketplaceSkill = {
    id,
    name: input.name?.trim() || id,
    description: input.description?.trim() || "",
    repository,
    githubUrl: `https://github.com/${repository}`,
    path: skillPath,
    installPath: targetDir,
    installedAt: new Date().toISOString(),
    source: input.source ?? "manual",
    scanStatus,
  };

  const records = await readInstallRecords(workspaceDir);
  records[id] = record;
  await writeInstallRecords(workspaceDir, records);

  logger.info(
    `[skills-marketplace] Installed ${record.id} from ${record.repository}:${record.path} (scan: ${scanStatus ?? "skipped"})`,
  );
  return record;
}

export async function listInstalledMarketplaceSkills(
  workspaceDir: string,
): Promise<InstalledMarketplaceSkill[]> {
  const records = await readInstallRecords(workspaceDir);
  const values = Object.values(records);
  values.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
  return values;
}

export async function uninstallMarketplaceSkill(
  workspaceDir: string,
  skillId: string,
): Promise<InstalledMarketplaceSkill> {
  const id = safeName(skillId);
  const records = await readInstallRecords(workspaceDir);
  const existing = records[id];
  if (!existing) {
    throw new Error(`Installed marketplace skill "${id}" not found`);
  }

  // Security: ensure installPath is within the expected marketplace directory
  const expectedRoot = path.resolve(installationRoot(workspaceDir));
  const resolvedPath = path.resolve(existing.installPath);
  if (
    !resolvedPath.startsWith(`${expectedRoot}${path.sep}`) ||
    resolvedPath === expectedRoot
  ) {
    throw new Error(`Refusing to remove skill outside ${expectedRoot}`);
  }

  await fs.rm(existing.installPath, { recursive: true, force: true });
  delete records[id];
  await writeInstallRecords(workspaceDir, records);

  logger.info(`[skills-marketplace] Uninstalled ${id}`);
  return existing;
}
