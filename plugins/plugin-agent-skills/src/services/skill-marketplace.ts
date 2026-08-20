/**
 * Skill marketplace client: installs, uninstalls, lists, and searches skills
 * sourced from the ClawHub registry via shallow, sparse git checkouts.
 *
 * Skill names and git refs are validated against strict allow-patterns and all
 * git/dependency work runs through `execFile` (never a shell), keeping
 * untrusted registry input from escaping into command execution.
 */

import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";
import { saveScanReport, scanSkillDirectory } from "../security";
import { MAX_SKILL_PACKAGE_BYTES, skillDownloadAbortError } from "./skill-package-bytes";

const execFileAsync = promisify(execFile);

const DEFAULT_SKILLS_MARKETPLACE_URL = "https://clawhub.ai";
const VALID_NAME = /^[a-zA-Z0-9._-]+$/;
const VALID_GIT_REF = /^[a-zA-Z0-9][\w./-]*$/;
/** Timeout for git clone/sparse-checkout (shallow + sparse should be fast). */
const GIT_TIMEOUT_MS = 15_000;
/** Timeout for marketplace API fetch calls. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_MARKETPLACE_FILES = 500;

function marketplaceError(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, { code, context, cause });
}

function throwIfMarketplaceAborted(
  signal: AbortSignal | undefined,
  cause?: unknown,
): void {
  if (signal?.aborted) throw skillDownloadAbortError(signal, cause);
}

async function runMarketplaceGit(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, {
      timeout: GIT_TIMEOUT_MS,
      signal,
    });
  } catch (cause) {
    // error-policy:J2 Normalize child-process cancellation/deadlines at the
    // repository boundary while preserving ordinary git failures as causes.
    throwIfMarketplaceAborted(signal, cause);
    const processError = cause as {
      killed?: boolean;
      code?: string | number | null;
      signal?: string | null;
    };
    if (
      processError.killed === true ||
      processError.code === "ETIMEDOUT" ||
      processError.signal === "SIGTERM"
    ) {
      throw new ElizaError(
        `Skill repository operation exceeded its ${GIT_TIMEOUT_MS}ms deadline`,
        {
          code: "SKILL_DOWNLOAD_TIMEOUT",
          context: {
            boundary: "skill-marketplace-git",
            timeoutMs: GIT_TIMEOUT_MS,
          },
          cause,
          severity: "ephemeral",
        },
      );
    }
    throw cause;
  }
}

class MarketplaceMutex {
  private tail: Promise<void> = Promise.resolve();
  private users = 0;

  get idle(): boolean {
    return this.users === 0;
  }

  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const uncontended = this.users === 0;
    this.users += 1;
    const prior = this.tail.catch(() => {
      // error-policy:J5 The queued caller observes the task rejection; the
      // mutex tail only converts it into release progress for later callers.
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = prior.then(() => gate);
    try {
      if (!uncontended) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(signal?.reason);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          prior.then(resolve, reject).finally(() => {
            signal?.removeEventListener("abort", onAbort);
          });
        });
      }
      throwIfMarketplaceAborted(signal);
      return await task();
    } catch (cause) {
      // error-policy:J2 Preserve ordinary task failures while translating an
      // authoritative caller abort into the typed download boundary error.
      throwIfMarketplaceAborted(signal, cause);
      throw cause;
    } finally {
      release();
      this.users -= 1;
    }
  }
}

const marketplaceInstallMutexes = new Map<string, MarketplaceMutex>();
const marketplaceRecordsMutexes = new Map<string, MarketplaceMutex>();

async function removeMarketplaceStagingBestEffort(stagingPath: string): Promise<void> {
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
  } catch (cause) {
    // error-policy:J6 Staging cleanup follows the authoritative publication
    // decision and must not turn a committed install into a reported failure.
    logger.warn(
      `[skills-marketplace] Failed to remove staging directory ${stagingPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function withMarketplaceMutex<T>(
  mutexes: Map<string, MarketplaceMutex>,
  key: string,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  let mutex = mutexes.get(key);
  if (!mutex) {
    mutex = new MarketplaceMutex();
    mutexes.set(key, mutex);
  }
  try {
    return await mutex.run(signal, task);
  } finally {
    if (mutex.idle && mutexes.get(key) === mutex) mutexes.delete(key);
  }
}

function createIntegrationTelemetrySpan(_meta: {
  boundary: string;
  operation: string;
  timeoutMs?: number;
}) {
  return {
    success(_metadata?: Record<string, unknown>): void {},
    failure(_metadata?: Record<string, unknown>): void {},
  };
}

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

async function runSkillSecurityScan(
  skillDir: string,
  signal?: AbortSignal,
): Promise<MarketplaceScanReport> {
  throwIfMarketplaceAborted(signal);
  let report: MarketplaceScanReport;
  try {
    report = await scanSkillDirectory(skillDir, {
      signal,
      maxFileBytes: MAX_SKILL_PACKAGE_BYTES,
      maxFiles: MAX_MARKETPLACE_FILES,
    });
  } catch (cause) {
    throwIfMarketplaceAborted(signal, cause);
    throw cause;
  }
  throwIfMarketplaceAborted(signal);
  await saveScanReport(skillDir, report);
  throwIfMarketplaceAborted(signal);
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
  source: "clawhub";
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
  source: "clawhub" | "manual";
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
  source?: "clawhub" | "manual";
}

function stateDirBase(): string {
  return resolveStateDir();
}

function safeName(raw: string): string {
  const trimmed = raw.trim();
  const safeTrimmed = trimmed.length > 1024 ? trimmed.slice(0, 1024) : trimmed;
  const slug = safeTrimmed
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{1,1024}/g, "-")
    .replace(/^-{1,1024}|-{1,1024}$/g, "");
  if (!slug || !VALID_NAME.test(slug)) {
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "Invalid marketplace skill name",
    );
  }
  return slug;
}

function validateGitRef(ref: string): void {
  if (!ref || !VALID_GIT_REF.test(ref)) {
    throw marketplaceError("SKILL_MARKETPLACE_INVALID_INPUT", "Invalid git ref");
  }
}

function sanitizeSkillPath(raw: string): string {
  const trimmed = raw.trim();
  const invalidPath = (): never => {
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "Invalid marketplace skill path",
    );
  };
  if (!trimmed) invalidPath();
  if (trimmed.startsWith("~")) invalidPath();
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    invalidPath();
  }
  if (trimmed.includes("\\")) invalidPath();
  const cleaned = trimmed.replace(/^\/+/, "");
  if (!cleaned) invalidPath();
  if (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) {
    invalidPath();
  }
  if (cleaned === ".") return ".";
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) invalidPath();
  if (parts.some((p) => p === "." || p === "..")) {
    invalidPath();
  }
  return parts.join("/");
}

function assertPathWithinRoot(rootDir: string, targetPath: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target === root) return;
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw marketplaceError(
      "SKILL_MARKETPLACE_SECURITY_BLOCKED",
      "Marketplace skill path failed the safety policy",
    );
  }
}

function normalizeRepo(raw: string): string {
  const repo = raw
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^github:/i, "")
    .trim();
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "Invalid marketplace repository",
    );
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
    // error-policy:J3 An invalid external URL is rejected at the input boundary.
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "Invalid GitHub URL",
      {},
      err,
    );
  }

  if (url.hostname !== "github.com") {
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "Only github.com URLs are supported for skill install",
    );
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
      // error-policy:J3 The raw path remains subject to traversal validation.
      // Keep raw path if decode fails; still scan for traversal tokens.
    }
    if (/(^|\/)\.\.(\/|$)/.test(decoded)) {
      throw marketplaceError(
        "SKILL_MARKETPLACE_INVALID_INPUT",
        "Invalid marketplace skill path",
      );
    }
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "GitHub URL must include owner/repo",
    );
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
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Marketplace install records must be an object");
    }
    for (const [id, candidate] of Object.entries(parsed)) {
      const record = candidate as Partial<InstalledMarketplaceSkill> | null;
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        record.id !== id ||
        typeof record.name !== "string" ||
        typeof record.description !== "string" ||
        typeof record.repository !== "string" ||
        typeof record.githubUrl !== "string" ||
        typeof record.path !== "string" ||
        typeof record.installPath !== "string" ||
        typeof record.installedAt !== "string" ||
        (record.source !== "manual" && record.source !== "clawhub") ||
        (record.scanStatus !== undefined &&
          !["clean", "warning", "critical", "blocked"].includes(
            record.scanStatus,
          ))
      ) {
        throw new Error(`Marketplace install record "${id}" is malformed`);
      }
    }
    return parsed as Record<string, InstalledMarketplaceSkill>;
  } catch (err) {
    const isMissingFile =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isMissingFile) return {};
    // error-policy:J2 Install records participate in directory publication;
    // malformed state must fail closed rather than being overwritten as empty.
    throw new ElizaError("Marketplace install records are invalid", {
      code: "SKILL_MARKETPLACE_RECORDS_INVALID",
      context: {
        boundary: "skill-marketplace-records",
        workspaceDir: path.resolve(workspaceDir),
      },
      cause: err,
    });
  }
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
      // error-policy:J3 Ignore one invalid optional repository hint and inspect
      // the remaining explicit metadata candidates.
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
      // error-policy:J3 An invalid optional GitHub hint is ignored explicitly.
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

export async function searchSkillsMarketplace(
  query: string,
  opts?: { limit?: number; aiSearch?: boolean },
): Promise<SkillsMarketplaceSearchItem[]> {
  const baseUrl = resolveMarketplaceBaseUrl();
  const endpoint = "/api/v1/search";
  const url = new URL(`${baseUrl}${endpoint}`);
  if (query.trim()) url.searchParams.set("q", query.trim());
  url.searchParams.set(
    "limit",
    String(Math.max(1, Math.min(opts?.limit ?? 20, 50))),
  );

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

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
    // error-policy:J1 Translate the marketplace transport boundary into a
    // stable public request failure.
    searchSpan.failure({ error: err });
    const msg = String(err);
    throw new Error(
      msg.includes("aborted") || msg.includes("timeout")
        ? `Skills marketplace request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `Skills marketplace network error: ${msg}`,
    );
  }

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    } else if (resp.ok) {
      throw new Error("Marketplace response root is not an object");
    }
  } catch (cause) {
    // error-policy:J3 A successful malformed response cannot masquerade as an
    // empty result; an error response may still be translated from its status.
    if (resp.ok) {
      throw new ElizaError("Skills marketplace returned invalid JSON", {
        code: "SKILL_MARKETPLACE_RESPONSE_INVALID",
        context: { boundary: "skill-marketplace-search", status: resp.status },
        cause,
      });
    }
  }

  if (!resp.ok) {
    searchSpan.failure({ statusCode: resp.status, errorKind: "http_error" });
    const msg = (payload?.error as Record<string, unknown> | undefined)?.message;
    throw new Error(
      typeof msg === "string" && msg
        ? msg
        : `Skills marketplace request failed (${resp.status})`,
    );
  }

  const buckets = [payload?.results, payload?.skills, payload?.data];
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
      id: String(skill.id ?? slug),
      slug: slug || undefined,
      name,
      description,
      repository: repository || undefined,
      githubUrl,
      path: skillPath,
      tags: normalizeTags(skill.tags ?? skill.topics),
      score,
      source: "clawhub",
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
  signal?: AbortSignal,
): Promise<void> {
  throwIfMarketplaceAborted(signal);
  if (ref) validateGitRef(ref);
  if (skillPath !== ".") {
    sanitizeSkillPath(skillPath);
  }

  await withTemporarySparseCheckout(
    repository,
    ref,
    skillPath,
    async (cloneDir) => {
      throwIfMarketplaceAborted(signal);
      const sourceDir = path.join(cloneDir, skillPath);
      assertPathWithinRoot(cloneDir, sourceDir);
      const stat = await fs.stat(sourceDir).catch(() => {
        // error-policy:J3 A missing selected repository path is explicit invalid input.
        return null;
      });
      if (!stat?.isDirectory()) {
        throw marketplaceError(
          "SKILL_MARKETPLACE_INVALID_INPUT",
          "Skill path was not found in the repository",
          { repository, skillPath },
        );
      }

      await copyDirectoryWithSignal(sourceDir, targetDir, signal, {
        bytes: 0,
        files: 0,
      });
    },
    signal,
  );
}

async function copyDirectoryWithSignal(
  sourceDir: string,
  targetDir: string,
  signal?: AbortSignal,
  budget: { bytes: number; files: number } = { bytes: 0, files: 0 },
): Promise<void> {
  throwIfMarketplaceAborted(signal);
  await fs.mkdir(targetDir, { recursive: false });
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    throwIfMarketplaceAborted(signal);
    budget.files += 1;
    if (budget.files > MAX_MARKETPLACE_FILES) {
      throw marketplaceError(
        "SKILL_PACKAGE_TOO_LARGE",
        "Skill repository package exceeds the supported resource limit",
        { files: budget.files, maxFiles: MAX_MARKETPLACE_FILES },
      );
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryWithSignal(sourcePath, targetPath, signal, budget);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), targetPath);
    } else if (entry.isFile()) {
      const sourceStat = await fs.stat(sourcePath);
      budget.bytes += sourceStat.size;
      if (
        budget.bytes > MAX_SKILL_PACKAGE_BYTES
      ) {
        throw marketplaceError(
          "SKILL_PACKAGE_TOO_LARGE",
          "Skill repository package exceeds the supported resource limit",
          {
            bytes: budget.bytes,
            maxBytes: MAX_SKILL_PACKAGE_BYTES,
            files: budget.files,
            maxFiles: MAX_MARKETPLACE_FILES,
          },
        );
      }
      await fs.copyFile(sourcePath, targetPath, fsSync.constants.COPYFILE_EXCL);
    } else {
      throw marketplaceError(
        "SKILL_MARKETPLACE_SECURITY_BLOCKED",
        "Skill repository contains an unsupported entry",
        { entryName: entry.name },
      );
    }
    throwIfMarketplaceAborted(signal);
  }
}

async function resolveSkillPathInRepo(
  repository: string,
  ref: string | null,
  requestedPath: string | null,
  signal?: AbortSignal,
): Promise<string> {
  throwIfMarketplaceAborted(signal);
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
    await runMarketplaceGit(cloneArgs, signal);
    throwIfMarketplaceAborted(signal);

    const { stdout } = await runMarketplaceGit(
      ["-C", cloneDir, "ls-tree", "-r", "--name-only", "HEAD"],
      signal,
    );
    throwIfMarketplaceAborted(signal);
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

    throw marketplaceError("SKILL_MARKETPLACE_INVALID_INPUT",
      "Could not determine skill path automatically. Provide an explicit GitHub tree URL or path.",
    );
  } finally {
    await removeMarketplaceStagingBestEffort(tmpBase);
  }
}

async function withTemporarySparseCheckout<T>(
  repository: string,
  ref: string | null,
  checkoutPath: string,
  task: (cloneDir: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfMarketplaceAborted(signal);
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
    await runMarketplaceGit(cloneArgs, signal);
    throwIfMarketplaceAborted(signal);
    await runMarketplaceGit(
      ["-C", cloneDir, "sparse-checkout", "set", checkoutPath],
      signal,
    );
    throwIfMarketplaceAborted(signal);

    return await task(cloneDir);
  } finally {
    await removeMarketplaceStagingBestEffort(tmpBase);
  }
}

export async function installMarketplaceSkill(
  workspaceDir: string,
  input: InstallSkillInput,
  options: { signal?: AbortSignal } = {},
): Promise<InstalledMarketplaceSkill> {
  const signal = options.signal;
  throwIfMarketplaceAborted(signal);
  await ensureInstallDirs(workspaceDir);
  throwIfMarketplaceAborted(signal);

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
    throw marketplaceError(
      "SKILL_MARKETPLACE_INVALID_INPUT",
      "Install requires a repository or GitHub URL",
    );
  }

  const skillPath = await resolveSkillPathInRepo(
    repository,
    gitRef,
    requestedPath,
    signal,
  );
  const baseName =
    input.name?.trim() ||
    path.posix.basename(
      skillPath === "." ? repository.split("/")[1] : skillPath,
    );
  const id = safeName(baseName);
  const targetDir = path.join(installationRoot(workspaceDir), id);
  return withMarketplaceMutex(
    marketplaceInstallMutexes,
    `${path.resolve(workspaceDir)}:${id}`,
    signal,
    async () => {
      const exists = fsSync.existsSync(targetDir);
      throwIfMarketplaceAborted(signal);
      if (exists) {
        throw marketplaceError(
          "SKILL_MARKETPLACE_ALREADY_INSTALLED",
          "Marketplace skill is already installed",
          { skillId: id },
        );
      }

      const stagingRoot = await fs.mkdtemp(
        path.join(installationRoot(workspaceDir), ".install-"),
      );
      const stagedSkillDir = path.join(stagingRoot, "candidate");
      try {
        await runGitCloneSubset(
          repository,
          gitRef,
          skillPath,
          stagedSkillDir,
          signal,
        );
        throwIfMarketplaceAborted(signal);
        const skillDocumentPath = path.join(stagedSkillDir, "SKILL.md");
        const validSkill =
          fsSync.existsSync(skillDocumentPath) && fsSync.statSync(skillDocumentPath).isFile();
        throwIfMarketplaceAborted(signal);
        if (!validSkill) {
          throw marketplaceError(
            "SKILL_MARKETPLACE_INVALID_INPUT",
            "Installed path does not contain SKILL.md",
            { skillId: id },
          );
        }

        const scanReport = await runSkillSecurityScan(stagedSkillDir, signal);
        if (scanReport.status === "blocked") {
          const reasons = [
            ...scanReport.findings.map((finding) => finding.message),
            ...scanReport.manifestFindings.map((finding) => finding.message),
          ];
          throw marketplaceError(
            "SKILL_MARKETPLACE_SECURITY_BLOCKED",
            "Marketplace skill was blocked by the security policy",
            { skillId: id, findingCount: reasons.length },
          );
        }
        scanReport.skillPath = targetDir;
        await fs.writeFile(
          path.join(stagedSkillDir, ".scan-results.json"),
          JSON.stringify(scanReport, null, 2),
          "utf-8",
        );
        throwIfMarketplaceAborted(signal);

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
          scanStatus: scanReport.status,
        };

        await withMarketplaceMutex(
          marketplaceRecordsMutexes,
          path.resolve(workspaceDir),
          signal,
          async () => {
            const records = await readInstallRecords(workspaceDir);
            throwIfMarketplaceAborted(signal);
            if (records[id]) {
              throw marketplaceError(
                "SKILL_MARKETPLACE_ALREADY_INSTALLED",
                "Marketplace skill is already installed",
                { skillId: id },
              );
            }
            if (fsSync.existsSync(targetDir)) {
              throw marketplaceError(
                "SKILL_MARKETPLACE_ALREADY_INSTALLED",
                "Marketplace skill is already installed",
                { skillId: id },
              );
            }
            records[id] = record;

            const recordPath = installsRecordPath(workspaceDir);
            const recordStage = await fs.mkdtemp(
              path.join(path.dirname(recordPath), ".records-commit-"),
            );
            const nextRecordPath = path.join(recordStage, "next.json");
            const previousRecordPath = path.join(recordStage, "previous.json");
            await fs.writeFile(
              nextRecordPath,
              JSON.stringify(records, null, 2),
              "utf-8",
            );
            throwIfMarketplaceAborted(signal);
            let targetPublished = false;
            let recordPublished = false;
            let movedPreviousRecord = false;
            let preserveRecordStage = false;
            try {
              fsSync.renameSync(stagedSkillDir, targetDir);
              targetPublished = true;
              throwIfMarketplaceAborted(signal);
              if (fsSync.existsSync(recordPath)) {
                fsSync.renameSync(recordPath, previousRecordPath);
                movedPreviousRecord = true;
              }
              fsSync.renameSync(nextRecordPath, recordPath);
              recordPublished = true;
              throwIfMarketplaceAborted(signal);
            } catch (cause) {
              // error-policy:J2 Roll back both publication boundaries and
              // retain the primary commit failure, aggregating rollback loss.
              const rollbackFailures: unknown[] = [];
              try {
                if (recordPublished && fsSync.existsSync(recordPath)) {
                  fsSync.rmSync(recordPath, { force: true });
                }
                if (
                  movedPreviousRecord &&
                  fsSync.existsSync(previousRecordPath)
                ) {
                  fsSync.renameSync(previousRecordPath, recordPath);
                }
              } catch (rollbackCause) {
                // error-policy:J2 Record rollback failure is retained below.
                rollbackFailures.push(rollbackCause);
              }
              try {
                if (targetPublished && fsSync.existsSync(targetDir)) {
                  fsSync.rmSync(targetDir, { recursive: true, force: true });
                }
              } catch (rollbackCause) {
                // error-policy:J2 Directory rollback failure is retained below.
                rollbackFailures.push(rollbackCause);
              }
              if (rollbackFailures.length > 0) {
                preserveRecordStage = true;
                throw new ElizaError(
                  "Marketplace install rollback failed",
                  {
                    code: "SKILL_MARKETPLACE_ROLLBACK_FAILED",
                    context: {
                      boundary: "skill-marketplace-publication",
                      workspaceDir: path.resolve(workspaceDir),
                      skillId: id,
                    },
                    severity: "fatal",
                    cause: new AggregateError(
                      [cause, ...rollbackFailures],
                      "Marketplace install and rollback both failed",
                    ),
                  },
                );
              }
              throw cause;
            } finally {
              if (!preserveRecordStage) {
                await removeMarketplaceStagingBestEffort(recordStage);
              }
            }
          },
        );

        if (scanReport.status === "critical" || scanReport.status === "warning") {
          logger.warn(
            `[skills-marketplace] Security scan for "${id}": ${scanReport.status} ` +
              `(${scanReport.summary.critical} critical, ${scanReport.summary.warn} warnings)`,
          );
        }
        logger.info(
          `[skills-marketplace] Installed ${record.id} from ${record.repository}:${record.path} (scan: ${scanReport.status})`,
        );
        return record;
      } finally {
        await removeMarketplaceStagingBestEffort(stagingRoot);
      }
    },
  );
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
  options: { signal?: AbortSignal } = {},
): Promise<InstalledMarketplaceSkill> {
  const signal = options.signal;
  throwIfMarketplaceAborted(signal);
  const id = safeName(skillId);
  await ensureInstallDirs(workspaceDir);
  throwIfMarketplaceAborted(signal);
  const existing = await withMarketplaceMutex(
    marketplaceInstallMutexes,
    `${path.resolve(workspaceDir)}:${id}`,
    signal,
    () =>
      withMarketplaceMutex(
        marketplaceRecordsMutexes,
        path.resolve(workspaceDir),
        signal,
        async () => {
          const records = await readInstallRecords(workspaceDir);
          throwIfMarketplaceAborted(signal);
          const record = records[id];
          if (!record) {
            throw marketplaceError(
              "SKILL_MARKETPLACE_NOT_FOUND",
              "Installed marketplace skill was not found",
              { skillId: id },
            );
          }

          const expectedRoot = path.resolve(installationRoot(workspaceDir));
          const resolvedPath = path.resolve(record.installPath);
          const canonicalInstallPath = path.join(expectedRoot, id);
          if (resolvedPath !== canonicalInstallPath) {
            throw marketplaceError(
              "SKILL_MARKETPLACE_SECURITY_BLOCKED",
              "Marketplace uninstall failed the safety policy",
              { skillId: id },
            );
          }
          const workspaceRoot = path.resolve(workspaceDir);
          for (const parentPath of [
            workspaceRoot,
            path.join(workspaceRoot, "skills"),
            expectedRoot,
          ]) {
            const parentStat = await fs.lstat(parentPath);
            throwIfMarketplaceAborted(signal);
            if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
              throw marketplaceError(
                "SKILL_MARKETPLACE_SECURITY_BLOCKED",
                "Marketplace uninstall failed the safety policy",
                { skillId: id },
              );
            }
          }
          const installStat = await fs.lstat(canonicalInstallPath);
          throwIfMarketplaceAborted(signal);
          if (
            installStat.isSymbolicLink() ||
            !installStat.isDirectory() ||
            (await fs.realpath(path.dirname(canonicalInstallPath))) !==
              (await fs.realpath(expectedRoot))
          ) {
            throw marketplaceError(
              "SKILL_MARKETPLACE_SECURITY_BLOCKED",
              "Marketplace uninstall failed the safety policy",
              { skillId: id },
            );
          }

          const directoryStage = await fs.mkdtemp(
            path.join(expectedRoot, ".uninstall-"),
          );
          const retainedSkillPath = path.join(directoryStage, "previous-skill");
          const recordPath = installsRecordPath(workspaceDir);
          const recordStage = await fs.mkdtemp(
            path.join(path.dirname(recordPath), ".records-uninstall-"),
          );
          const nextRecordPath = path.join(recordStage, "next.json");
          const previousRecordPath = path.join(recordStage, "previous.json");
          delete records[id];
          let preserveDirectoryStage = false;
          let preserveRecordStage = false;
          try {
            throwIfMarketplaceAborted(signal);
            await fs.writeFile(
              nextRecordPath,
              JSON.stringify(records, null, 2),
              "utf-8",
            );
            throwIfMarketplaceAborted(signal);
            let skillMoved = false;
            let recordPublished = false;
            let priorRecordMoved = false;
            try {
              throwIfMarketplaceAborted(signal);
              fsSync.renameSync(resolvedPath, retainedSkillPath);
              skillMoved = true;
              throwIfMarketplaceAborted(signal);
              if (fsSync.existsSync(recordPath)) {
                fsSync.renameSync(recordPath, previousRecordPath);
                priorRecordMoved = true;
              }
              fsSync.renameSync(nextRecordPath, recordPath);
              recordPublished = true;
              throwIfMarketplaceAborted(signal);
            } catch (cause) {
              const rollbackFailures: unknown[] = [];
              try {
                if (recordPublished && fsSync.existsSync(recordPath)) {
                  fsSync.rmSync(recordPath, { force: true });
                }
                if (priorRecordMoved && fsSync.existsSync(previousRecordPath)) {
                  fsSync.renameSync(previousRecordPath, recordPath);
                }
              } catch (rollbackCause) {
                rollbackFailures.push(rollbackCause);
              }
              try {
                if (skillMoved && fsSync.existsSync(retainedSkillPath)) {
                  fsSync.renameSync(retainedSkillPath, resolvedPath);
                }
              } catch (rollbackCause) {
                rollbackFailures.push(rollbackCause);
              }
              if (rollbackFailures.length > 0) {
                preserveDirectoryStage = true;
                preserveRecordStage = true;
                throw new ElizaError(
                  "Marketplace uninstall rollback failed",
                  {
                    code: "SKILL_MARKETPLACE_ROLLBACK_FAILED",
                    context: {
                      boundary: "skill-marketplace-uninstall",
                      workspaceDir: path.resolve(workspaceDir),
                      skillId: id,
                    },
                    severity: "fatal",
                    cause: new AggregateError(
                      [cause, ...rollbackFailures],
                      "Uninstall and rollback both failed",
                    ),
                  },
                );
              }
              throw cause;
            }
          } finally {
            await Promise.all([
              preserveRecordStage
                ? Promise.resolve()
                : removeMarketplaceStagingBestEffort(recordStage),
              preserveDirectoryStage
                ? Promise.resolve()
                : removeMarketplaceStagingBestEffort(directoryStage),
            ]);
          }
          return record;
        },
      ),
  );

  logger.info(`[skills-marketplace] Uninstalled ${id}`);
  return existing;
}
