/**
 * Coding Workspace Service - Manages git workspaces for coding tasks
 *
 * Delegates to:
 * - workspace-github.ts  (issue management, OAuth, PAT auth)
 * - workspace-git-ops.ts (status, commit, push, PR creation)
 * - workspace-lifecycle.ts (GC, scratch dir cleanup)
 * - workspace-types.ts   (shared interface definitions)
 *
 * @module services/workspace-service
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type CreateIssueOptions,
  CredentialService,
  GitHubPatClient,
  type IssueComment,
  type IssueInfo,
  type IssueState,
  MemoryTokenStore,
  type PullRequestInfo,
  type WorkspaceConfig,
  type WorkspaceEvent,
  WorkspaceService,
} from "git-workspace-service";

import type { AuthPromptCallback } from "./workspace-github.js";
import {
  type GitHubContext,
  addComment as ghAddComment,
  addLabels as ghAddLabels,
  closeIssue as ghCloseIssue,
  createIssue as ghCreateIssue,
  getIssue as ghGetIssue,
  listComments as ghListComments,
  listIssues as ghListIssues,
  reopenIssue as ghReopenIssue,
  updateIssue as ghUpdateIssue,
} from "./workspace-github.js";

export type { AuthPromptCallback } from "./workspace-github.js";

import { readConfigEnvKey } from "./config-env.js";
import { normalizeRepositoryInput } from "./repo-input.js";
import {
  commit as gitCommit,
  createPR as gitCreatePR,
  getStatus as gitGetStatus,
  push as gitPush,
} from "./workspace-git-ops.js";
import {
  gcOrphanedWorkspaces,
  removeScratchDir,
} from "./workspace-lifecycle.js";

export type {
  CodingWorkspaceConfig,
  CommitOptions,
  PROptions,
  ProvisionWorkspaceOptions,
  PushOptions,
  WorkspaceResult,
  WorkspaceStatusResult,
} from "./workspace-types.js";

import type {
  CodingWorkspaceConfig,
  CommitOptions,
  PROptions,
  ProvisionWorkspaceOptions,
  PushOptions,
  WorkspaceResult,
  WorkspaceStatusResult,
} from "./workspace-types.js";

type WorkspaceEventCallback = (event: WorkspaceEvent) => void;
type ScratchRetentionPolicy = "ephemeral" | "pending_decision" | "persistent";
type ScratchTerminalEvent = "stopped" | "task_complete" | "error";

export interface ScratchWorkspaceRecord {
  sessionId: string;
  label: string;
  path: string;
  status: "pending_decision" | "kept" | "promoted";
  createdAt: number;
  terminalAt: number;
  terminalEvent: ScratchTerminalEvent;
  expiresAt?: number;
}

/**
 * Resolve the default branch of a remote repository via `git ls-remote
 * --symref`. Returns "main" if the lookup fails or the response can't be
 * parsed — callers that hardcoded "main" before keep working unchanged.
 *
 * Used as a fallback when the workspace caller doesn't pin a base branch.
 * Without this, repos whose default is "alpha" / "master" / "develop"
 * (e.g. elizaos-plugins/plugin-discord uses "alpha") fail at clone with
 * "fatal: Remote branch main not found in upstream origin".
 *
 * Process-lifetime cache keyed by repoUrl: concurrent and repeated lookups
 * against the same repo share one Promise so a swarm of N agents on the
 * same repo costs one ls-remote, not N. Cleared on process restart, which
 * is fine — default branches change rarely and a fresh boot rediscovers.
 */
const defaultBranchCache = new Map<string, Promise<string>>();

function lookupDefaultBranch(repoUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", "--symref", repoUrl, "HEAD"],
      { timeout: 10_000, encoding: "utf-8" },
      (err, stdout) => {
        if (err) {
          // Network failure, private repo without creds, etc.
          resolve(null);
          return;
        }
        const match = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
        resolve(match?.[1] ?? null);
      },
    );
  });
}

export function resolveDefaultBranch(repoUrl: string): Promise<string> {
  const cached = defaultBranchCache.get(repoUrl);
  if (cached) return cached;
  const pending = lookupDefaultBranch(repoUrl).then((branch) => {
    if (branch === null) {
      // Don't cache failures — a transient network blip shouldn't poison
      // subsequent calls. Drop the cache slot so a retry hits the network.
      defaultBranchCache.delete(repoUrl);
      return "main";
    }
    return branch;
  });
  defaultBranchCache.set(repoUrl, pending);
  return pending;
}

/** Test hook: drop the per-repo cache so each test starts clean. */
export function _clearDefaultBranchCache(): void {
  defaultBranchCache.clear();
}

/**
 * Resolve the default base directory for coding workspaces.
 *
 * Resolution order:
 *   1. `MILADY_WORKSPACE_DIR` runtime setting (set by store builds after the
 *      user picks a folder via the native picker — see desktopPickWorkspaceFolder).
 *   2. `MILADY_WORKSPACE_DIR` env var.
 *   3. `~/.eliza/workspaces` (direct-build default; invisible inside an OS
 *      sandbox container, hence the picker requirement for store builds).
 */
function resolveDefaultBaseDir(runtime: IAgentRuntime): string {
  const fromSetting = runtime.getSetting("MILADY_WORKSPACE_DIR");
  if (typeof fromSetting === "string" && fromSetting.trim().length > 0) {
    return expandHome(fromSetting.trim());
  }
  const fromEnv = process.env.MILADY_WORKSPACE_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return expandHome(fromEnv.trim());
  }
  return path.join(os.homedir(), ".eliza", "workspaces");
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return path.resolve(p);
}

export function getCodingWorkspaceService(
  runtime: IAgentRuntime,
): CodingWorkspaceService | null {
  const service = runtime.getService("CODING_WORKSPACE_SERVICE");
  return service instanceof CodingWorkspaceService ? service : null;
}

export class CodingWorkspaceService {
  static serviceType = "CODING_WORKSPACE_SERVICE";
  capabilityDescription = "Manages git workspaces for coding tasks";

  private runtime: IAgentRuntime;
  private workspaceService: WorkspaceService | null = null;
  private credentialService: CredentialService | null = null;
  private githubClient: GitHubPatClient | null = null;
  private githubAuthInProgress: Promise<GitHubPatClient> | null = null;
  private serviceConfig: CodingWorkspaceConfig;
  private workspaces: Map<string, WorkspaceResult> = new Map();
  private labels: Map<string, string> = new Map(); // label -> workspaceId
  private scratchBySession: Map<string, ScratchWorkspaceRecord> = new Map();
  private scratchCleanupTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private eventCallbacks: WorkspaceEventCallback[] = [];
  private authPromptCallback: AuthPromptCallback | null = null;
  /** Callback fired when a scratch workspace enters pending_decision state. */
  private scratchDecisionCallback:
    | ((record: ScratchWorkspaceRecord) => Promise<void>)
    | null = null;

  constructor(runtime: IAgentRuntime, config: CodingWorkspaceConfig = {}) {
    this.runtime = runtime;
    this.serviceConfig = {
      baseDir: config.baseDir ?? resolveDefaultBaseDir(runtime),
      branchPrefix: config.branchPrefix ?? "eliza",
      debug: config.debug ?? false,
      workspaceTtlMs: config.workspaceTtlMs ?? 24 * 60 * 60 * 1000,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<CodingWorkspaceService> {
    const config = runtime.getSetting("CODING_WORKSPACE_CONFIG") as
      | CodingWorkspaceConfig
      | null
      | undefined;
    const service = new CodingWorkspaceService(runtime, config ?? {});
    await service.initialize();
    return service;
  }

  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = getCodingWorkspaceService(runtime);
    if (service) {
      await service.stop();
    }
  }

  private async initialize(): Promise<void> {
    this.credentialService = new CredentialService({
      tokenStore: new MemoryTokenStore(),
    });

    this.workspaceService = new WorkspaceService({
      config: {
        baseDir: this.serviceConfig.baseDir as string,
        branchPrefix: this.serviceConfig.branchPrefix,
      },
      credentialService: this.credentialService,
      logger: this.serviceConfig.debug
        ? {
            info: (data: unknown, msg?: string) =>
              console.log(`[WorkspaceService] ${msg ?? ""}`, data),
            warn: (data: unknown, msg?: string) =>
              console.warn(`[WorkspaceService] ${msg ?? ""}`, data),
            error: (data: unknown, msg?: string) =>
              console.error(`[WorkspaceService] ${msg ?? ""}`, data),
            debug: (_data: unknown, msg?: string) => this.log(`${msg ?? ""}`),
          }
        : undefined,
    });

    await this.workspaceService.initialize();

    const githubToken = this.runtime.getSetting("GITHUB_TOKEN") as
      | string
      | undefined;
    if (githubToken) {
      this.githubClient = new GitHubPatClient({ token: githubToken });
      this.log("GitHubPatClient initialized with PAT");
    } else {
      this.log(
        "GITHUB_TOKEN not set - will use OAuth device flow when GitHub access is needed",
      );
    }

    this.workspaceService.onEvent((event: WorkspaceEvent) => {
      this.emitEvent(event);
    });

    this.log("CodingWorkspaceService initialized");

    // Run startup GC in background (non-blocking)
    this.gcOrphanedWorkspaces().catch((err) => {
      console.warn("[CodingWorkspaceService] Startup GC failed:", err);
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.scratchCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.scratchCleanupTimers.clear();
    for (const [id] of this.workspaces) {
      try {
        await this.removeWorkspace(id);
      } catch (err) {
        this.log(`Error cleaning up workspace ${id}: ${err}`);
      }
    }
    this.workspaces.clear();
    this.workspaceService = null;
    this.credentialService = null;
    this.githubClient = null;
    this.log("CodingWorkspaceService shutdown complete");
  }

  /** Provision a new workspace */
  async provisionWorkspace(
    options: ProvisionWorkspaceOptions,
  ): Promise<WorkspaceResult> {
    if (!this.workspaceService) {
      throw new Error("CodingWorkspaceService not initialized");
    }

    // Normalize common shorthand like owner/repo before handing it to the
    // lower-level clone service, which expects an actual remote URL.
    const repo = normalizeRepositoryInput(options.repo);
    const executionId = options.execution?.id ?? `exec-${Date.now()}`;
    const taskId = options.task?.id ?? `task-${Date.now()}`;
    const baseBranch = options.baseBranch ?? (await resolveDefaultBranch(repo));

    const workspaceConfig: WorkspaceConfig = {
      repo,
      strategy: options.useWorktree ? "worktree" : "clone",
      parentWorkspace: options.parentWorkspaceId,
      branchStrategy: "feature_branch",
      branchName: options.branchName,
      baseBranch,
      execution: {
        id: executionId,
        patternName: options.execution?.patternName ?? "eliza-coding",
      },
      task: {
        id: taskId,
        role: options.task?.role ?? "coding-agent",
        slug: options.task?.slug,
      },
      userCredentials: options.userCredentials
        ? {
            type: options.userCredentials.type,
            token: options.userCredentials.token ?? "",
            provider: "github",
          }
        : undefined,
    };

    const workspace = await this.workspaceService.provision(workspaceConfig);
    const result: WorkspaceResult = {
      id: workspace.id,
      path: workspace.path,
      branch: workspace.branch.name,
      baseBranch: workspace.branch.baseBranch,
      isWorktree: workspace.strategy === "worktree",
      repo: workspace.repo,
      status: workspace.status,
    };

    this.workspaces.set(workspace.id, result);
    this.log(`Provisioned workspace ${workspace.id}`);
    return result;
  }

  getWorkspace(id: string): WorkspaceResult | undefined {
    return this.workspaces.get(id);
  }

  listWorkspaces(): WorkspaceResult[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * Assign a semantic label to a workspace (e.g. "auth-bugfix").
   * If the label already exists, it is reassigned to the new workspace.
   */
  setLabel(workspaceId: string, label: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (workspace.label) {
      this.labels.delete(workspace.label);
    }
    const existing = this.labels.get(label);
    if (existing && existing !== workspaceId) {
      const oldWs = this.workspaces.get(existing);
      if (oldWs) oldWs.label = undefined;
    }
    workspace.label = label;
    this.labels.set(label, workspaceId);
    this.log(`Labeled workspace ${workspaceId} as "${label}"`);
  }

  getWorkspaceByLabel(label: string): WorkspaceResult | undefined {
    const id = this.labels.get(label);
    return id ? this.workspaces.get(id) : undefined;
  }

  /** Resolve a workspace by label or ID. */
  resolveWorkspace(labelOrId: string): WorkspaceResult | undefined {
    return (
      this.getWorkspaceByLabel(labelOrId) ?? this.workspaces.get(labelOrId)
    );
  }

  // === Delegated Git Operations ===

  async getStatus(workspaceId: string): Promise<WorkspaceStatusResult> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    return gitGetStatus(workspace.path);
  }

  async commit(workspaceId: string, options: CommitOptions): Promise<string> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    const hash = await gitCommit(workspace.path, options, (msg) =>
      this.log(msg),
    );
    this.log(`Committed ${hash.slice(0, 8)} in workspace ${workspaceId}`);
    return hash;
  }

  async push(workspaceId: string, options?: PushOptions): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    await gitPush(workspace.path, workspace.branch, options, (msg) =>
      this.log(msg),
    );
    this.log(`Pushed workspace ${workspaceId}`);
  }

  async createPR(
    workspaceId: string,
    options: PROptions,
  ): Promise<PullRequestInfo> {
    if (!this.workspaceService) {
      throw new Error("CodingWorkspaceService not initialized");
    }
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    return gitCreatePR(
      this.workspaceService,
      workspace,
      workspaceId,
      options,
      (msg) => this.log(msg),
    );
  }

  // === Delegated GitHub / Issue Management ===

  private getGitHubContext(): GitHubContext {
    return {
      runtime: this.runtime,
      githubClient: this.githubClient,
      setGithubClient: (client: GitHubPatClient) => {
        this.githubClient = client;
      },
      githubAuthInProgress: this.githubAuthInProgress,
      setGithubAuthInProgress: (p: Promise<GitHubPatClient> | null) => {
        this.githubAuthInProgress = p;
      },
      authPromptCallback: this.authPromptCallback,
      log: (msg: string) => this.log(msg),
    };
  }

  /** Set a callback to surface OAuth auth prompts to the user. */
  setAuthPromptCallback(callback: AuthPromptCallback): void {
    this.authPromptCallback = callback;
  }

  /**
   * Register a callback fired when a scratch workspace enters pending_decision.
   * Used to prompt the user via chat: "Want to keep this code?"
   */
  setScratchDecisionCallback(
    callback: (record: ScratchWorkspaceRecord) => Promise<void>,
  ): void {
    this.scratchDecisionCallback = callback;
  }

  async createIssue(
    repo: string,
    options: CreateIssueOptions,
  ): Promise<IssueInfo> {
    return ghCreateIssue(this.getGitHubContext(), repo, options);
  }

  async getIssue(repo: string, issueNumber: number): Promise<IssueInfo> {
    return ghGetIssue(this.getGitHubContext(), repo, issueNumber);
  }

  async listIssues(
    repo: string,
    options?: {
      state?: IssueState | "all";
      labels?: string[];
      assignee?: string;
    },
  ): Promise<IssueInfo[]> {
    return ghListIssues(this.getGitHubContext(), repo, options);
  }

  async updateIssue(
    repo: string,
    issueNumber: number,
    options: {
      title?: string;
      body?: string;
      state?: IssueState;
      labels?: string[];
      assignees?: string[];
    },
  ): Promise<IssueInfo> {
    return ghUpdateIssue(this.getGitHubContext(), repo, issueNumber, options);
  }

  async addComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment> {
    return ghAddComment(this.getGitHubContext(), repo, issueNumber, body);
  }

  async listComments(
    repo: string,
    issueNumber: number,
  ): Promise<IssueComment[]> {
    return ghListComments(this.getGitHubContext(), repo, issueNumber);
  }

  async closeIssue(repo: string, issueNumber: number): Promise<IssueInfo> {
    return ghCloseIssue(this.getGitHubContext(), repo, issueNumber);
  }

  async reopenIssue(repo: string, issueNumber: number): Promise<IssueInfo> {
    return ghReopenIssue(this.getGitHubContext(), repo, issueNumber);
  }

  async addLabels(
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    return ghAddLabels(this.getGitHubContext(), repo, issueNumber, labels);
  }

  // === Workspace Lifecycle ===

  async removeWorkspace(workspaceId: string): Promise<void> {
    if (!this.workspaceService) {
      throw new Error("CodingWorkspaceService not initialized");
    }
    await this.workspaceService.cleanup(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (workspace?.label) {
      this.labels.delete(workspace.label);
    }
    this.workspaces.delete(workspaceId);
    this.log(`Removed workspace ${workspaceId}`);
  }

  onEvent(callback: WorkspaceEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const index = this.eventCallbacks.indexOf(callback);
      if (index !== -1) {
        this.eventCallbacks.splice(index, 1);
      }
    };
  }

  private emitEvent(event: WorkspaceEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (err) {
        this.log(`Event callback error: ${err}`);
      }
    }
  }

  /** Remove a scratch directory — allowed under base dir or user coding directory. */
  async removeScratchDir(dirPath: string): Promise<void> {
    const rawCodingDir =
      (this.runtime.getSetting("PARALLAX_CODING_DIRECTORY") as string) ??
      this.readConfigEnvKey("PARALLAX_CODING_DIRECTORY") ??
      process.env.PARALLAX_CODING_DIRECTORY;
    const codingDir = rawCodingDir?.trim()
      ? rawCodingDir.trim().startsWith("~")
        ? path.join(os.homedir(), rawCodingDir.trim().slice(1))
        : path.resolve(rawCodingDir.trim())
      : undefined;
    const allowedDirs = codingDir ? [codingDir] : undefined;
    return removeScratchDir(
      dirPath,
      this.serviceConfig.baseDir as string,
      (msg) => this.log(msg),
      allowedDirs,
    );
  }

  listScratchWorkspaces(): ScratchWorkspaceRecord[] {
    return Array.from(this.scratchBySession.values()).sort(
      (a, b) => b.terminalAt - a.terminalAt,
    );
  }

  async registerScratchWorkspace(
    sessionId: string,
    dirPath: string,
    label: string,
    terminalEvent: ScratchTerminalEvent,
  ): Promise<ScratchWorkspaceRecord | null> {
    const now = Date.now();
    const existing = this.scratchBySession.get(sessionId);
    const base: ScratchWorkspaceRecord = existing ?? {
      sessionId,
      label,
      path: dirPath,
      createdAt: now,
      terminalAt: now,
      terminalEvent,
      status: "pending_decision",
    };

    const policy = this.getScratchRetentionPolicy();
    this.log(`Scratch retention policy: "${policy}" for "${label}"`);
    if (policy === "ephemeral") {
      await this.removeScratchDir(dirPath);
      this.scratchBySession.delete(sessionId);
      this.clearScratchCleanupTimer(sessionId);
      return null;
    }

    const record: ScratchWorkspaceRecord = {
      ...base,
      label,
      path: dirPath,
      terminalAt: now,
      terminalEvent,
      status: policy === "persistent" ? "kept" : "pending_decision",
      expiresAt: undefined,
    };
    this.scratchBySession.set(sessionId, record);

    if (record.status === "pending_decision") {
      const ttlMs = this.getScratchDecisionTtlMs();
      record.expiresAt = now + ttlMs;
      this.scheduleScratchCleanup(sessionId, ttlMs);
      // Prompt user via chat: "Want to keep this code?"
      if (this.scratchDecisionCallback) {
        this.log(`Firing scratch decision prompt for "${label}" at ${dirPath}`);
        this.scratchDecisionCallback(record).catch((err) => {
          console.warn(
            `[workspace] Failed to send scratch decision prompt: ${err}`,
          );
        });
      } else {
        this.log(
          `No scratch decision callback wired — skipping prompt for "${label}"`,
        );
      }
    } else {
      this.clearScratchCleanupTimer(sessionId);
    }
    return record;
  }

  async keepScratchWorkspace(
    sessionId: string,
  ): Promise<ScratchWorkspaceRecord> {
    const record = this.requireScratchWorkspace(sessionId);
    const next: ScratchWorkspaceRecord = {
      ...record,
      status: "kept",
      expiresAt: undefined,
    };
    this.scratchBySession.set(sessionId, next);
    this.clearScratchCleanupTimer(sessionId);
    return next;
  }

  async deleteScratchWorkspace(sessionId: string): Promise<void> {
    const record = this.requireScratchWorkspace(sessionId);
    await this.removeScratchDir(record.path);
    this.scratchBySession.delete(sessionId);
    this.clearScratchCleanupTimer(sessionId);
  }

  async promoteScratchWorkspace(
    sessionId: string,
    name?: string,
  ): Promise<ScratchWorkspaceRecord> {
    const record = this.requireScratchWorkspace(sessionId);
    const baseDir = this.serviceConfig.baseDir as string;
    const suggestedName = this.sanitizeWorkspaceName(name || record.label);
    const targetPath = await this.allocatePromotedPath(baseDir, suggestedName);
    try {
      await fs.rename(record.path, targetPath);
    } catch (error) {
      const isExdev =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "EXDEV";
      if (!isExdev) throw error;
      await fs.cp(record.path, targetPath, { recursive: true });
      await fs.access(targetPath);
      await fs.rm(record.path, { recursive: true, force: true });
    }

    const next: ScratchWorkspaceRecord = {
      ...record,
      path: targetPath,
      status: "promoted",
      expiresAt: undefined,
    };
    this.scratchBySession.set(sessionId, next);
    this.clearScratchCleanupTimer(sessionId);
    return next;
  }

  /** GC orphaned workspace directories older than workspaceTtlMs. */
  private async gcOrphanedWorkspaces(): Promise<void> {
    return gcOrphanedWorkspaces(
      this.serviceConfig.baseDir as string,
      this.serviceConfig.workspaceTtlMs ?? 24 * 60 * 60 * 1000,
      new Set(this.workspaces.keys()),
      (msg) => this.log(msg),
    );
  }

  private log(message: string): void {
    if (this.serviceConfig.debug) {
      console.log(`[CodingWorkspaceService] ${message}`);
    }
  }

  /** Read a key from the config file's env section (live, no restart needed). */
  private readConfigEnvKey(key: string): string | undefined {
    return readConfigEnvKey(key);
  }

  private getScratchRetentionPolicy(): ScratchRetentionPolicy {
    const setting = (this.runtime.getSetting("PARALLAX_SCRATCH_RETENTION") ??
      this.readConfigEnvKey("PARALLAX_SCRATCH_RETENTION") ??
      process.env.PARALLAX_SCRATCH_RETENTION) as string | undefined;
    const normalized = setting?.trim().toLowerCase();
    if (normalized === "ephemeral") return "ephemeral";
    if (normalized === "persistent" || normalized === "keep") {
      return "persistent";
    }
    // When a coding directory is configured and no explicit retention was set,
    // default to persistent — users don't expect named folders in ~/Projects
    // to auto-delete. If the user explicitly chose pending_decision, respect it.
    if (!normalized) {
      const codingDir =
        (this.runtime.getSetting("PARALLAX_CODING_DIRECTORY") as string) ??
        this.readConfigEnvKey("PARALLAX_CODING_DIRECTORY") ??
        process.env.PARALLAX_CODING_DIRECTORY;
      if (codingDir?.trim()) return "persistent";
    }
    return "pending_decision";
  }

  private getScratchDecisionTtlMs(): number {
    const setting = this.runtime.getSetting(
      "PARALLAX_SCRATCH_DECISION_TTL_MS",
    ) as string | number | undefined;
    const parsed = Number(
      setting ?? process.env.PARALLAX_SCRATCH_DECISION_TTL_MS,
    );
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 24 * 60 * 60 * 1000;
  }

  private requireScratchWorkspace(sessionId: string): ScratchWorkspaceRecord {
    const record = this.scratchBySession.get(sessionId);
    if (!record) {
      throw new Error(`Scratch workspace for session ${sessionId} not found`);
    }
    return record;
  }

  private clearScratchCleanupTimer(sessionId: string): void {
    const timer = this.scratchCleanupTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.scratchCleanupTimers.delete(sessionId);
    }
  }

  private scheduleScratchCleanup(sessionId: string, ttlMs: number): void {
    this.clearScratchCleanupTimer(sessionId);
    const timer = setTimeout(async () => {
      try {
        const record = this.scratchBySession.get(sessionId);
        if (!record || record.status !== "pending_decision") return;
        await this.removeScratchDir(record.path);
      } catch (error) {
        console.warn(
          `[CodingWorkspaceService] scratch cleanup failed for ${sessionId}: ${String(error)}`,
        );
      } finally {
        this.scratchBySession.delete(sessionId);
        this.scratchCleanupTimers.delete(sessionId);
      }
    }, ttlMs);
    this.scratchCleanupTimers.set(sessionId, timer);
  }

  private sanitizeWorkspaceName(raw: string): string {
    const compact = raw
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return compact || `scratch-${Date.now().toString(36)}`;
  }

  private async allocatePromotedPath(
    baseDir: string,
    baseName: string,
  ): Promise<string> {
    const baseResolved = path.resolve(baseDir);
    for (let i = 0; i < 1000; i++) {
      const candidateName = i === 0 ? baseName : `${baseName}-${i}`;
      const candidate = path.resolve(baseResolved, candidateName);
      if (
        candidate !== baseResolved &&
        !candidate.startsWith(`${baseResolved}${path.sep}`)
      ) {
        continue;
      }
      try {
        await fs.access(candidate);
      } catch {
        return candidate;
      }
    }
    throw new Error("Unable to allocate promoted workspace path");
  }
}
