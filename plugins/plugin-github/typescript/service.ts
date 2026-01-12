import { type IAgentRuntime, logger, type Metadata, Service } from "@elizaos/core";
import { Octokit } from "@octokit/rest";
import { type GitHubPluginConfig, validateGitHubConfig } from "./config";
import { FileNotFoundError } from "./error";
import type {
  CreateBranchParams,
  CreateCommentParams,
  CreateCommitParams,
  CreateIssueParams,
  CreatePullRequestParams,
  CreateReviewParams,
  GetFileParams,
  GitHubBranch,
  GitHubComment,
  GitHubCommit,
  GitHubDirectoryEntry,
  GitHubFileContent,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  GitHubReview,
  GitHubUser,
  IssueState,
  IssueStateReason,
  ListIssuesParams,
  ListPullRequestsParams,
  MergeableState,
  MergePullRequestParams,
  PullRequestState,
  RepositoryRef,
  ReviewState,
  UpdateIssueParams,
  UpdatePullRequestParams,
} from "./types";

export const GITHUB_SERVICE_NAME = "github";

export class GitHubService extends Service {
  static override serviceType = GITHUB_SERVICE_NAME;

  private octokit: Octokit | null = null;
  private _config: GitHubPluginConfig | null = null;

  declare config?: Metadata;

  capabilityDescription =
    "GitHub integration for repository management, issues, pull requests, and code reviews";

  get name(): string {
    return GITHUB_SERVICE_NAME;
  }

  getConfig(): GitHubPluginConfig {
    if (!this._config) {
      throw new Error("GitHub service not initialized");
    }
    return this._config;
  }

  private getClient(): Octokit {
    if (!this.octokit) {
      throw new Error("GitHub service not initialized");
    }
    return this.octokit;
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    logger.info("Starting GitHub service...");

    this._config = validateGitHubConfig(runtime);
    const settings = this._config.toSettings();
    this.config = {
      apiToken: settings.apiToken ?? "",
      owner: settings.owner ?? undefined,
      repo: settings.repo ?? undefined,
      branch: settings.branch ?? "main",
      webhookSecret: settings.webhookSecret ?? undefined,
      appId: settings.appId ?? undefined,
      appPrivateKey: settings.appPrivateKey ?? undefined,
      installationId: settings.installationId ?? undefined,
    };

    this.octokit = new Octokit({
      auth: this._config.apiToken,
      userAgent: "elizaos-plugin-github/1.0.0",
    });

    const { data: user } = await this.octokit.users.getAuthenticated();
    logger.info(`GitHub service started - authenticated as ${user.login}`);
  }

  override async stop(): Promise<void> {
    logger.info("Stopping GitHub service...");
    this.octokit = null;
    this._config = null;
    this.config = undefined;
    logger.info("GitHub service stopped");
  }

  async getRepository(params: RepositoryRef): Promise<GitHubRepository> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.repos.get({ owner, repo });
    return this.mapRepository(data);
  }

  async listRepositories(
    username?: string,
    options?: {
      type?: "all" | "owner" | "member";
      perPage?: number;
      page?: number;
    }
  ): Promise<GitHubRepository[]> {
    const client = this.getClient();

    const { data } = username
      ? await client.repos.listForUser({
          username,
          type: options?.type ?? "owner",
          per_page: options?.perPage ?? 30,
          page: options?.page ?? 1,
        })
      : await client.repos.listForAuthenticatedUser({
          type: options?.type ?? "all",
          per_page: options?.perPage ?? 30,
          page: options?.page ?? 1,
        });

    return data.map((r) => this.mapRepository(r));
  }

  async createIssue(params: CreateIssueParams): Promise<GitHubIssue> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.issues.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      assignees: params.assignees,
      labels: params.labels,
      milestone: params.milestone,
    });

    return this.mapIssue(data);
  }

  async getIssue(params: RepositoryRef & { issueNumber: number }): Promise<GitHubIssue> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.issues.get({
      owner,
      repo,
      issue_number: params.issueNumber,
    });

    return this.mapIssue(data);
  }

  async updateIssue(params: UpdateIssueParams): Promise<GitHubIssue> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.issues.update({
      owner,
      repo,
      issue_number: params.issueNumber,
      title: params.title,
      body: params.body,
      state: params.state,
      state_reason: params.stateReason,
      assignees: params.assignees,
      labels: params.labels,
      milestone: params.milestone ?? undefined,
    });

    return this.mapIssue(data);
  }

  async listIssues(params: ListIssuesParams): Promise<GitHubIssue[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.issues.listForRepo({
      owner,
      repo,
      state: params.state ?? "open",
      labels: params.labels,
      sort: params.sort ?? "created",
      direction: params.direction ?? "desc",
      assignee: params.assignee,
      creator: params.creator,
      mentioned: params.mentioned,
      per_page: params.perPage ?? 30,
      page: params.page ?? 1,
    });

    return data.filter((issue) => !issue.pull_request).map((issue) => this.mapIssue(issue));
  }

  async closeIssue(
    params: RepositoryRef & {
      issueNumber: number;
      reason?: "completed" | "not_planned";
    }
  ): Promise<GitHubIssue> {
    return this.updateIssue({
      ...params,
      state: "closed",
      stateReason: params.reason ?? "completed",
    });
  }

  async reopenIssue(params: RepositoryRef & { issueNumber: number }): Promise<GitHubIssue> {
    return this.updateIssue({
      ...params,
      state: "open",
      stateReason: "reopened",
    });
  }

  async createPullRequest(params: CreatePullRequestParams): Promise<GitHubPullRequest> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
      draft: params.draft,
      maintainer_can_modify: params.maintainerCanModify,
    });

    return this.mapPullRequest(data);
  }

  async getPullRequest(params: RepositoryRef & { pullNumber: number }): Promise<GitHubPullRequest> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.get({
      owner,
      repo,
      pull_number: params.pullNumber,
    });

    return this.mapPullRequest(data);
  }

  async updatePullRequest(params: UpdatePullRequestParams): Promise<GitHubPullRequest> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.update({
      owner,
      repo,
      pull_number: params.pullNumber,
      title: params.title,
      body: params.body,
      state: params.state,
      base: params.base,
      maintainer_can_modify: params.maintainerCanModify,
    });

    return this.mapPullRequest(data);
  }

  async listPullRequests(params: ListPullRequestsParams): Promise<GitHubPullRequest[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.list({
      owner,
      repo,
      state: params.state ?? "open",
      head: params.head,
      base: params.base,
      sort: params.sort ?? "created",
      direction: params.direction ?? "desc",
      per_page: params.perPage ?? 30,
      page: params.page ?? 1,
    });

    return data.map((pr) => this.mapPullRequest(pr));
  }

  async mergePullRequest(
    params: MergePullRequestParams
  ): Promise<{ sha: string; merged: boolean; message: string }> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.merge({
      owner,
      repo,
      pull_number: params.pullNumber,
      commit_title: params.commitTitle,
      commit_message: params.commitMessage,
      merge_method: params.mergeMethod ?? "merge",
      sha: params.sha,
    });

    return {
      sha: data.sha,
      merged: data.merged,
      message: data.message,
    };
  }

  async closePullRequest(
    params: RepositoryRef & { pullNumber: number }
  ): Promise<GitHubPullRequest> {
    return this.updatePullRequest({
      ...params,
      state: "closed",
    });
  }

  async createReview(params: CreateReviewParams): Promise<GitHubReview> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.createReview({
      owner,
      repo,
      pull_number: params.pullNumber,
      body: params.body,
      event: params.event,
      commit_id: params.commitId,
      comments: params.comments?.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
        side: c.side,
        start_line: c.startLine,
        start_side: c.startSide,
      })),
    });

    return this.mapReview(data);
  }

  async listReviews(params: RepositoryRef & { pullNumber: number }): Promise<GitHubReview[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.pulls.listReviews({
      owner,
      repo,
      pull_number: params.pullNumber,
    });

    return data.map((r) => this.mapReview(r));
  }

  async createComment(params: CreateCommentParams): Promise<GitHubComment> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.issues.createComment({
      owner,
      repo,
      issue_number: params.issueNumber,
      body: params.body,
    });

    return this.mapComment(data);
  }

  async listComments(
    params: RepositoryRef & {
      issueNumber: number;
      perPage?: number;
      page?: number;
    }
  ): Promise<GitHubComment[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.issues.listComments({
      owner,
      repo,
      issue_number: params.issueNumber,
      per_page: params.perPage ?? 30,
      page: params.page ?? 1,
    });

    return data.map((c) => this.mapComment(c));
  }

  async createBranch(params: CreateBranchParams): Promise<GitHubBranch> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    let sha: string;

    if (params.fromRef.match(/^[0-9a-f]{40}$/i)) {
      sha = params.fromRef;
    } else {
      const { data: refData } = await client.git.getRef({
        owner,
        repo,
        ref: `heads/${params.fromRef}`,
      });
      sha = refData.object.sha;
    }

    await client.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${params.branchName}`,
      sha,
    });

    return {
      name: params.branchName,
      sha,
      protected: false,
    };
  }

  async deleteBranch(params: RepositoryRef & { branchName: string }): Promise<void> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    await client.git.deleteRef({
      owner,
      repo,
      ref: `heads/${params.branchName}`,
    });
  }

  async listBranches(
    params: RepositoryRef & { perPage?: number; page?: number }
  ): Promise<GitHubBranch[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.repos.listBranches({
      owner,
      repo,
      per_page: params.perPage ?? 30,
      page: params.page ?? 1,
    });

    return data.map((b) => ({
      name: b.name,
      sha: b.commit.sha,
      protected: b.protected,
    }));
  }

  async getFile(params: GetFileParams): Promise<GitHubFileContent> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.repos.getContent({
      owner,
      repo,
      path: params.path,
      ref: params.branch,
    });

    if (Array.isArray(data)) {
      throw new FileNotFoundError(`${params.path} is a directory, not a file`, owner, repo);
    }

    if (data.type !== "file") {
      throw new FileNotFoundError(`${params.path} is not a file`, owner, repo);
    }

    let content = "";
    if ("content" in data && data.content) {
      content = Buffer.from(data.content, "base64").toString("utf-8");
    }

    return {
      name: data.name,
      path: data.path,
      content,
      sha: data.sha,
      size: data.size,
      type: data.type as "file",
      encoding: "encoding" in data ? (data.encoding ?? "base64") : "base64",
      htmlUrl: data.html_url ?? "",
      downloadUrl: data.download_url,
    };
  }

  async listDirectory(params: GetFileParams): Promise<GitHubDirectoryEntry[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    const { data } = await client.repos.getContent({
      owner,
      repo,
      path: params.path,
      ref: params.branch,
    });

    if (!Array.isArray(data)) {
      throw new FileNotFoundError(`${params.path} is a file, not a directory`, owner, repo);
    }

    return data.map((entry) => ({
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
      type: entry.type as "file" | "dir" | "symlink" | "submodule",
      htmlUrl: entry.html_url ?? "",
      downloadUrl: entry.download_url,
    }));
  }

  async createCommit(params: CreateCommitParams): Promise<GitHubCommit> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);

    let parentSha = params.parentSha;
    if (!parentSha) {
      const { data: refData } = await client.git.getRef({
        owner,
        repo,
        ref: `heads/${params.branch}`,
      });
      parentSha = refData.object.sha;
    }

    const { data: parentCommit } = await client.git.getCommit({
      owner,
      repo,
      commit_sha: parentSha,
    });

    const treeItems: Array<{
      path: string;
      mode: "100644" | "100755" | "040000" | "160000" | "120000";
      type: "blob" | "tree" | "commit";
      sha?: string;
    }> = [];

    for (const file of params.files) {
      if (file.operation === "delete") {
        continue;
      }

      const { data: blob } = await client.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: file.encoding ?? "utf-8",
      });

      treeItems.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    const { data: newTree } = await client.git.createTree({
      owner,
      repo,
      base_tree: parentCommit.tree.sha,
      tree: treeItems,
    });

    const { data: commit } = await client.git.createCommit({
      owner,
      repo,
      message: params.message,
      tree: newTree.sha,
      parents: [parentSha],
      author: params.authorName
        ? {
            name: params.authorName,
            email: params.authorEmail ?? `${params.authorName}@users.noreply.github.com`,
          }
        : undefined,
    });

    await client.git.updateRef({
      owner,
      repo,
      ref: `heads/${params.branch}`,
      sha: commit.sha,
    });

    return {
      sha: commit.sha,
      message: commit.message,
      author: {
        name: commit.author?.name ?? "Unknown",
        email: commit.author?.email ?? "",
        date: commit.author?.date ?? new Date().toISOString(),
      },
      committer: {
        name: commit.committer?.name ?? "Unknown",
        email: commit.committer?.email ?? "",
        date: commit.committer?.date ?? new Date().toISOString(),
      },
      timestamp: commit.author?.date ?? new Date().toISOString(),
      htmlUrl: commit.html_url,
      parents: commit.parents.map((p) => p.sha),
    };
  }

  async listCommits(
    params: RepositoryRef & {
      branch?: string;
      path?: string;
      perPage?: number;
      page?: number;
    }
  ): Promise<GitHubCommit[]> {
    const client = this.getClient();
    const { owner, repo } = this.resolveRepoRef(params);
    const branch = params.branch ?? this._config?.branch ?? "main";

    const { data } = await client.repos.listCommits({
      owner,
      repo,
      sha: branch,
      path: params.path,
      per_page: params.perPage ?? 30,
      page: params.page ?? 1,
    });

    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: {
        name: c.commit.author?.name ?? "Unknown",
        email: c.commit.author?.email ?? "",
        date: c.commit.author?.date ?? "",
      },
      committer: {
        name: c.commit.committer?.name ?? "Unknown",
        email: c.commit.committer?.email ?? "",
        date: c.commit.committer?.date ?? "",
      },
      timestamp: c.commit.author?.date ?? "",
      htmlUrl: c.html_url,
      parents: c.parents.map((p) => p.sha),
    }));
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    const client = this.getClient();

    const { data } = await client.users.getAuthenticated();
    return this.mapUser(data);
  }

  async getUser(username: string): Promise<GitHubUser> {
    const client = this.getClient();

    const { data } = await client.users.getByUsername({ username });
    return this.mapUser(data);
  }

  private resolveRepoRef(params: Partial<RepositoryRef>): {
    owner: string;
    repo: string;
  } {
    const owner = params.owner ?? this._config?.owner;
    const repo = params.repo ?? this._config?.repo;

    if (!owner || !repo) {
      throw new Error(
        "Repository owner and name are required. Configure defaults or provide them explicitly."
      );
    }

    return { owner, repo };
  }

  private mapRepository(data: unknown): GitHubRepository {
    const d = data as Record<string, unknown>;
    const license = d.license as Record<string, unknown> | null;
    return {
      id: d.id as number,
      name: d.name as string,
      fullName: d.full_name as string,
      owner: this.mapUser(d.owner),
      description: d.description as string | null,
      private: d.private as boolean,
      fork: d.fork as boolean,
      defaultBranch: d.default_branch as string,
      language: d.language as string | null,
      stargazersCount: d.stargazers_count as number,
      forksCount: d.forks_count as number,
      openIssuesCount: d.open_issues_count as number,
      watchersCount: d.watchers_count as number,
      htmlUrl: d.html_url as string,
      cloneUrl: d.clone_url as string,
      sshUrl: d.ssh_url as string,
      createdAt: d.created_at as string,
      updatedAt: d.updated_at as string,
      pushedAt: d.pushed_at as string,
      topics: (d.topics as string[]) ?? [],
      license: license
        ? {
            key: license.key as string,
            name: license.name as string,
            spdxId: license.spdx_id as string,
            url: license.url as string | null,
          }
        : null,
    };
  }

  private mapUser(data: unknown): GitHubUser {
    const d = data as Record<string, unknown>;
    return {
      id: d.id as number,
      login: d.login as string,
      name: (d.name as string | null) ?? null,
      avatarUrl: d.avatar_url as string,
      htmlUrl: d.html_url as string,
      type: d.type as "User" | "Organization" | "Bot",
    };
  }

  private mapIssue(data: unknown): GitHubIssue {
    const d = data as Record<string, unknown>;
    return {
      number: d.number as number,
      title: d.title as string,
      body: d.body as string | null,
      state: d.state as IssueState,
      stateReason: (d.state_reason as IssueStateReason | null) ?? null,
      user: this.mapUser(d.user),
      assignees: ((d.assignees as unknown[]) ?? []).map((a: unknown) => this.mapUser(a)),
      labels: ((d.labels as unknown[]) ?? []).map((l: unknown) => this.mapLabel(l)),
      milestone: d.milestone ? this.mapMilestone(d.milestone) : null,
      createdAt: d.created_at as string,
      updatedAt: d.updated_at as string,
      closedAt: d.closed_at as string | null,
      htmlUrl: d.html_url as string,
      comments: d.comments as number,
      isPullRequest: !!d.pull_request,
    };
  }

  private mapLabel(data: unknown): {
    id: number;
    name: string;
    color: string;
    description: string | null;
    default: boolean;
  } {
    if (typeof data === "string") {
      return {
        id: 0,
        name: data,
        color: "",
        description: null,
        default: false,
      };
    }
    const d = data as Record<string, unknown>;
    return {
      id: d.id as number,
      name: d.name as string,
      color: d.color as string,
      description: d.description as string | null,
      default: d.default as boolean,
    };
  }

  private mapMilestone(data: unknown): {
    number: number;
    title: string;
    description: string | null;
    state: "open" | "closed";
    dueOn: string | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    openIssues: number;
    closedIssues: number;
  } {
    const d = data as Record<string, unknown>;
    return {
      number: d.number as number,
      title: d.title as string,
      description: d.description as string | null,
      state: d.state as "open" | "closed",
      dueOn: d.due_on as string | null,
      createdAt: d.created_at as string,
      updatedAt: d.updated_at as string,
      closedAt: d.closed_at as string | null,
      openIssues: d.open_issues as number,
      closedIssues: d.closed_issues as number,
    };
  }

  private mapPullRequest(data: unknown): GitHubPullRequest {
    const d = data as Record<string, unknown>;
    const head = d.head as Record<string, unknown>;
    const base = d.base as Record<string, unknown>;
    const headRepo = head.repo as Record<string, unknown> | null;
    const baseRepo = base.repo as Record<string, unknown> | null;
    const headRepoOwner = headRepo?.owner as Record<string, unknown> | undefined;
    const baseRepoOwner = baseRepo?.owner as Record<string, unknown> | undefined;
    return {
      number: d.number as number,
      title: d.title as string,
      body: d.body as string | null,
      state: d.state as PullRequestState,
      draft: (d.draft as boolean) ?? false,
      merged: (d.merged as boolean) ?? false,
      mergeable: d.mergeable as boolean | null,
      mergeableState: (d.mergeable_state as MergeableState) ?? "unknown",
      user: this.mapUser(d.user),
      head: {
        ref: head.ref as string,
        label: head.label as string,
        sha: head.sha as string,
        repo: headRepo
          ? { owner: headRepoOwner?.login as string, repo: headRepo.name as string }
          : null,
      },
      base: {
        ref: base.ref as string,
        label: base.label as string,
        sha: base.sha as string,
        repo: baseRepo
          ? { owner: baseRepoOwner?.login as string, repo: baseRepo.name as string }
          : null,
      },
      assignees: ((d.assignees as unknown[]) ?? []).map((a: unknown) => this.mapUser(a)),
      requestedReviewers: ((d.requested_reviewers as unknown[]) ?? []).map((r: unknown) =>
        this.mapUser(r)
      ),
      labels: ((d.labels as unknown[]) ?? []).map((l: unknown) => this.mapLabel(l)),
      milestone: d.milestone ? this.mapMilestone(d.milestone) : null,
      createdAt: d.created_at as string,
      updatedAt: d.updated_at as string,
      closedAt: d.closed_at as string | null,
      mergedAt: d.merged_at as string | null,
      htmlUrl: d.html_url as string,
      commits: (d.commits as number) ?? 0,
      additions: (d.additions as number) ?? 0,
      deletions: (d.deletions as number) ?? 0,
      changedFiles: (d.changed_files as number) ?? 0,
    };
  }

  private mapReview(data: unknown): GitHubReview {
    const d = data as Record<string, unknown>;
    return {
      id: d.id as number,
      user: this.mapUser(d.user),
      body: d.body as string | null,
      state: d.state as ReviewState,
      commitId: d.commit_id as string,
      htmlUrl: d.html_url as string,
      submittedAt: d.submitted_at as string,
    };
  }

  private mapComment(data: unknown): GitHubComment {
    const d = data as Record<string, unknown>;
    return {
      id: d.id as number,
      body: d.body as string,
      user: this.mapUser(d.user),
      createdAt: d.created_at as string,
      updatedAt: d.updated_at as string,
      htmlUrl: d.html_url as string,
    };
  }
}
