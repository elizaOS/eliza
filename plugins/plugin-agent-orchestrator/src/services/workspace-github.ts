/**
 * GitHub integration for Coding Workspace Service
 *
 * Extracted from workspace-service.ts — provides GitHub API access
 * via PAT or OAuth device flow, plus all issue management operations.
 *
 * @module services/workspace-github
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type CreateIssueOptions,
  GitHubPatClient,
  type IssueComment,
  type IssueInfo,
  type IssueState,
  OAuthDeviceFlow,
} from "git-workspace-service";

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
  githubClient: GitHubPatClient | null;
  setGithubClient: (client: GitHubPatClient) => void;
  githubAuthInProgress: Promise<GitHubPatClient> | null;
  setGithubAuthInProgress: (p: Promise<GitHubPatClient> | null) => void;
  authPromptCallback: AuthPromptCallback | null;
  log: (msg: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────

export function parseOwnerRepo(repo: string): {
  owner: string;
  repo: string;
} {
  // Handle URLs like https://github.com/owner/repo or owner/repo
  const match = repo.match(/(?:github\.com\/)?([^/]+)\/([^/.]+)/);
  if (!match) {
    throw new Error(`Cannot parse owner/repo from: ${repo}`);
  }
  return { owner: match[1], repo: match[2] };
}

// ── Auth ───────────────────────────────────────────────────────────

export async function ensureGitHubClient(
  ctx: GitHubContext,
): Promise<GitHubPatClient> {
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
    ctx.setGithubClient(client);
    ctx.log("GitHubPatClient initialized with PAT (late binding)");
    return client;
  }

  // Try OAuth device flow (explicit user consent, scoped permissions)
  const clientId = ctx.runtime.getSetting("GITHUB_OAUTH_CLIENT_ID") as
    | string
    | undefined;
  if (!clientId) {
    throw new Error(
      "GitHub access required but no credentials available. " +
        "Set GITHUB_TOKEN (PAT) or GITHUB_OAUTH_CLIENT_ID (for OAuth device flow).",
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
): Promise<GitHubPatClient> {
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
        "Wire the SwarmCoordinator chat callback or set GITHUB_TOKEN.",
    );
  }

  // Step 3: Poll until user completes auth
  const token = await oauth.pollForToken(deviceCode);

  // Step 4: Create client with the obtained token
  const client = new GitHubPatClient({ token: token.accessToken });
  ctx.setGithubClient(client);
  ctx.log("GitHubPatClient initialized via OAuth device flow");
  return client;
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
): Promise<void> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  await client.addLabels(owner, repoName, issueNumber, labels);
}
