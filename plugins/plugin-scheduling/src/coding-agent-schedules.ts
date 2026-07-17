/**
 * Production-safe coding-agent schedule recipes for the generic scheduling
 * spine.
 *
 * This module deliberately depends only on public runtime service lookup. The
 * GitHub reader is an injected port and the coding task writer is the existing
 * orchestrator service resolved by serviceType, so scheduling can host recurring
 * coding automation without importing or editing orchestrator internals.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { DispatchResult } from "./dispatch-types.js";
import type {
  ScheduledTaskDispatcher,
  ScheduledTaskDispatchRecord,
  ScheduledTaskRunnerHandle,
} from "./scheduled-task/runner.js";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskTrigger,
} from "./scheduled-task/types.js";

export const CODING_AGENT_SCHEDULE_METADATA_KEY = "codingAgentSchedule";
export const PR_SHEPHERD_RECIPE = "pr-shepherd";
export const PR_SHEPHERD_DISPATCH_CHANNEL = "coding_agent_pr_shepherd";
export const GITHUB_PR_SHEPHERD_SERVICE_TYPE = "GITHUB_PR_SHEPHERD_SERVICE";
export const ORCHESTRATOR_TASK_SERVICE_TYPE = "ORCHESTRATOR_TASK_SERVICE";
const MAX_TASKS_PER_RUN_DEFAULT = 5;
const MAX_TASKS_PER_RUN_CEILING = 20;
const DEFAULT_GITHUB_PR_RESULT_LIMIT = 50;
const GITHUB_GRAPHQL_PAGE_SIZE = 25;
const GITHUB_API_BASE = "https://api.github.com";

const LIVE_TASK_STATUSES = new Set([
  "open",
  "active",
  "waiting_on_user",
  "blocked",
  "validating",
  "interrupted",
]);

type PrShepherdSignal = "changes_requested" | "behind_base" | "failed_checks";

export interface PrShepherdSchedulePolicy {
  allowProposeFixes?: boolean;
  maxTasksPerRun?: number;
}

export interface PrShepherdScheduleMetadata {
  recipe: typeof PR_SHEPHERD_RECIPE;
  ownerAgentId: string;
  ownerUserId?: string;
  projectId?: string;
  workdir?: string;
  repo?: string;
  policy?: PrShepherdSchedulePolicy;
  paused?: boolean;
}

export interface PrShepherdPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRef?: string;
  baseRef?: string;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  behindBase?: boolean;
  checksConclusion?:
    | "success"
    | "failure"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "neutral"
    | "skipped"
    | "pending"
    | "unknown";
}

export interface GitHubPrShepherdService {
  listAssignedOpenPullRequests(args: {
    agentId: string;
    ownerUserId?: string;
    projectId?: string;
    repo?: string;
  }): Promise<PrShepherdPullRequest[]>;
}

interface GitHubViewer {
  login: string;
}

interface GitHubGraphQlSearchResponse {
  errors?: unknown[];
  data?: {
    search?: {
      nodes?: unknown[];
      pageInfo?: {
        hasNextPage?: unknown;
        endCursor?: unknown;
      };
    };
  };
}

interface OrchestratorTaskServiceLike {
  createTask(input: {
    title: string;
    goal: string;
    originalRequest?: string;
    kind?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    acceptanceCriteria?: string[];
    ownerUserId?: string;
    projectId?: string;
    workdir?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id?: string; metadata?: Record<string, unknown> }>;
  listTasks?(filter?: {
    status?: string;
    includeArchived?: boolean;
    limit?: number;
    projectId?: string;
  }): Promise<
    Array<{
      id: string;
      title?: string;
      status?: string;
      originalRequest?: string;
      projectId?: string | null;
      archivedAt?: string | null;
    }>
  >;
  getTask?(taskId: string): Promise<{
    id: string;
    status?: string;
    metadata?: Record<string, unknown>;
    originalRequest?: string;
    projectId?: string | null;
  } | null>;
}

export interface PrShepherdRunReceipt {
  receiptKey: string;
  pr: {
    owner: string;
    repo: string;
    number: number;
    url: string;
  };
  signals: PrShepherdSignal[];
  taskId?: string;
  skipped?: "no_signal" | "live_task_exists";
  mergeDisabled: true;
}

export interface PrShepherdRunSummary {
  scheduleTaskId: string;
  checked: number;
  created: number;
  skipped: number;
  receipts: PrShepherdRunReceipt[];
}

export interface CreateCodingAgentScheduleDispatcherOptions {
  delegate?: ScheduledTaskDispatcher;
  githubServiceType?: string;
  orchestratorServiceType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRuntimeSetting(
  runtime: IAgentRuntime,
  key: string,
): string | null {
  const raw = runtime.getSetting(key);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function readGitHubToken(runtime: IAgentRuntime): string | null {
  // Keep this fallback local: plugin-scheduling cannot import app-core's
  // local credential store, but the live coding stack accepts GH_PAT for the
  // same GitHub bearer credential. GITHUB_TOKEN remains the explicit winner.
  return (
    readRuntimeSetting(runtime, "GITHUB_TOKEN") ??
    readRuntimeSetting(runtime, "GH_PAT")
  );
}

function parseRepoSpecifier(repo: string | undefined): {
  owner: string;
  repo: string;
} | null {
  if (!repo) return null;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match) {
    throw new Error("pr-shepherd repo scope must use owner/repo format");
  }
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

function safePositiveInteger(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return MAX_TASKS_PER_RUN_DEFAULT;
  }
  return Math.min(value, MAX_TASKS_PER_RUN_CEILING);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`pr-shepherd PR field ${key} must be a non-empty string`);
  }
  return value;
}

function validatePrUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("pr-shepherd PR url is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("pr-shepherd PR url must be a GitHub HTTPS URL");
  }
  return parsed.toString();
}

function normalizePr(
  value: unknown,
  repoScope?: { owner: string; repo: string } | null,
): PrShepherdPullRequest {
  if (!isRecord(value)) throw new Error("pr-shepherd PR must be an object");
  const owner = readStringField(value, "owner");
  const repo = readStringField(value, "repo");
  if (repoScope && (owner !== repoScope.owner || repo !== repoScope.repo)) {
    throw new Error("pr-shepherd PR does not match the configured repo scope");
  }
  const number = value.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw new Error("pr-shepherd PR number must be a positive integer");
  }
  const title = readStringField(value, "title");
  if (title.length > 300) {
    throw new Error("pr-shepherd PR title is too long");
  }
  const url = validatePrUrl(readStringField(value, "url"));
  const reviewDecision = value.reviewDecision ?? undefined;
  if (
    reviewDecision !== undefined &&
    reviewDecision !== "APPROVED" &&
    reviewDecision !== "CHANGES_REQUESTED" &&
    reviewDecision !== "REVIEW_REQUIRED"
  ) {
    throw new Error("pr-shepherd PR reviewDecision is invalid");
  }
  const checksConclusion = value.checksConclusion;
  if (
    checksConclusion !== undefined &&
    checksConclusion !== "success" &&
    checksConclusion !== "failure" &&
    checksConclusion !== "failed" &&
    checksConclusion !== "cancelled" &&
    checksConclusion !== "timed_out" &&
    checksConclusion !== "neutral" &&
    checksConclusion !== "skipped" &&
    checksConclusion !== "pending" &&
    checksConclusion !== "unknown"
  ) {
    throw new Error("pr-shepherd PR checksConclusion is invalid");
  }
  return {
    owner,
    repo,
    number,
    title,
    url,
    ...(typeof value.headRef === "string" && value.headRef.length > 0
      ? { headRef: value.headRef.slice(0, 255) }
      : {}),
    ...(typeof value.baseRef === "string" && value.baseRef.length > 0
      ? { baseRef: value.baseRef.slice(0, 255) }
      : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(typeof value.behindBase === "boolean"
      ? { behindBase: value.behindBase }
      : {}),
    ...(checksConclusion ? { checksConclusion } : {}),
  };
}

function normalizePrList(
  values: unknown[],
  repoScope?: { owner: string; repo: string } | null,
): PrShepherdPullRequest[] {
  return values.map((value) => normalizePr(value, repoScope));
}

function readPrShepherdMetadata(
  metadata: Record<string, unknown> | undefined,
): PrShepherdScheduleMetadata | null {
  const raw = metadata?.[CODING_AGENT_SCHEDULE_METADATA_KEY];
  if (!isRecord(raw) || raw.recipe !== PR_SHEPHERD_RECIPE) return null;
  const ownerAgentId = raw.ownerAgentId;
  if (typeof ownerAgentId !== "string" || ownerAgentId.length === 0) {
    throw new Error("pr-shepherd schedule metadata requires ownerAgentId");
  }
  const policy = isRecord(raw.policy)
    ? {
        allowProposeFixes: raw.policy.allowProposeFixes === true,
        maxTasksPerRun:
          typeof raw.policy.maxTasksPerRun === "number" &&
          Number.isInteger(raw.policy.maxTasksPerRun) &&
          raw.policy.maxTasksPerRun > 0
            ? raw.policy.maxTasksPerRun
            : undefined,
      }
    : undefined;
  return {
    recipe: PR_SHEPHERD_RECIPE,
    ownerAgentId,
    ...(typeof raw.ownerUserId === "string"
      ? { ownerUserId: raw.ownerUserId }
      : {}),
    ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
    ...(typeof raw.workdir === "string" ? { workdir: raw.workdir } : {}),
    ...(typeof raw.repo === "string" ? { repo: raw.repo } : {}),
    ...(policy ? { policy } : {}),
    paused: raw.paused === true,
  };
}

function receiptKeyFor(pr: PrShepherdPullRequest): string {
  return `pr-shepherd:${pr.owner}/${pr.repo}#${pr.number}`;
}

function signalsFor(pr: PrShepherdPullRequest): PrShepherdSignal[] {
  const signals: PrShepherdSignal[] = [];
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    signals.push("changes_requested");
  }
  if (pr.behindBase === true) {
    signals.push("behind_base");
  }
  if (
    pr.checksConclusion === "failure" ||
    pr.checksConclusion === "failed" ||
    pr.checksConclusion === "cancelled" ||
    pr.checksConclusion === "timed_out"
  ) {
    signals.push("failed_checks");
  }
  return signals;
}

function titleFor(pr: PrShepherdPullRequest): string {
  return `PR shepherd: ${pr.owner}/${pr.repo}#${pr.number}`;
}

function buildGoal(
  pr: PrShepherdPullRequest,
  signals: PrShepherdSignal[],
  policy: PrShepherdSchedulePolicy | undefined,
): string {
  const allowedFixes =
    policy?.allowProposeFixes === true
      ? "You may propose and implement scoped fixes for the detected PR issues."
      : "Inspect and report the minimal safe next action before making code changes.";
  return [
    `Shepherd pull request ${pr.owner}/${pr.repo}#${pr.number}: ${pr.url}`,
    `Detected signals: ${signals.join(", ")}.`,
    allowedFixes,
    "Do not merge the pull request. Do not enable or perform autonomous merge, even if a policy asks for it.",
    "Keep receipts in the task transcript: PR URL, detected signals, commands/checks run, and any proposed patch scope.",
  ].join("\n");
}

async function githubRequest<T>(args: {
  runtime: IAgentRuntime;
  token: string;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const fetchImpl = args.runtime.fetch ?? fetch;
  const headers = new Headers(args.init?.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("authorization", `Bearer ${args.token}`);
  headers.set("content-type", "application/json");
  headers.set("user-agent", "elizaos-plugin-scheduling-pr-shepherd");
  headers.set("x-github-api-version", "2022-11-28");
  const response = await fetchImpl(`${GITHUB_API_BASE}${args.path}`, {
    ...args.init,
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `GitHub PR shepherd read failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

function readAuthenticatedLogin(viewer: unknown): GitHubViewer {
  if (!isRecord(viewer) || typeof viewer.login !== "string") {
    throw new Error("GitHub authenticated user response did not include login");
  }
  return { login: viewer.login };
}

function checksConclusionFromRollup(
  value: unknown,
): PrShepherdPullRequest["checksConclusion"] {
  if (value === "FAILURE" || value === "ERROR") return "failure";
  if (value === "CANCELLED") return "cancelled";
  if (value === "TIMED_OUT") return "timed_out";
  if (value === "SUCCESS") return "success";
  if (value === "PENDING" || value === "EXPECTED") return "pending";
  if (value === "NEUTRAL" || value === "SKIPPED") return "neutral";
  return "unknown";
}

function prFromGraphQlNode(node: unknown): PrShepherdPullRequest {
  if (!isRecord(node))
    throw new Error("GitHub search returned invalid PR node");
  const repository = node.repository;
  if (!isRecord(repository)) {
    throw new Error("GitHub PR node is missing repository");
  }
  const ownerNode = repository.owner;
  if (!isRecord(ownerNode)) {
    throw new Error("GitHub PR repository owner is invalid");
  }
  const commits = node.commits;
  const latestCommit =
    isRecord(commits) && Array.isArray(commits.nodes)
      ? commits.nodes.at(0)
      : null;
  const commit =
    isRecord(latestCommit) && isRecord(latestCommit.commit)
      ? latestCommit.commit
      : null;
  const rollup =
    commit && isRecord(commit.statusCheckRollup)
      ? commit.statusCheckRollup
      : null;
  const mergeStateStatus = node.mergeStateStatus;
  return normalizePr({
    owner: readStringField(ownerNode, "login"),
    repo: readStringField(repository, "name"),
    number: node.number,
    title: node.title,
    url: node.url,
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    reviewDecision: node.reviewDecision,
    behindBase: mergeStateStatus === "BEHIND",
    checksConclusion: checksConclusionFromRollup(rollup?.state),
  });
}

function createDefaultGitHubPrShepherdService(
  runtime: IAgentRuntime,
  token: string,
): GitHubPrShepherdService {
  return {
    async listAssignedOpenPullRequests(args) {
      const viewer = readAuthenticatedLogin(
        await githubRequest<unknown>({ runtime, token, path: "/user" }),
      );
      const repoScope = parseRepoSpecifier(args.repo);
      const queryParts = [
        "is:pr",
        "is:open",
        `assignee:${viewer.login}`,
        ...(repoScope ? [`repo:${repoScope.owner}/${repoScope.repo}`] : []),
      ];
      const prs: PrShepherdPullRequest[] = [];
      let cursor: string | null = null;
      while (prs.length < DEFAULT_GITHUB_PR_RESULT_LIMIT) {
        const pageSize = Math.min(
          GITHUB_GRAPHQL_PAGE_SIZE,
          DEFAULT_GITHUB_PR_RESULT_LIMIT - prs.length,
        );
        const response: GitHubGraphQlSearchResponse =
          await githubRequest<GitHubGraphQlSearchResponse>({
            runtime,
            token,
            path: "/graphql",
            init: {
              method: "POST",
              body: JSON.stringify({
                query: `
                query AssignedPrShepherdSearch($query: String!, $first: Int!, $after: String) {
                  search(type: ISSUE, query: $query, first: $first, after: $after) {
                    nodes {
                      ... on PullRequest {
                        number
                        title
                        url
                        headRefName
                        baseRefName
                        reviewDecision
                        mergeStateStatus
                        repository {
                          name
                          owner { login }
                        }
                        commits(last: 1) {
                          nodes {
                            commit {
                              statusCheckRollup { state }
                            }
                          }
                        }
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              `,
                variables: {
                  query: queryParts.join(" "),
                  first: pageSize,
                  after: cursor,
                },
              }),
            },
          });
        if (Array.isArray(response.errors) && response.errors.length > 0) {
          throw new Error("GitHub PR shepherd GraphQL search failed");
        }
        const search: GitHubGraphQlSearchResponse["data"] extends infer Data
          ? Data extends { search?: infer Search }
            ? Search
            : undefined
          : undefined = response.data?.search;
        const nodes = Array.isArray(search?.nodes) ? search.nodes : [];
        for (const node of nodes) {
          prs.push(prFromGraphQlNode(node));
        }
        const hasNextPage = search?.pageInfo?.hasNextPage === true;
        cursor =
          typeof search?.pageInfo?.endCursor === "string"
            ? search.pageInfo.endCursor
            : null;
        if (!hasNextPage || !cursor) break;
      }
      return normalizePrList(prs, repoScope);
    },
  };
}

function resolveGitHubService(args: {
  runtime: IAgentRuntime;
  githubServiceType: string;
}): GitHubPrShepherdService | null {
  const injected = args.runtime.getService(
    args.githubServiceType,
  ) as GitHubPrShepherdService | null;
  if (injected && typeof injected.listAssignedOpenPullRequests === "function") {
    return injected;
  }
  const token = readGitHubToken(args.runtime);
  if (!token) return null;
  return createDefaultGitHubPrShepherdService(args.runtime, token);
}

async function findLiveTaskForReceipt(
  orchestrator: OrchestratorTaskServiceLike,
  receiptKey: string,
  pr: PrShepherdPullRequest,
  projectId?: string,
): Promise<string | null> {
  if (typeof orchestrator.listTasks !== "function") return null;
  const tasks = await orchestrator.listTasks({
    includeArchived: false,
    ...(projectId ? { projectId } : {}),
    limit: 200,
  });
  for (const task of tasks) {
    if (task.status && !LIVE_TASK_STATUSES.has(task.status)) continue;
    if (projectId && task.projectId && task.projectId !== projectId) continue;
    const detail =
      typeof orchestrator.getTask === "function"
        ? await orchestrator.getTask(task.id)
        : null;
    const metadata = detail?.metadata;
    if (
      metadata?.prShepherdReceiptKey === receiptKey ||
      metadata?.codingAgentScheduleReceiptKey === receiptKey
    ) {
      return task.id;
    }
    const haystack = `${task.title ?? ""}\n${task.originalRequest ?? ""}\n${detail?.originalRequest ?? ""}`;
    if (haystack.includes(pr.url) || haystack.includes(titleFor(pr))) {
      return task.id;
    }
  }
  return null;
}

async function runPrShepherd(args: {
  runtime: IAgentRuntime;
  record: ScheduledTaskDispatchRecord;
  schedule: PrShepherdScheduleMetadata;
  githubServiceType: string;
  orchestratorServiceType: string;
}): Promise<PrShepherdRunSummary> {
  const { runtime, record, schedule } = args;
  if (schedule.ownerAgentId !== runtime.agentId) {
    throw new Error(
      `pr-shepherd schedule owner ${schedule.ownerAgentId} does not match runtime agent ${runtime.agentId}`,
    );
  }
  if (schedule.paused) {
    return {
      scheduleTaskId: record.taskId,
      checked: 0,
      created: 0,
      skipped: 0,
      receipts: [],
    };
  }
  const github = resolveGitHubService({
    runtime,
    githubServiceType: args.githubServiceType,
  });
  if (!github) {
    throw new Error(
      `[${args.githubServiceType}] GitHub PR shepherd service is not registered and neither GITHUB_TOKEN nor GH_PAT is configured`,
    );
  }
  const orchestrator = runtime.getService(
    args.orchestratorServiceType,
  ) as OrchestratorTaskServiceLike | null;
  if (!orchestrator || typeof orchestrator.createTask !== "function") {
    throw new Error(
      `[${args.orchestratorServiceType}] Orchestrator task service is not registered`,
    );
  }

  const repoScope = parseRepoSpecifier(schedule.repo);
  const prs = normalizePrList(
    await github.listAssignedOpenPullRequests({
      agentId: runtime.agentId,
      ...(schedule.ownerUserId ? { ownerUserId: schedule.ownerUserId } : {}),
      ...(schedule.projectId ? { projectId: schedule.projectId } : {}),
      ...(schedule.repo ? { repo: schedule.repo } : {}),
    }),
    repoScope,
  );
  const maxTasks = safePositiveInteger(schedule.policy?.maxTasksPerRun);
  const receipts: PrShepherdRunReceipt[] = [];
  let created = 0;

  for (const pr of prs) {
    const signals = signalsFor(pr);
    const receiptKey = receiptKeyFor(pr);
    if (signals.length === 0) {
      receipts.push({
        receiptKey,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url },
        signals,
        skipped: "no_signal",
        mergeDisabled: true,
      });
      continue;
    }
    if (created >= maxTasks) break;
    const receipt = await withReceiptLock(receiptKey, async () => {
      const existing = await findLiveTaskForReceipt(
        orchestrator,
        receiptKey,
        pr,
        schedule.projectId,
      );
      if (existing) {
        return {
          receiptKey,
          pr: {
            owner: pr.owner,
            repo: pr.repo,
            number: pr.number,
            url: pr.url,
          },
          signals,
          taskId: existing,
          skipped: "live_task_exists" as const,
          mergeDisabled: true as const,
        };
      }
      const receiptMetadata = {
        receiptKey,
        pr: {
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          url: pr.url,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
        },
        signals,
        mergeDisabled: true,
      };
      const task = await orchestrator.createTask({
        title: titleFor(pr),
        goal: buildGoal(pr, signals, schedule.policy),
        originalRequest: `Recurring pr-shepherd schedule ${record.taskId} fired at ${record.firedAtIso} for ${pr.url}.`,
        kind: "coding",
        priority: signals.includes("failed_checks") ? "high" : "normal",
        acceptanceCriteria: [
          "Inspect the pull request state and confirm the triggering signal still applies.",
          "Do not merge the pull request or enable any autonomous merge path.",
          "Record receipts for the PR URL, detected signal, checks reviewed, and any proposed or applied fix.",
        ],
        ...(schedule.ownerUserId ? { ownerUserId: schedule.ownerUserId } : {}),
        ...(schedule.projectId ? { projectId: schedule.projectId } : {}),
        ...(schedule.workdir ? { workdir: schedule.workdir } : {}),
        metadata: {
          source: "scheduled-pr-shepherd",
          scheduleTaskId: record.taskId,
          scheduleFiredAtIso: record.firedAtIso,
          prShepherdReceiptKey: receiptKey,
          codingAgentScheduleReceiptKey: receiptKey,
          prShepherdReceipt: receiptMetadata,
          pr: receiptMetadata.pr,
          signals,
          mergeDisabled: true,
          allowProposeFixes: schedule.policy?.allowProposeFixes === true,
        },
      });
      const taskId = typeof task.id === "string" ? task.id : undefined;
      return {
        receiptKey,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url },
        signals,
        ...(taskId ? { taskId } : {}),
        mergeDisabled: true as const,
      };
    });
    receipts.push(receipt);
    if (!receipt.skipped) created += 1;
  }

  return {
    scheduleTaskId: record.taskId,
    checked: prs.length,
    created,
    skipped: receipts.filter((r) => r.skipped).length,
    receipts,
  };
}

const receiptLocks = new Map<string, Promise<void>>();

async function withReceiptLock<T>(
  receiptKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  while (receiptLocks.has(receiptKey)) {
    await receiptLocks.get(receiptKey);
  }
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  receiptLocks.set(receiptKey, current);
  try {
    return await fn();
  } finally {
    if (receiptLocks.get(receiptKey) === current) {
      receiptLocks.delete(receiptKey);
    }
    release();
  }
}

export function createCodingAgentScheduleDispatcher(
  runtime: IAgentRuntime,
  options: CreateCodingAgentScheduleDispatcherOptions = {},
): ScheduledTaskDispatcher {
  const githubServiceType =
    options.githubServiceType ?? GITHUB_PR_SHEPHERD_SERVICE_TYPE;
  const orchestratorServiceType =
    options.orchestratorServiceType ?? ORCHESTRATOR_TASK_SERVICE_TYPE;
  return {
    async dispatch(record): Promise<DispatchResult | undefined> {
      const schedule = readPrShepherdMetadata(record.metadata);
      if (!schedule || record.channelKey !== PR_SHEPHERD_DISPATCH_CHANNEL) {
        return options.delegate?.dispatch(record);
      }
      const summary = await runPrShepherd({
        runtime,
        record,
        schedule,
        githubServiceType,
        orchestratorServiceType,
      });
      return {
        ok: true,
        messageId: `pr-shepherd:${record.taskId}:${record.firedAtIso}`,
        target: `checked:${summary.checked}:created:${summary.created}:skipped:${summary.skipped}`,
        metadata: {
          prShepherdRun: summary,
        },
      };
    },
  };
}

export function buildPrShepherdScheduleInput(args: {
  agentId: string;
  trigger: ScheduledTaskTrigger;
  ownerUserId?: string;
  projectId?: string;
  workdir?: string;
  repo?: string;
  policy?: PrShepherdSchedulePolicy;
  idempotencyKey?: string;
}): ScheduledTaskInput {
  const metadata: PrShepherdScheduleMetadata = {
    recipe: PR_SHEPHERD_RECIPE,
    ownerAgentId: args.agentId,
    ...(args.ownerUserId ? { ownerUserId: args.ownerUserId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workdir ? { workdir: args.workdir } : {}),
    ...(args.repo ? { repo: args.repo } : {}),
    ...(args.policy ? { policy: args.policy } : {}),
  };
  return {
    kind: "watcher",
    promptInstructions:
      "Run the pr-shepherd coding-agent recipe for assigned open pull requests.",
    trigger: args.trigger,
    priority: "medium",
    escalation: {
      steps: [
        {
          delayMinutes: 0,
          channelKey: PR_SHEPHERD_DISPATCH_CHANNEL,
        },
      ],
    },
    respectsGlobalPause: false,
    source: "plugin",
    createdBy: args.agentId,
    ownerVisible: false,
    idempotencyKey:
      args.idempotencyKey ??
      [
        "coding-agent-schedule",
        PR_SHEPHERD_RECIPE,
        args.agentId,
        args.ownerUserId ?? "agent-owner",
        args.projectId ?? "no-project",
        args.repo ?? "all-repositories",
      ].join(":"),
    metadata: {
      [CODING_AGENT_SCHEDULE_METADATA_KEY]: metadata,
    },
    executionProfile: "bg-heavy-fgs",
  };
}

function withPaused(
  task: ScheduledTask,
  paused: boolean,
): Partial<Omit<ScheduledTask, "taskId" | "state">> {
  const existing = readPrShepherdMetadata(task.metadata);
  if (!existing) {
    throw new Error(`task ${task.taskId} is not a coding-agent schedule`);
  }
  return {
    metadata: {
      ...(task.metadata ?? {}),
      [CODING_AGENT_SCHEDULE_METADATA_KEY]: {
        ...existing,
        paused,
      },
    },
  };
}

export async function pauseCodingAgentSchedule(
  runner: ScheduledTaskRunnerHandle,
  taskId: string,
): Promise<ScheduledTask> {
  const task = (await runner.list()).find(
    (candidate) => candidate.taskId === taskId,
  );
  if (!task) throw new Error(`task ${taskId} not found`);
  return runner.apply(taskId, "edit", withPaused(task, true));
}

export async function resumeCodingAgentSchedule(
  runner: ScheduledTaskRunnerHandle,
  taskId: string,
): Promise<ScheduledTask> {
  const task = (await runner.list()).find(
    (candidate) => candidate.taskId === taskId,
  );
  if (!task) throw new Error(`task ${taskId} not found`);
  return runner.apply(taskId, "edit", withPaused(task, false));
}

export async function deleteCodingAgentSchedule(
  store: { delete(taskId: string): Promise<void> },
  taskId: string,
): Promise<void> {
  await store.delete(taskId);
}
