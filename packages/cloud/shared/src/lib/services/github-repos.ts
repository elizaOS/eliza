// Coordinates cloud service github repos behavior behind route handlers.
import { computeBackoffMs } from "@elizaos/cloud-services-common/transport";
import { Octokit } from "@octokit/rest";
import { logger } from "../utils/logger";

/**
 * GitHub Repository Service
 *
 * Manages app repositories in a private GitHub organization.
 * Each app = one private repo, enabling:
 * - Version control via git commits
 * - Easy restore by cloning
 * - No need for custom snapshot storage
 */

const GITHUB_ORG = process.env.GITHUB_ORG_NAME || "eliza-cloud-apps";
const TEMPLATE_REPO = process.env.GITHUB_TEMPLATE_REPO || "eliza-cloud-apps/cloud-apps-template";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
/**
 * Longest wait this caller sleeps. A stated rate-limit wait above it is not
 * retried: the request is not replayed before GitHub's window, and the caller
 * receives GitHub's rate-limit error with the wait still in its headers.
 */
const MAX_DELAY_MS = 60_000;

// Singleton Octokit instance
let octokitInstance: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = process.env.GITHUB_APP_TOKEN || process.env.GIT_ACCESS_TOKEN;
    if (!token) {
      throw new Error(
        "GitHub token not configured. Set GITHUB_APP_TOKEN or GIT_ACCESS_TOKEN environment variable.",
      );
    }
    octokitInstance = new Octokit({ auth: token });
  }
  return octokitInstance;
}

interface GitHubRetryPolicy {
  /**
   * Whether an operation whose outcome is unknown (a 5xx or a dropped
   * connection) may run again. A repository creation must not: GitHub may
   * have created the repository before the error, and a replay fails with
   * "name already exists" while the repository exists unrecorded.
   */
  replayUnknownOutcome?: boolean;
}

interface GitHubRetryDeps {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const defaultRetryDeps: GitHubRetryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** The rate-limit wait GitHub states on a 429 or 403, in seconds, or null when it states none. */
function rateLimitRetryAfter(error: unknown, nowMs: number): string | null {
  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  if (!headers) return null;
  const retryAfter = headers["retry-after"];
  if (typeof retryAfter === "string" || typeof retryAfter === "number") return String(retryAfter);
  const remaining = headers["x-ratelimit-remaining"];
  const reset = Number(headers["x-ratelimit-reset"]);
  if (String(remaining) === "0" && Number.isFinite(reset)) {
    return String(Math.max(0, reset - Math.floor(nowMs / 1000)));
  }
  return null;
}

/**
 * Retry wrapper for GitHub calls. A 429, or a 403 that carries a rate-limit
 * wait, is retried after exactly the wait GitHub states (docs: "Exceeding the
 * rate limit", `retry-after` or `x-ratelimit-reset`) when that wait is at most
 * MAX_DELAY_MS; a longer stated wait is never shortened, so the call is not
 * retried and GitHub's error is thrown. A 5xx or a dropped connection is
 * retried with exponential backoff unless the policy forbids replaying an
 * unknown outcome. A 403 without a stated wait (missing scope, SAML) and every
 * other 4xx are not retried.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  policy: GitHubRetryPolicy = {},
  deps: GitHubRetryDeps = defaultRetryDeps,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const status = (error as { status?: number }).status;
      const retryAfter = rateLimitRetryAfter(error, Date.now());
      const rateLimited = status === 429 || (status === 403 && retryAfter !== null);
      const unknownOutcome = status === undefined || status >= 500;

      if (
        attempt < MAX_RETRIES - 1 &&
        (rateLimited || (unknownOutcome && policy.replayUnknownOutcome !== false))
      ) {
        const delay = computeBackoffMs({
          attempt,
          baseDelayMs: INITIAL_DELAY_MS,
          // The stated wait is read in full; the bound is applied below.
          capMs: rateLimited ? Number.POSITIVE_INFINITY : MAX_DELAY_MS,
          retryAfter: rateLimited ? retryAfter : null,
          random: deps.random,
        });
        if (delay > MAX_DELAY_MS) {
          logger.warn(`GitHub API ${context} is rate limited beyond the retry bound; not retried`, {
            status,
            statedWaitMs: delay,
            maxDelayMs: MAX_DELAY_MS,
          });
          throw error;
        }
        logger.warn(`GitHub API ${context} failed, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          status,
          error: lastError.message,
        });
        await deps.sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

export interface CreateRepoOptions {
  /** Unique name for the repo (e.g., app-{appId}) */
  name: string;
  /** Description for the repo */
  description?: string;
  /** Whether to make it private (default: true) */
  isPrivate?: boolean;
}

export interface RepoInfo {
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

/**
 * Create a new repository from the template
 */
export async function createAppRepo(options: CreateRepoOptions): Promise<RepoInfo> {
  const octokit = getOctokit();
  const { name, description, isPrivate = true } = options;

  logger.info("Creating app repository from template", {
    name,
    template: TEMPLATE_REPO,
    org: GITHUB_ORG,
  });

  return withRetry(
    async () => {
      // Create repo from template
      const [templateOwner, templateRepoName] = TEMPLATE_REPO.split("/");

      const response = await octokit.repos.createUsingTemplate({
        template_owner: templateOwner,
        template_repo: templateRepoName,
        owner: GITHUB_ORG,
        name,
        description: description || `ElizaCloud App: ${name}`,
        private: isPrivate,
        include_all_branches: false,
      });

      const repo = response.data;

      logger.info("App repository created", {
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
      });

      return {
        name: repo.name,
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        defaultBranch: repo.default_branch,
        isPrivate: repo.private,
        createdAt: repo.created_at,
      };
    },
    `createAppRepo(${name})`,
    // GitHub may have created the repository before a 5xx reached us.
    { replayUnknownOutcome: false },
  );
}

/**
 * Get repository info
 */
export async function getRepoInfo(repoName: string): Promise<RepoInfo | null> {
  const octokit = getOctokit();

  try {
    const response = await withRetry(
      () => octokit.repos.get({ owner: GITHUB_ORG, repo: repoName }),
      `getRepoInfo(${repoName})`,
    );

    const repo = response.data;
    return {
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      sshUrl: repo.ssh_url,
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
      createdAt: repo.created_at,
    };
  } catch (error: unknown) {
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a repository
 */
export async function deleteAppRepo(repoName: string): Promise<void> {
  const octokit = getOctokit();

  logger.info("Deleting app repository", { repoName, org: GITHUB_ORG });

  await withRetry(async () => {
    await octokit.repos.delete({
      owner: GITHUB_ORG,
      repo: repoName,
    });

    logger.info("App repository deleted", { repoName });
  }, `deleteAppRepo(${repoName})`);
}

/**
 * List commits for a repository
 */
export async function listCommits(
  repoName: string,
  options?: { branch?: string; limit?: number },
): Promise<CommitInfo[]> {
  const octokit = getOctokit();
  const { branch, limit = 20 } = options || {};

  return withRetry(async () => {
    const response = await octokit.repos.listCommits({
      owner: GITHUB_ORG,
      repo: repoName,
      sha: branch,
      per_page: limit,
    });

    return response.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author?.name || "Unknown",
      date: commit.commit.author?.date || "",
      url: commit.html_url,
    }));
  }, `listCommits(${repoName})`);
}

/**
 * Get the authenticated clone URL with token embedded
 * Used for cloning private repos in sandboxes
 */
export function getAuthenticatedCloneUrl(repoName: string): string {
  const token = process.env.GITHUB_APP_TOKEN || process.env.GIT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("GitHub token not configured");
  }
  return `https://x-access-token:${token}@github.com/${GITHUB_ORG}/${repoName}.git`;
}

/**
 * Get git credentials for sandbox commands
 */
export function getGitCredentials(): { username: string; password: string } {
  const token = process.env.GITHUB_APP_TOKEN || process.env.GIT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("GitHub token not configured");
  }
  return {
    username: "x-access-token",
    password: token,
  };
}

/**
 * Generate a unique repo name for an app
 */
export function generateRepoName(appId: string, appSlug?: string): string {
  // Use slug if available for readability, otherwise use app ID
  const base = appSlug || appId;
  // Ensure valid GitHub repo name (lowercase, alphanumeric, hyphens)
  return `app-${base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 50)}`;
}

/**
 * Check if the GitHub service is properly configured
 */
export async function checkGitHubConfig(): Promise<{
  configured: boolean;
  org: string;
  template: string;
  error?: string;
}> {
  try {
    const octokit = getOctokit();

    // Try to get org info
    await octokit.orgs.get({ org: GITHUB_ORG });

    // Try to get template repo
    const [templateOwner, templateRepoName] = TEMPLATE_REPO.split("/");
    await octokit.repos.get({ owner: templateOwner, repo: templateRepoName });

    return {
      configured: true,
      org: GITHUB_ORG,
      template: TEMPLATE_REPO,
    };
  } catch (error) {
    return {
      configured: false,
      org: GITHUB_ORG,
      template: TEMPLATE_REPO,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export const githubReposService = {
  createAppRepo,
  getRepoInfo,
  deleteAppRepo,
  listCommits,
  getAuthenticatedCloneUrl,
  getGitCredentials,
  generateRepoName,
  checkGitHubConfig,
};
