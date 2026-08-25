/**
 * GitHub integration for Coding Workspace Service.
 *
 * Provides PAT/OAuth-backed GitHub access for issue management and the
 * pull-request ground-truth verifier. The verifier uses a typed request
 * transport owned by this module so callers never reach into dependency-private
 * Octokit fields.
 */

import { createRequire } from "node:module";
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { Octokit } from "@octokit/rest";
import type {
  CreateIssueOptions,
  GitHubPatClient as GitHubPatClientInstance,
  IssueComment,
  IssueInfo,
  IssueState,
} from "git-workspace-service";
import type {
  RemoteCheck,
  RemotePullRequest,
} from "./ground-truth-verifier.js";
import type { ParsedPullRequestLink } from "./pull-request-link.js";

const { GitHubPatClient, OAuthDeviceFlow } = createRequire(import.meta.url)(
  "git-workspace-service",
) as typeof import("git-workspace-service");

/**
 * Callback for surfacing auth prompts to the user.
 * Returns true only when the prompt was delivered through an immediate
 * user-visible channel. Buffered action callbacks are unsafe here because the
 * device flow blocks until the user sees and completes the prompt.
 */
export type AuthPromptCallback = (prompt: {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
}) => boolean | Promise<boolean>;

/**
 * Context object passed by CodingWorkspaceService into every GitHub function.
 * Lets us keep the extracted functions stateless while still mutating shared state.
 */
export interface GitHubContext {
  runtime: IAgentRuntime;
  githubClient: GitHubPatClientInstance | null;
  setGithubClient: (client: GitHubPatClientInstance) => void;
  githubRequest: GitHubRequest | null;
  setGithubRequest: (request: GitHubRequest | null) => void;
  githubAuthInProgress: Promise<GitHubPatClientInstance> | null;
  setGithubAuthInProgress: (p: Promise<GitHubPatClientInstance> | null) => void;
  authPromptCallback: AuthPromptCallback | null;
  log: (msg: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────

export function parseOwnerRepo(repo: string): {
  owner: string;
  repo: string;
} {
  // Handle URLs like https://github.com/owner/repo or owner/repo. GitHub
  // repository names may contain dots, so do not use a dot as a delimiter.
  const withoutHost = repo.trim().replace(/^https?:\/\/github\.com\//i, "");
  const query = withoutHost.indexOf("?");
  const fragment = withoutHost.indexOf("#");
  const suffixStart =
    query < 0 ? fragment : fragment < 0 ? query : Math.min(query, fragment);
  const normalized = (
    suffixStart < 0 ? withoutHost : withoutHost.slice(0, suffixStart)
  ).replace(/\.git$/, "");
  const parts = normalized.split("/");
  if (
    parts.length !== 2 ||
    parts[0].length > 100 ||
    parts[1].length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(parts[0]) ||
    !/^[a-zA-Z0-9_.-]+$/.test(parts[1])
  ) {
    throw new Error(`Cannot parse owner/repo from: ${repo}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

type GitHubResponse<T> = { data: T };
export type GitHubRequest = <T>(
  route: string,
  parameters: Record<string, unknown>,
) => Promise<GitHubResponse<T>>;

function createGitHubRequest(token: string): GitHubRequest {
  const octokit = new Octokit({ auth: token });
  return octokit.request.bind(octokit) as GitHubRequest;
}

// ── Auth ───────────────────────────────────────────────────────────

export async function ensureGitHubClient(
  ctx: GitHubContext,
): Promise<GitHubPatClientInstance> {
  // Already have a client
  if (ctx.githubClient) return ctx.githubClient;

  // Auth already in progress (another call triggered it) - wait for it
  if (ctx.githubAuthInProgress) return ctx.githubAuthInProgress;

  // Check for PAT (re-check in case it was set after init)
  const githubToken = ctx.runtime.getSetting("GITHUB_TOKEN") as
    | string
    | undefined;
  if (githubToken) {
    const client = new GitHubPatClient({ token: githubToken });
    const request = createGitHubRequest(githubToken);
    ctx.setGithubClient(client);
    ctx.setGithubRequest(request);
    ctx.log("GitHubPatClient initialized with PAT (late binding)");
    return client;
  }

  // Try OAuth device flow (explicit user consent, scoped permissions)
  const clientId = ctx.runtime.getSetting("GITHUB_OAUTH_CLIENT_ID") as
    | string
    | undefined;
  if (!clientId) {
    throw new Error(
      "GitHub access required but no credentials are configured. " +
        "Connect GitHub in Settings → Coding Agents (paste a personal access token, " +
        'or "Sign in with GitHub" when a GITHUB_OAUTH_CLIENT_ID is configured). ' +
        "Alternatively set the GITHUB_TOKEN setting for this agent.",
    );
  }

  // Start OAuth - deduplicate concurrent requests
  const authPromise = performOAuthFlow(ctx, clientId);
  ctx.setGithubAuthInProgress(authPromise);
  try {
    const client = await authPromise;
    return client;
  } finally {
    ctx.setGithubAuthInProgress(null);
  }
}

export async function performOAuthFlow(
  ctx: GitHubContext,
  clientId: string,
): Promise<GitHubPatClientInstance> {
  // Read directly from process.env — this is a server-side secret that
  // should not be exposed through the plugin getSetting() allowlist.
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const oauth = new OAuthDeviceFlow({
    clientId,
    clientSecret,
    permissions: {
      repositories: { type: "public" },
      contents: "write",
      issues: "write",
      pullRequests: "write",
      metadata: "read",
    },
    timeout: 300, // 5 minutes
  });

  // Step 1: Request device code
  const deviceCode = await oauth.requestDeviceCode();

  // Step 2: Surface the auth prompt to the user
  const delivered = ctx.authPromptCallback
    ? await ctx.authPromptCallback({
        verificationUri: deviceCode.verificationUri,
        userCode: deviceCode.userCode,
        expiresIn: deviceCode.expiresIn,
      })
    : false;

  if (!delivered) {
    throw new Error(
      "GitHub OAuth device flow requires an immediate chat delivery path before polling. " +
        "Wire an authPromptCallback, connect GitHub in Settings → Coding Agents, " +
        "or set the GITHUB_TOKEN setting.",
    );
  }

  // Step 3: Poll until user completes auth
  const token = await oauth.pollForToken(deviceCode);

  // Step 4: Create client with the obtained token
  const client = new GitHubPatClient({ token: token.accessToken });
  const request = createGitHubRequest(token.accessToken);
  ctx.setGithubClient(client);
  ctx.setGithubRequest(request);
  ctx.log("GitHubPatClient initialized via OAuth device flow");
  return client;
}

// ── Pull-request ground truth ──────────────────────────────────────

async function pagedGitHubRequest<T>(
  request: GitHubRequest,
  route: string,
  parameters: Record<string, unknown>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request<T[]>(route, {
      ...parameters,
      per_page: 100,
      page,
    });
    if (!Array.isArray(response.data)) {
      throw new ElizaError("GitHub paged endpoint returned a non-array body", {
        code: "GITHUB_PAGED_RESPONSE_INVALID",
        context: { route, page },
      });
    }
    rows.push(...response.data);
    if (response.data.length < 100) return rows;
  }
}

function githubErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isUnavailableStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

function unavailableError(
  message: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(message, {
    code: "GITHUB_GROUND_TRUTH_UNAVAILABLE",
    context,
  });
}

interface RequiredStatusCheck {
  context: string;
  appId?: number | null;
}

function requiredKey(check: RequiredStatusCheck): string {
  return `${check.context}\u0000${check.appId ?? "any"}`;
}

function isRequiredCheck(
  check: { name: string; appId?: number | null },
  required: readonly RequiredStatusCheck[],
): boolean {
  return required.some(
    (item) =>
      item.context === check.name &&
      (item.appId === undefined ||
        item.appId === null ||
        item.appId === check.appId),
  );
}

function dedupeRequired(
  checks: readonly RequiredStatusCheck[],
): RequiredStatusCheck[] {
  const seen = new Set<string>();
  const out: RequiredStatusCheck[] = [];
  for (const check of checks) {
    if (!check.context.trim()) continue;
    const key = requiredKey(check);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out;
}

async function fetchRequiredChecks(
  request: GitHubRequest,
  input: { owner: string; repo: string; branch: string },
): Promise<{ checks: RequiredStatusCheck[]; unavailableReason?: string }> {
  const checks: RequiredStatusCheck[] = [];
  let unavailableReason: string | undefined;
  try {
    const protection = (
      await request<{
        required_status_checks?: {
          contexts?: string[];
          checks?: Array<{ context: string; app_id?: number | null }>;
        } | null;
      }>("GET /repos/{owner}/{repo}/branches/{branch}/protection", input)
    ).data;
    checks.push(
      ...(protection.required_status_checks?.contexts ?? []).map((context) => ({
        context,
      })),
      ...(protection.required_status_checks?.checks ?? []).map((check) => ({
        context: check.context,
        appId: check.app_id,
      })),
    );
  } catch (error) {
    const status = githubErrorStatus(error);
    if (status === 401 || status === 403) {
      unavailableReason = `branch protection unavailable (${status})`;
    } else if (status !== 404) {
      throw error;
    }
  }

  try {
    const rules = await pagedGitHubRequest<{
      type?: string;
      parameters?: {
        required_status_checks?: Array<{
          context: string;
          integration_id?: number | null;
        }>;
      };
    }>(request, "GET /repos/{owner}/{repo}/rules/branches/{branch}", input);
    for (const rule of rules) {
      if (rule.type !== "required_status_checks") continue;
      for (const check of rule.parameters?.required_status_checks ?? []) {
        checks.push({
          context: check.context,
          appId: check.integration_id,
        });
      }
    }
  } catch (error) {
    const status = githubErrorStatus(error);
    if (!isUnavailableStatus(status)) throw error;
  }

  const deduped = dedupeRequired(checks);
  return {
    checks: deduped,
    ...(deduped.length === 0 && unavailableReason ? { unavailableReason } : {}),
  };
}

/**
 * Fetch the PR, exact changed-file list, head-SHA check rollup, and required
 * status-check names using the CodingWorkspaceService's authenticated GitHub
 * client. A 404 for the PR is a real "missing" result; all other API errors
 * propagate so the verifier can record an inconclusive verdict.
 */
export async function getPullRequestGroundTruth(
  ctx: GitHubContext,
  link: ParsedPullRequestLink,
): Promise<RemotePullRequest | null> {
  await ensureGitHubClient(ctx);
  const request = ctx.githubRequest;
  if (!request) {
    throw unavailableError(
      "GitHub ground-truth request transport is unavailable",
      { repo: link.repo, pullNumber: link.number },
    );
  }
  const { owner, repo } = parseOwnerRepo(link.repo);

  type PullResponse = {
    html_url: string;
    state: "open" | "closed";
    merged_at: string | null;
    head: { sha: string };
    base: { ref: string };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let pull: PullResponse;
    try {
      pull = (
        await request<PullResponse>(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          {
            owner,
            repo,
            pull_number: link.number,
          },
        )
      ).data;
    } catch (error) {
      if (githubErrorStatus(error) === 404) return null;
      throw error;
    }

    const files = await pagedGitHubRequest<{ filename: string }>(
      request,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: link.number },
    );
    type CheckRunResponse = {
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        app?: { id?: number | null } | null;
      }>;
    };
    const checkRuns: CheckRunResponse["check_runs"] = [];
    let checksUnavailableReason: string | undefined;
    try {
      for (let page = 1; ; page += 1) {
        const response = (
          await request<CheckRunResponse>(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            { owner, repo, ref: pull.head.sha, per_page: 100, page },
          )
        ).data.check_runs;
        checkRuns.push(...response);
        if (response.length < 100) break;
      }
    } catch (error) {
      const status = githubErrorStatus(error);
      if (!isUnavailableStatus(status)) throw error;
      checksUnavailableReason = `check runs unavailable (${status})`;
    }
    let combinedStatus: { statuses: Array<{ context: string; state: string }> };
    try {
      combinedStatus = (
        await request<{
          statuses: Array<{ context: string; state: string }>;
        }>("GET /repos/{owner}/{repo}/commits/{ref}/status", {
          owner,
          repo,
          ref: pull.head.sha,
          per_page: 100,
        })
      ).data;
    } catch (error) {
      const status = githubErrorStatus(error);
      if (!isUnavailableStatus(status)) throw error;
      checksUnavailableReason = [
        checksUnavailableReason,
        `commit statuses unavailable (${status})`,
      ]
        .filter(Boolean)
        .join("; ");
      combinedStatus = { statuses: [] };
    }

    const required = await fetchRequiredChecks(request, {
      owner,
      repo,
      branch: pull.base.ref,
    });
    checksUnavailableReason = [
      checksUnavailableReason,
      required.unavailableReason,
    ]
      .filter(Boolean)
      .join("; ");

    const freshPull = (
      await request<PullResponse>(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner,
          repo,
          pull_number: link.number,
        },
      )
    ).data;
    if (freshPull.head.sha !== pull.head.sha) {
      if (attempt === 0) continue;
      throw new ElizaError(
        "Pull request head changed while collecting ground truth",
        {
          code: "GITHUB_GROUND_TRUTH_HEAD_CHANGED",
          context: { owner, repo, pullNumber: link.number },
        },
      );
    }

    const checks: RemoteCheck[] = [
      ...checkRuns.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        appId: check.app?.id ?? null,
        required: isRequiredCheck(
          { name: check.name, appId: check.app?.id ?? null },
          required.checks,
        ),
      })),
      ...combinedStatus.statuses.map((status) => ({
        name: status.context,
        status: status.state === "pending" ? "in_progress" : "completed",
        conclusion:
          status.state === "success"
            ? "success"
            : status.state === "pending"
              ? null
              : "failure",
        required: isRequiredCheck({ name: status.context }, required.checks),
      })),
    ];
    for (const item of required.checks) {
      const satisfied = checks.some((check) =>
        isRequiredCheck({ name: check.name, appId: check.appId }, [item]),
      );
      if (!satisfied) {
        checks.push({
          name: item.context,
          appId: item.appId,
          status: "queued",
          conclusion: null,
          required: true,
        });
      }
    }

    return {
      url: freshPull.html_url,
      state: freshPull.merged_at ? "merged" : freshPull.state,
      headSha: freshPull.head.sha,
      changedFiles: files.map((file) => file.filename),
      checks,
      checksUnavailable: Boolean(checksUnavailableReason),
      ...(checksUnavailableReason ? { checksUnavailableReason } : {}),
    };
  }

  throw unavailableError("Pull request head changed during verification", {
    repo: link.repo,
    pullNumber: link.number,
  });
}

// ── Issue Management ───────────────────────────────────────────────

export async function createIssue(
  ctx: GitHubContext,
  repo: string,
  options: CreateIssueOptions,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  const issue = await client.createIssue(owner, repoName, options);
  ctx.log(`Created issue #${issue.number}: ${issue.title}`);
  return issue;
}

export async function getIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.getIssue(owner, repoName, issueNumber);
}

export async function listIssues(
  ctx: GitHubContext,
  repo: string,
  options?: {
    state?: IssueState | "all";
    labels?: string[];
    assignee?: string;
  },
): Promise<IssueInfo[]> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.listIssues(owner, repoName, options);
}

export async function updateIssue(
  ctx: GitHubContext,
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
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.updateIssue(owner, repoName, issueNumber, options);
}

export async function addComment(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<IssueComment> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.addComment(owner, repoName, issueNumber, { body });
}

export async function listComments(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.listComments(owner, repoName, issueNumber);
}

export async function closeIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  const issue = await client.closeIssue(owner, repoName, issueNumber);
  ctx.log(`Closed issue #${issueNumber}`);
  return issue;
}

export async function reopenIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.reopenIssue(owner, repoName, issueNumber);
}

export async function addLabels(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  await client.addLabels(owner, repoName, issueNumber, labels);
  const issue = await client.getIssue(owner, repoName, issueNumber);
  const observed = new Set(issue.labels.map((label) => label.toLowerCase()));
  const missing = labels.filter((label) => !observed.has(label.toLowerCase()));
  if (missing.length > 0) {
    throw new ElizaError("GitHub label write was not visible on readback", {
      code: "GITHUB_LABEL_READBACK_MISMATCH",
      context: { repo, issueNumber, requested: labels, observed: issue.labels },
    });
  }
  return issue;
}
