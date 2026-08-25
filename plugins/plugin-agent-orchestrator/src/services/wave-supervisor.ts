/**
 * Wave-level lifecycle supervision for orchestrator lane tasks (#16443 W3).
 *
 * A wave is a set of durable tasks carrying the same wave id in task metadata.
 * This service deliberately owns no store: it reads and updates tasks through
 * OrchestratorTaskService, and exposes a compact snapshot to ACTIVE_SUB_AGENTS.
 * The default-OFF gate makes registration behavior-neutral until explicitly
 * enabled.
 */

import { spawnSync } from "node:child_process";
import type {
  Content,
  IAgentRuntime,
  SendHandlerResult,
  Service as ServiceType,
  UUID,
} from "@elizaos/core";
import {
  ElizaError,
  logger,
  requireConfirmedSendHandlerDelivery,
  Service,
} from "@elizaos/core";
import type { TaskThreadDetailDto } from "./orchestrator-task-mapper.js";
import type { CreateTaskInput } from "./orchestrator-task-types.js";
import { parseOwnerRepo } from "./workspace-github.js";
import { preserveRegisteredWorkspace } from "./workspace-lifecycle.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

export const WAVE_SUPERVISOR_SERVICE_TYPE = "ORCHESTRATOR_WAVE_SUPERVISOR";
export const WAVE_SUPERVISOR_SETTING = "ELIZA_ORCHESTRATOR_WAVE_SUPERVISOR";
export const WAVE_ID_METADATA_KEY = "waveId";
export const WAVE_REFILL_PLANNER_SERVICE_TYPE = "ORCHESTRATOR_LANE_PLANNER";
export const WAVE_BUDGET_BREACH_CODE = "ORCHESTRATOR_WAVE_BUDGET_BREACH";

export class WaveConcurrencyCapError extends Error {
  constructor(
    readonly waveId: string,
    readonly cap: number,
  ) {
    super(`wave ${waveId} concurrency cap reached (${cap})`);
    this.name = "WaveConcurrencyCapError";
  }
}

export class WaveBudgetBreachError extends ElizaError {
  constructor(
    readonly waveId: string,
    readonly reason: string,
    context: Record<string, unknown>,
  ) {
    super(`wave ${waveId} budget breached: ${reason}`, {
      code: WAVE_BUDGET_BREACH_CODE,
      context: { waveId, reason, ...context },
      severity: "fatal",
    });
  }
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_WAVE_CONCURRENCY = 4;
const ACTIVE_TASK_STATUSES = new Set([
  "active",
  "blocked",
  "waiting_on_user",
  "validating",
]);
const TERMINAL_LANE_STATUSES = new Set(["done", "failed", "archived"]);
const FAILURE_LANE_STATUSES = new Set([
  "failed",
  "error",
  "errored",
  "stopped",
  "interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Defensive wave-id reader. W1's canonical contract is `metadata.waveId`; the
 * aliases keep manually stamped tasks and pre-merge W1 experiments operable.
 */
export function readWaveId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const nested = isRecord(metadata.wave) ? metadata.wave : undefined;
  return (
    nonEmptyString(metadata[WAVE_ID_METADATA_KEY]) ??
    nonEmptyString(metadata.orchestratorWaveId) ??
    nonEmptyString(nested?.id)
  );
}

export interface RefillDecisionInput {
  status: string;
  goalMet: boolean;
  alreadyHandled: boolean;
}

/** Pure terminal-lane refill gate. */
export function shouldRefillWave(input: RefillDecisionInput): boolean {
  return (
    TERMINAL_LANE_STATUSES.has(input.status) &&
    !input.goalMet &&
    !input.alreadyHandled
  );
}

export interface SalvageEligibilityInput {
  status: string;
  workdir?: string | null;
  changedFiles?: readonly string[] | null;
}

/** Pure salvage gate: failed lane + inspectable workspace + real dirty paths. */
export function isSalvageEligible(input: SalvageEligibilityInput): boolean {
  return (
    FAILURE_LANE_STATUSES.has(input.status) &&
    Boolean(nonEmptyString(input.workdir)) &&
    Boolean(input.changedFiles && input.changedFiles.length > 0)
  );
}

export interface ActiveLaneScope {
  laneId: string;
  taskId?: string;
  waveId: string;
  attemptId: string;
  paths: string[];
  repo?: string;
}

export interface OpenPullRequestScope {
  id: string;
  repo: string;
  number: number;
  url?: string;
  changedFiles: string[];
}

export interface WaveCollision {
  key: string;
  waveId: string;
  attemptId: string;
  leftId: string;
  rightId: string;
  paths: string[];
  kind: "lane-lane" | "lane-pr";
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
}

function canonicalRepo(repo: string): string {
  try {
    const parsed = parseOwnerRepo(repo);
    return `${parsed.owner}/${parsed.repo}`.toLowerCase();
  } catch {
    return normalizePath(repo).toLowerCase();
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function overlappingPaths(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) found.add(normalizePath(a));
    }
  }
  return [...found].sort();
}

/** Pure collision detection over active lane scopes and open-PR changed files. */
export function detectWaveCollisions(
  lanes: readonly ActiveLaneScope[],
  pullRequests: readonly OpenPullRequestScope[],
): WaveCollision[] {
  const collisions: WaveCollision[] = [];
  const sorted = [...lanes].sort((a, b) => a.laneId.localeCompare(b.laneId));
  for (let i = 0; i < sorted.length; i++) {
    const left = sorted[i];
    if (!left) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const right = sorted[j];
      if (
        !right ||
        left.waveId !== right.waveId ||
        left.attemptId !== right.attemptId
      )
        continue;
      const paths = overlappingPaths(left.paths, right.paths);
      if (paths.length === 0) continue;
      collisions.push({
        key: `wave:${left.waveId}|attempt:${left.attemptId}|lane:${left.laneId}|lane:${right.laneId}`,
        waveId: left.waveId,
        attemptId: left.attemptId,
        leftId: left.laneId,
        rightId: right.laneId,
        paths,
        kind: "lane-lane",
      });
    }
  }
  for (const lane of sorted) {
    // A path has meaning only inside a repository. Without a confirmed lane
    // repo, comparing against PRs fetched for other lanes would create false
    // collisions on ubiquitous paths such as README.md or src/index.ts.
    if (!lane.repo) continue;
    for (const pr of pullRequests) {
      if (canonicalRepo(lane.repo) !== canonicalRepo(pr.repo)) continue;
      const paths = overlappingPaths(lane.paths, pr.changedFiles);
      if (paths.length === 0) continue;
      collisions.push({
        key: `wave:${lane.waveId}|attempt:${lane.attemptId}|lane:${lane.laneId}|pr:${pr.id}`,
        waveId: lane.waveId,
        attemptId: lane.attemptId,
        leftId: lane.laneId,
        rightId: pr.id,
        paths,
        kind: "lane-pr",
      });
    }
  }
  return collisions.sort((a, b) => a.key.localeCompare(b.key));
}

export interface WaveReplacementSpec {
  title: string;
  goal: string;
  initialPrompt: string;
  scope?: string[];
  forbiddenPaths?: string[];
  acceptanceCriteria?: string[];
  difficultyTag?: string;
  metadata?: Record<string, unknown>;
}

export interface WaveRefillRequest {
  waveId: string;
  waveGoal: string;
  terminalLane: TaskThreadDetailDto;
  activeLanes: TaskThreadDetailDto[];
  collisions: WaveCollision[];
  salvagePath?: string;
  salvageChangedFiles?: string[];
}

/** W1 integration seam. Its eventual planner service implements this shape. */
export interface WaveRefillPlanner {
  planReplacement(
    request: WaveRefillRequest,
  ): Promise<WaveReplacementSpec | null>;
}

/** Independently-landable W3 fallback. It performs no model call and no refill. */
export class NoopWaveRefillPlanner implements WaveRefillPlanner {
  async planReplacement(_request: WaveRefillRequest): Promise<null> {
    return null;
  }
}

export interface OpenPullRequestSource {
  listOpenPullRequests(
    repos: readonly string[],
  ): Promise<OpenPullRequestScope[]>;
}

/** GitHub REST reader that exhausts pagination before reporting collision scope. */
class RuntimeGitHubPullRequestSource implements OpenPullRequestSource {
  constructor(private readonly runtime: IAgentRuntime) {}

  async listOpenPullRequests(
    repos: readonly string[],
  ): Promise<OpenPullRequestScope[]> {
    const token = nonEmptyString(this.runtime.getSetting("GITHUB_TOKEN"));
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const results: OpenPullRequestScope[] = [];
    for (const rawRepo of new Set(repos)) {
      const { owner, repo } = parseOwnerRepo(rawRepo);
      const pulls: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const pullsResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100&page=${page}`,
          { headers, signal: AbortSignal.timeout(5_000) },
        );
        if (!pullsResponse.ok) {
          throw new Error(
            `GitHub pull-request inventory failed for ${owner}/${repo} page ${page}: HTTP ${pullsResponse.status}`,
          );
        }
        const pagePulls = (await pullsResponse.json()) as unknown;
        if (!Array.isArray(pagePulls)) {
          throw new Error(
            `GitHub pull-request inventory returned a non-array for ${owner}/${repo} page ${page}`,
          );
        }
        pulls.push(...pagePulls);
        if (pagePulls.length < 100) break;
      }
      for (const pull of pulls) {
        if (!isRecord(pull) || typeof pull.number !== "number") continue;
        const files: unknown[] = [];
        for (let page = 1; ; page += 1) {
          const filesResponse = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull.number}/files?per_page=100&page=${page}`,
            { headers, signal: AbortSignal.timeout(5_000) },
          );
          if (!filesResponse.ok) {
            throw new Error(
              `GitHub changed-file inventory failed for ${owner}/${repo}#${pull.number} page ${page}: HTTP ${filesResponse.status}`,
            );
          }
          const pageFiles = (await filesResponse.json()) as unknown;
          if (!Array.isArray(pageFiles)) {
            throw new Error(
              `GitHub changed-file inventory returned a non-array for ${owner}/${repo}#${pull.number} page ${page}`,
            );
          }
          files.push(...pageFiles);
          if (pageFiles.length < 100) break;
        }
        const changedFiles = files
          .map((file) =>
            isRecord(file) ? nonEmptyString(file.filename) : undefined,
          )
          .filter((file): file is string => Boolean(file));
        results.push({
          id: `${owner}/${repo}#${pull.number}`,
          repo: `${owner}/${repo}`,
          number: pull.number,
          url: nonEmptyString(pull.html_url),
          changedFiles,
        });
      }
    }
    return results;
  }
}

interface TaskServiceLike {
  listTasks(): Promise<Array<{ id: string }>>;
  getTask(taskId: string): Promise<TaskThreadDetailDto | null>;
  createTask(input: CreateTaskInput): Promise<TaskThreadDetailDto>;
  updateTask(
    taskId: string,
    patch: { metadata?: Record<string, unknown> },
  ): Promise<TaskThreadDetailDto | null>;
  spawnAgentForTask(
    taskId: string,
    opts?: { task?: string; workdir?: string; repo?: string },
  ): Promise<TaskThreadDetailDto | null>;
  getTaskOriginTarget(
    taskId: string,
  ): Promise<{ roomId: string; source: string; worldId?: string } | null>;
  pauseTask?(taskId: string): Promise<TaskThreadDetailDto | null>;
  resumeTask?(taskId: string): Promise<TaskThreadDetailDto | null>;
  stopTaskAgent?(taskId: string, sessionId: string): Promise<boolean>;
}

interface WorkspaceServiceLike {
  workspaceRegistry?: WorkspaceRegistry;
  getWorkspaceRegistry?: () => WorkspaceRegistry;
}

type RuntimeWithSendTarget = IAgentRuntime & {
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID; accountId?: string },
    content: Content,
  ) => SendHandlerResult;
};

export interface WaveStatus {
  waveId: string;
  totalLanes: number;
  activeLanes: number;
  terminalLanes: number;
  queuedLanes: number;
  concurrencyCap: number;
  refillCount: number;
  salvageCount: number;
  collisionCount: number;
  budgetState: "ok" | "paused";
  budgetReason?: string;
}

function readScope(metadata: Record<string, unknown>): string[] {
  const lane = isRecord(metadata.lane) ? metadata.lane : undefined;
  const raw =
    lane?.scopePaths ?? lane?.scope ?? metadata.laneScope ?? metadata.scope;
  if (typeof raw === "string") return [raw].map(normalizePath).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw
      .map(nonEmptyString)
      .filter((item): item is string => Boolean(item))
      .map(normalizePath)
      .filter(Boolean);
  }
  if (isRecord(raw) && Array.isArray(raw.paths)) {
    return raw.paths
      .map(nonEmptyString)
      .filter((item): item is string => Boolean(item))
      .map(normalizePath)
      .filter(Boolean);
  }
  return [];
}

export function readLaneId(
  metadata: Record<string, unknown> | undefined,
  fallbackTaskId: string,
): string {
  const lane = metadata && isRecord(metadata.lane) ? metadata.lane : undefined;
  return (
    nonEmptyString(lane?.id) ??
    nonEmptyString(metadata?.laneId) ??
    fallbackTaskId
  );
}

export function readWaveAttemptId(
  metadata: Record<string, unknown> | undefined,
): string {
  const wave = metadata && isRecord(metadata.wave) ? metadata.wave : undefined;
  return (
    nonEmptyString(metadata?.waveAttemptId) ??
    nonEmptyString(wave?.attemptId) ??
    nonEmptyString(metadata?.attemptId) ??
    "default"
  );
}

export function readLaneDependencies(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const lane = metadata && isRecord(metadata.lane) ? metadata.lane : undefined;
  const raw = lane?.dependencies ?? metadata?.laneDependencies;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(nonEmptyString)
    .filter((dependency): dependency is string => Boolean(dependency));
}

function readWaveGoal(
  metadata: Record<string, unknown>,
  fallback: string,
): string {
  const wave = isRecord(metadata.wave) ? metadata.wave : undefined;
  return (
    nonEmptyString(metadata.waveGoal) ?? nonEmptyString(wave?.goal) ?? fallback
  );
}

function readWaveBudget(metadata: Record<string, unknown> | undefined): {
  maxCostUsd?: number;
  maxTokens?: number;
} {
  const wave = metadata && isRecord(metadata.wave) ? metadata.wave : undefined;
  const budget = isRecord(metadata?.waveBudget)
    ? metadata?.waveBudget
    : isRecord(wave?.budget)
      ? wave?.budget
      : undefined;
  const maxCostUsd =
    typeof metadata?.waveBudgetMaxCostUsd === "number"
      ? metadata.waveBudgetMaxCostUsd
      : typeof budget?.maxCostUsd === "number"
        ? budget.maxCostUsd
        : undefined;
  const maxTokens =
    typeof metadata?.waveBudgetMaxTokens === "number"
      ? metadata.waveBudgetMaxTokens
      : typeof budget?.maxTokens === "number"
        ? budget.maxTokens
        : undefined;
  return {
    ...(maxCostUsd !== undefined && Number.isFinite(maxCostUsd)
      ? { maxCostUsd }
      : {}),
    ...(maxTokens !== undefined && Number.isFinite(maxTokens)
      ? { maxTokens }
      : {}),
  };
}

function captureUncommittedFiles(workdir: string | null): string[] {
  if (!workdir) return [];
  const result = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.slice(3).trim())
    .filter(Boolean);
}

function goalMet(task: TaskThreadDetailDto): boolean {
  const nested = isRecord(task.metadata.wave) ? task.metadata.wave : undefined;
  return task.metadata.waveGoalMet === true || nested?.goalMet === true;
}

function refillHandled(task: TaskThreadDetailDto): boolean {
  const state = task.metadata.waveSupervisor;
  return isRecord(state) && typeof state.refillHandledAt === "string";
}

function taskIsActive(task: TaskThreadDetailDto): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

export class WaveSupervisor extends Service {
  static serviceType = WAVE_SUPERVISOR_SERVICE_TYPE;
  static dependencies = ["ORCHESTRATOR_TASK_SERVICE"];
  capabilityDescription =
    "Supervises wave-scoped lane refill, salvage, collision warnings, concurrency, and status.";

  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly warnedCollisions = new Set<string>();
  private readonly reservations = new Map<string, string>();
  private readonly inFlightRefills = new Set<string>();
  private statuses: WaveStatus[] = [];
  private readonly plannerOverride?: WaveRefillPlanner;
  private readonly pullRequestSource: OpenPullRequestSource;

  constructor(
    runtime: IAgentRuntime,
    opts: {
      planner?: WaveRefillPlanner;
      pullRequestSource?: OpenPullRequestSource;
    } = {},
  ) {
    super(runtime);
    this.plannerOverride = opts.planner;
    this.pullRequestSource =
      opts.pullRequestSource ?? new RuntimeGitHubPullRequestSource(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<WaveSupervisor> {
    const service = new WaveSupervisor(runtime);
    if (service.enabled()) service.startTimer();
    return service;
  }

  private setting(key: string): string | undefined {
    const value = this.runtime.getSetting(key);
    if (typeof value === "string" && value.length > 0) return value;
    return process.env[key];
  }

  enabled(): boolean {
    const raw = this.setting(WAVE_SUPERVISOR_SETTING);
    return raw === "1" || raw === "true";
  }

  private intervalMs(): number {
    const parsed = Number.parseInt(
      this.setting("ELIZA_ORCHESTRATOR_WAVE_INTERVAL_MS") ?? "",
      10,
    );
    return Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS
      ? parsed
      : DEFAULT_INTERVAL_MS;
  }

  private configuredCap(): number {
    const parsed = Number.parseInt(
      this.setting("ELIZA_ORCHESTRATOR_WAVE_CONCURRENCY") ?? "",
      10,
    );
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_WAVE_CONCURRENCY;
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        logger.warn(
          `[WaveSupervisor] tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs());
    (this.timer as { unref?: () => void }).unref?.();
  }

  private taskService(): TaskServiceLike | null {
    return this.runtime.getService<TaskServiceLike & ServiceType>(
      "ORCHESTRATOR_TASK_SERVICE",
    );
  }

  private planner(): WaveRefillPlanner {
    if (this.plannerOverride) return this.plannerOverride;
    const planner = this.runtime.getService<WaveRefillPlanner & ServiceType>(
      WAVE_REFILL_PLANNER_SERVICE_TYPE,
    );
    return planner?.planReplacement ? planner : new NoopWaveRefillPlanner();
  }

  private workspaceRegistry(): WorkspaceRegistry | undefined {
    const service = this.runtime.getService<WorkspaceServiceLike & ServiceType>(
      "CODING_WORKSPACE_SERVICE",
    );
    if (typeof service?.getWorkspaceRegistry === "function") {
      return service.getWorkspaceRegistry();
    }
    return service?.workspaceRegistry;
  }

  /** Admission-queue seam. Reservations close concurrent spawn races per wave. */
  async tryAcquire(taskId: string): Promise<boolean> {
    if (!this.enabled()) return true;
    const tasks = await this.loadWaveTasks();
    const task = tasks.find((candidate) => candidate.id === taskId);
    const waveId = task ? readWaveId(task.metadata) : undefined;
    if (!task) return true;
    if (!waveId) return true;
    const budget = this.evaluateBudget(tasks, waveId);
    if (budget.breached) {
      await this.pauseWaveForBudget(waveId, tasks, budget.reason);
      return false;
    }
    if (!this.dependenciesSatisfied(task, tasks)) return false;
    if (this.reservations.get(taskId) === waveId) return true;
    this.releaseTerminalReservations(tasks);
    const active = tasks.filter(
      (candidate) =>
        readWaveId(candidate.metadata) === waveId && taskIsActive(candidate),
    ).length;
    const reserved = [...this.reservations.entries()].filter(
      ([reservedTaskId, reservedWaveId]) =>
        reservedWaveId === waveId && reservedTaskId !== taskId,
    ).length;
    if (active + reserved >= this.waveCap(tasks, waveId)) return false;
    this.reservations.set(taskId, waveId);
    return true;
  }

  release(taskId: string): void {
    this.reservations.delete(taskId);
  }

  async concurrencyForTask(
    taskId: string,
  ): Promise<{ waveId: string; cap: number } | null> {
    if (!this.enabled()) return null;
    const tasks = await this.loadWaveTasks();
    const task = tasks.find((candidate) => candidate.id === taskId);
    const waveId = task ? readWaveId(task.metadata) : undefined;
    return waveId ? { waveId, cap: this.waveCap(tasks, waveId) } : null;
  }

  getWaveStatuses(): WaveStatus[] {
    return structuredClone(this.statuses);
  }

  async runOnce(): Promise<WaveStatus[]> {
    if (!this.enabled()) return [];
    const service = this.taskService();
    if (!service) return [];
    const tasks = await this.loadWaveTasks();
    this.releaseTerminalReservations(tasks);
    const activeScopes = tasks
      .filter(taskIsActive)
      .map((task) => ({
        laneId: readLaneId(task.metadata, task.id),
        taskId: task.id,
        waveId: readWaveId(task.metadata) ?? "",
        attemptId: readWaveAttemptId(task.metadata),
        paths: readScope(task.metadata),
        ...(task.latestRepo ? { repo: task.latestRepo } : {}),
      }))
      .filter((lane) => lane.waveId && lane.paths.length > 0);
    for (const waveId of [
      ...new Set(
        tasks.map((task) => readWaveId(task.metadata)).filter(Boolean),
      ),
    ] as string[]) {
      const budget = this.evaluateBudget(tasks, waveId);
      if (budget.breached) {
        await this.pauseWaveForBudget(waveId, tasks, budget.reason);
      }
    }
    const activeTaskIds = new Set(
      activeScopes.map((lane) => lane.taskId ?? lane.laneId),
    );
    const repos = tasks
      .filter((task) => activeTaskIds.has(task.id))
      .map((task) => task.latestRepo)
      .filter((repo): repo is string => Boolean(repo));
    let pullRequests: OpenPullRequestScope[] = [];
    try {
      if (activeScopes.length > 0 && repos.length > 0) {
        pullRequests = await this.pullRequestSource.listOpenPullRequests(repos);
      }
    } catch (error) {
      logger.warn(
        `[WaveSupervisor] open PR collision refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const collisions = detectWaveCollisions(activeScopes, pullRequests);
    await this.warnNewCollisions(service, tasks, collisions);
    for (const task of tasks) {
      if (
        shouldRefillWave({
          status: task.status,
          goalMet: goalMet(task),
          alreadyHandled: refillHandled(task),
        })
      ) {
        if (this.inFlightRefills.has(task.id)) continue;
        this.inFlightRefills.add(task.id);
        try {
          await this.refillLane(service, task, tasks, collisions);
        } catch (error) {
          logger.warn(
            `[WaveSupervisor] refill failed for lane ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          this.inFlightRefills.delete(task.id);
        }
      }
    }
    const refreshed = await this.loadWaveTasks();
    this.statuses = this.computeStatuses(refreshed, collisions);
    await this.persistStatuses(service, refreshed, this.statuses);
    return this.getWaveStatuses();
  }

  async approveBudgetIncrease(input: {
    waveId: string;
    approvedBy: string;
    reason: string;
    maxCostUsd?: number;
    maxTokens?: number;
  }): Promise<WaveStatus[]> {
    const service = this.taskService();
    if (!service) return [];
    const tasks = await this.loadWaveTasks();
    const waveTasks = tasks.filter(
      (task) => readWaveId(task.metadata) === input.waveId,
    );
    const approvedAt = new Date().toISOString();
    for (const task of waveTasks) {
      const wave = isRecord(task.metadata.wave) ? task.metadata.wave : {};
      const supervisor = isRecord(task.metadata.waveSupervisor)
        ? task.metadata.waveSupervisor
        : {};
      const approvedBudget = {
        ...readWaveBudget(task.metadata),
        ...(input.maxCostUsd !== undefined
          ? { maxCostUsd: input.maxCostUsd }
          : {}),
        ...(input.maxTokens !== undefined
          ? { maxTokens: input.maxTokens }
          : {}),
      };
      await service.updateTask(task.id, {
        metadata: {
          ...task.metadata,
          waveBudget: approvedBudget,
          ...(approvedBudget.maxCostUsd !== undefined
            ? { waveBudgetMaxCostUsd: approvedBudget.maxCostUsd }
            : {}),
          ...(approvedBudget.maxTokens !== undefined
            ? { waveBudgetMaxTokens: approvedBudget.maxTokens }
            : {}),
          wave: {
            ...wave,
            budget: approvedBudget,
          },
          waveSupervisor: {
            ...supervisor,
            budgetApproval: {
              approvedAt,
              approvedBy: input.approvedBy,
              reason: input.reason,
              ...(input.maxCostUsd !== undefined
                ? { maxCostUsd: input.maxCostUsd }
                : {}),
              ...(input.maxTokens !== undefined
                ? { maxTokens: input.maxTokens }
                : {}),
            },
          },
        },
      });
      if (task.paused) await service.resumeTask?.(task.id);
    }
    return this.runOnce();
  }

  private async loadWaveTasks(): Promise<TaskThreadDetailDto[]> {
    const service = this.taskService();
    if (!service) return [];
    const summaries = await service.listTasks();
    const details = await Promise.all(
      summaries.map((task) => service.getTask(task.id)),
    );
    return details.filter(
      (task): task is TaskThreadDetailDto =>
        task !== null && Boolean(readWaveId(task.metadata)),
    );
  }

  private releaseTerminalReservations(
    tasks: readonly TaskThreadDetailDto[],
  ): void {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const taskId of this.reservations.keys()) {
      const task = byId.get(taskId);
      if (
        !task ||
        TERMINAL_LANE_STATUSES.has(task.status) ||
        taskIsActive(task)
      ) {
        this.reservations.delete(taskId);
      }
    }
  }

  private waveCap(
    tasks: readonly TaskThreadDetailDto[],
    waveId: string,
  ): number {
    for (const task of tasks) {
      if (readWaveId(task.metadata) !== waveId) continue;
      const raw = task.metadata.waveConcurrencyCap;
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.floor(raw);
      }
    }
    return this.configuredCap();
  }

  private async refillLane(
    service: TaskServiceLike,
    terminalLane: TaskThreadDetailDto,
    allTasks: TaskThreadDetailDto[],
    collisions: WaveCollision[],
  ): Promise<void> {
    const waveId = readWaveId(terminalLane.metadata);
    if (!waveId) return;
    const changedFiles = captureUncommittedFiles(terminalLane.latestWorkdir);
    const salvage = isSalvageEligible({
      status: terminalLane.status,
      workdir: terminalLane.latestWorkdir,
      changedFiles,
    });
    let salvagePath: string | undefined;
    if (salvage && terminalLane.latestWorkdir) {
      const registry = this.workspaceRegistry();
      const preserved = registry
        ? preserveRegisteredWorkspace(
            terminalLane.latestWorkdir,
            registry,
            (message) => logger.info(`[WaveSupervisor] ${message}`),
          )
        : false;
      // Caller-owned workdirs are already outside lifecycle deletion. Registered
      // workdirs are explicitly returned to live accounting by the helper.
      if (preserved || terminalLane.latestWorkdir) {
        salvagePath = terminalLane.latestWorkdir;
      }
    }
    const waveTasks = allTasks.filter(
      (task) => readWaveId(task.metadata) === waveId,
    );
    const activeLanes = waveTasks.filter(taskIsActive);
    const waveGoal = readWaveGoal(terminalLane.metadata, terminalLane.goal);
    const planner = this.planner();
    const spec = await planner.planReplacement({
      waveId,
      waveGoal,
      terminalLane,
      activeLanes,
      collisions: collisions.filter((collision) => collision.waveId === waveId),
      ...(salvagePath
        ? { salvagePath, salvageChangedFiles: changedFiles }
        : {}),
    });
    const supervisorState = isRecord(terminalLane.metadata.waveSupervisor)
      ? terminalLane.metadata.waveSupervisor
      : {};
    const markHandled = async (
      outcome: "replacement_created" | "planner_noop",
    ) =>
      service.updateTask(terminalLane.id, {
        metadata: {
          ...terminalLane.metadata,
          waveSupervisor: {
            ...supervisorState,
            refillHandledAt: new Date().toISOString(),
            refillOutcome: outcome,
            ...(salvagePath
              ? { salvagePath, salvageChangedFiles: changedFiles }
              : {}),
          },
        },
      });
    if (!spec) {
      // The independently-landable stub must not consume the terminal event:
      // once W1's planner service appears, a later tick should still refill it.
      // A real injected planner returning null is authoritative and is handled
      // once to avoid asking it the same question forever.
      if (!(planner instanceof NoopWaveRefillPlanner)) {
        await markHandled("planner_noop");
      }
      return;
    }
    const salvageBrief = salvagePath
      ? `\n\n--- Salvage from failed lane ---\nPreserved workspace: ${salvagePath}\nUncommitted paths: ${changedFiles.join(", ")}\nInspect and reuse this work before starting over.`
      : "";
    const replacement = await service.createTask({
      title: spec.title,
      goal: spec.goal,
      originalRequest: spec.initialPrompt,
      kind: terminalLane.kind,
      priority: terminalLane.priority,
      acceptanceCriteria: spec.acceptanceCriteria,
      ownerUserId: terminalLane.ownerUserId ?? undefined,
      worldId: terminalLane.worldId ?? undefined,
      projectId: terminalLane.projectId ?? undefined,
      roomId: terminalLane.roomId ?? undefined,
      taskRoomId: terminalLane.taskRoomId ?? undefined,
      parentTaskId: terminalLane.id,
      forkSource: "wave-refill",
      providerPolicy: terminalLane.providerPolicy ?? undefined,
      metadata: {
        ...spec.metadata,
        [WAVE_ID_METADATA_KEY]: waveId,
        waveAttemptId: readWaveAttemptId(terminalLane.metadata),
        waveGoal,
        lane: {
          id: `${readLaneId(terminalLane.metadata, terminalLane.id)}-refill`,
          dependencies: [],
          scopePaths: spec.scope ?? [],
        },
        laneScope: spec.scope ?? [],
        forbiddenPaths: spec.forbiddenPaths ?? [],
        difficultyTag: spec.difficultyTag,
        waveRefillOf: terminalLane.id,
        ...(salvagePath
          ? { salvagePath, salvageChangedFiles: changedFiles }
          : {}),
      },
    });
    // Creation is the durable idempotency boundary: mark the predecessor before
    // dispatch so a transport failure cannot mint duplicate replacement tasks
    // on the next tick. A failed dispatch leaves one inspectable open task.
    await markHandled("replacement_created");
    await service.spawnAgentForTask(replacement.id, {
      task: `${spec.initialPrompt}${salvageBrief}`,
      ...(salvagePath ? { workdir: salvagePath } : {}),
      ...(terminalLane.latestRepo ? { repo: terminalLane.latestRepo } : {}),
    });
  }

  private async warnNewCollisions(
    service: TaskServiceLike,
    tasks: readonly TaskThreadDetailDto[],
    collisions: readonly WaveCollision[],
  ): Promise<void> {
    const send = (this.runtime as RuntimeWithSendTarget).sendMessageToTarget;
    if (typeof send !== "function") return;
    const byId = new Map(
      tasks.flatMap((task) => [
        [task.id, task] as const,
        [readLaneId(task.metadata, task.id), task] as const,
      ]),
    );
    for (const collision of collisions) {
      if (this.warnedCollisions.has(collision.key)) continue;
      const originTask = byId.get(collision.leftId);
      if (!originTask) continue;
      const target = await service.getTaskOriginTarget(originTask.id);
      if (!target) continue;
      this.warnedCollisions.add(collision.key);
      try {
        const other =
          collision.kind === "lane-pr"
            ? `open PR ${collision.rightId}`
            : `lane ${collision.rightId}`;
        const text = `Wave ${collision.waveId} collision warning: lane ${collision.leftId} now overlaps ${other} on ${collision.paths.join(", ")}. Re-scope or coordinate before continuing.`;
        requireConfirmedSendHandlerDelivery(
          await send(
            { source: target.source, roomId: target.roomId as UUID },
            { text, source: target.source },
          ),
        );
      } catch (error) {
        this.warnedCollisions.delete(collision.key);
        logger.warn(
          `[WaveSupervisor] collision warning delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private computeStatuses(
    tasks: readonly TaskThreadDetailDto[],
    collisions: readonly WaveCollision[],
  ): WaveStatus[] {
    const waveIds = [
      ...new Set(
        tasks.map((task) => readWaveId(task.metadata)).filter(Boolean),
      ),
    ] as string[];
    return waveIds.sort().map((waveId) => {
      const lanes = tasks.filter(
        (task) => readWaveId(task.metadata) === waveId,
      );
      const supervisorStates = lanes
        .map((task) => task.metadata.waveSupervisor)
        .filter(isRecord);
      const budget = this.evaluateBudget(tasks, waveId);
      return {
        waveId,
        totalLanes: lanes.length,
        activeLanes: lanes.filter(taskIsActive).length,
        terminalLanes: lanes.filter((task) =>
          TERMINAL_LANE_STATUSES.has(task.status),
        ).length,
        queuedLanes: lanes.filter((task) => isRecord(task.metadata.admission))
          .length,
        concurrencyCap: this.waveCap(tasks, waveId),
        refillCount: lanes.filter((task) =>
          nonEmptyString(task.metadata.waveRefillOf),
        ).length,
        salvageCount: supervisorStates.filter((state) =>
          nonEmptyString(state.salvagePath),
        ).length,
        collisionCount: collisions.filter(
          (collision) => collision.waveId === waveId,
        ).length,
        budgetState: budget.breached ? "paused" : "ok",
        ...(budget.breached ? { budgetReason: budget.reason } : {}),
      };
    });
  }

  private dependenciesSatisfied(
    task: TaskThreadDetailDto,
    tasks: readonly TaskThreadDetailDto[],
  ): boolean {
    const dependencies = readLaneDependencies(task.metadata);
    if (dependencies.length === 0) return true;
    const waveId = readWaveId(task.metadata);
    const attemptId = readWaveAttemptId(task.metadata);
    const sameAttempt = tasks.filter(
      (candidate) =>
        readWaveId(candidate.metadata) === waveId &&
        readWaveAttemptId(candidate.metadata) === attemptId,
    );
    const byLaneId = new Map(
      sameAttempt.map((candidate) => [
        readLaneId(candidate.metadata, candidate.id),
        candidate,
      ]),
    );
    return dependencies.every((dependency) => {
      const dep = byLaneId.get(dependency);
      return dep?.status === "done";
    });
  }

  private evaluateBudget(
    tasks: readonly TaskThreadDetailDto[],
    waveId: string,
  ): { breached: false } | { breached: true; reason: string } {
    const lanes = tasks.filter((task) => readWaveId(task.metadata) === waveId);
    const budget = lanes.reduce(
      (found, task) => ({
        maxCostUsd:
          found.maxCostUsd ?? readWaveBudget(task.metadata).maxCostUsd,
        maxTokens: found.maxTokens ?? readWaveBudget(task.metadata).maxTokens,
      }),
      {} as { maxCostUsd?: number; maxTokens?: number },
    );
    const costUsd = lanes.reduce((sum, task) => sum + task.usage.costUsd, 0);
    const totalTokens = lanes.reduce(
      (sum, task) => sum + task.usage.totalTokens,
      0,
    );
    if (budget.maxCostUsd !== undefined && costUsd >= budget.maxCostUsd) {
      return {
        breached: true,
        reason: `cost ${costUsd.toFixed(6)} >= ${budget.maxCostUsd.toFixed(6)} USD`,
      };
    }
    if (budget.maxTokens !== undefined && totalTokens >= budget.maxTokens) {
      return {
        breached: true,
        reason: `tokens ${totalTokens} >= ${budget.maxTokens}`,
      };
    }
    return { breached: false };
  }

  private async pauseWaveForBudget(
    waveId: string,
    tasks: readonly TaskThreadDetailDto[],
    reason: string,
  ): Promise<void> {
    const service = this.taskService();
    if (!service) return;
    const waveTasks = tasks.filter(
      (task) => readWaveId(task.metadata) === waveId,
    );
    const stoppedAt = new Date().toISOString();
    const error = new WaveBudgetBreachError(waveId, reason, {
      taskIds: waveTasks.map((task) => task.id),
    });
    this.runtime.reportError?.("WaveSupervisor.budget", error, {
      waveId,
      reason,
    });
    for (const task of waveTasks) {
      const state = isRecord(task.metadata.waveSupervisor)
        ? task.metadata.waveSupervisor
        : {};
      await service.updateTask(task.id, {
        metadata: {
          ...task.metadata,
          waveSupervisor: {
            ...state,
            pausedAt: stoppedAt,
            pausedReason: reason,
            pauseCode: WAVE_BUDGET_BREACH_CODE,
          },
        },
      });
      if (!task.paused && !TERMINAL_LANE_STATUSES.has(task.status)) {
        await service.pauseTask?.(task.id);
      }
    }
  }

  private async persistStatuses(
    service: TaskServiceLike,
    tasks: readonly TaskThreadDetailDto[],
    statuses: readonly WaveStatus[],
  ): Promise<void> {
    const byWave = new Map(statuses.map((status) => [status.waveId, status]));
    for (const task of tasks) {
      const waveId = readWaveId(task.metadata);
      const status = waveId ? byWave.get(waveId) : undefined;
      if (!status) continue;
      const previous = task.metadata.waveStatus;
      if (JSON.stringify(previous) === JSON.stringify(status)) continue;
      await service.updateTask(task.id, {
        metadata: { ...task.metadata, waveStatus: status },
      });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.warnedCollisions.clear();
    this.reservations.clear();
    this.inFlightRefills.clear();
    this.statuses = [];
  }
}
