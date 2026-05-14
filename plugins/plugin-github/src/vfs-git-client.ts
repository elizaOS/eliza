import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type GitHubAccountSelection,
  readGitHubAccounts,
  readGitHubAccountsWithConnectorCredentials,
  resolveGitHubAccount,
} from "./accounts.js";

const VIRTUAL_GIT_ROOT = ".vfs-git";
const INDEX_PATH = `${VIRTUAL_GIT_ROOT}/index.json`;
const HEAD_PATH = `${VIRTUAL_GIT_ROOT}/HEAD`;

export type VfsGitStatus = "added" | "deleted" | "modified" | "unchanged";
export type VfsGitAuthSource = "eliza-cloud-oauth" | "none" | "pat";

export interface VfsGitFilesystemFile {
  path: string;
  bytes: Uint8Array;
}

export interface VfsGitFilesystem {
  initialize?: () => Promise<void>;
  exportFiles: () => Promise<VfsGitFilesystemFile[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, contents: string | Uint8Array) => Promise<unknown>;
  delete?: (path: string) => Promise<unknown>;
}

export interface VfsGitStatusEntry {
  path: string;
  status: VfsGitStatus;
  sha256?: string;
  previousSha256?: string;
}

export interface VfsGitCommitOptions {
  message: string;
  author?: {
    name?: string;
    email?: string;
  };
}

export interface VfsGitCommit {
  id: string;
  parent: string | null;
  message: string;
  author: {
    name: string;
    email: string;
  };
  committedAt: string;
  tree: Record<string, string>;
}

export interface VfsGitAuth {
  source: VfsGitAuthSource;
  token: string | null;
  accountId?: string;
  role?: string;
}

export interface VfsGitRemoteOptions {
  owner: string;
  repo: string;
  branch?: string;
  auth: Pick<VfsGitAuth, "token">;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface VfsGitPushOptions extends VfsGitRemoteOptions {
  message: string;
  author?: {
    name?: string;
    email?: string;
  };
}

export interface VfsGitPullOptions extends VfsGitRemoteOptions {
  reset?: boolean;
  commitMessage?: string;
}

export interface VfsGitPushResult {
  branch: string;
  commitSha: string;
  localCommit: VfsGitCommit;
  changedFiles: number;
}

export interface VfsGitPullResult {
  branch: string;
  commitSha: string;
  filesWritten: number;
  filesDeleted: number;
  localCommit: VfsGitCommit;
}

type VfsGitIndex = Record<string, string>;
type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

interface GitHubRefResponse {
  object: {
    sha: string;
  };
}

interface GitHubCommitResponse {
  sha: string;
  tree: {
    sha: string;
  };
}

interface GitHubTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string | null;
}

interface GitHubTreeResponse {
  sha: string;
  tree: GitHubTreeEntry[];
}

interface GitHubBlobResponse {
  sha: string;
  content: string;
  encoding: string;
}

export class VirtualGitClient {
  constructor(private readonly fs: VfsGitFilesystem) {}

  async status(): Promise<VfsGitStatusEntry[]> {
    await this.fs.initialize?.();
    const [current, index] = await Promise.all([
      this.currentTree(),
      this.readIndex(),
    ]);
    const paths = new Set([...Object.keys(current), ...Object.keys(index)]);
    return [...paths]
      .sort((left, right) => left.localeCompare(right))
      .map((path) => {
        const sha256 = current[path];
        const previousSha256 = index[path];
        return {
          path,
          status: statusFor(sha256, previousSha256),
          ...(sha256 ? { sha256 } : {}),
          ...(previousSha256 ? { previousSha256 } : {}),
        };
      });
  }

  async commit(options: VfsGitCommitOptions): Promise<VfsGitCommit> {
    await this.fs.initialize?.();
    const tree = await this.currentTree();
    const parent = await this.readHead();
    const commit: VfsGitCommit = {
      id: commitId(parent, options.message, tree),
      parent,
      message: options.message,
      author: {
        name: options.author?.name?.trim() || "eliza",
        email: options.author?.email?.trim() || "eliza@local",
      },
      committedAt: new Date().toISOString(),
      tree,
    };
    await this.fs.writeFile(
      `${VIRTUAL_GIT_ROOT}/commits/${commit.id}.json`,
      `${JSON.stringify(commit, null, 2)}\n`,
    );
    await this.fs.writeFile(INDEX_PATH, `${JSON.stringify(tree, null, 2)}\n`);
    await this.fs.writeFile(HEAD_PATH, `${commit.id}\n`);
    return commit;
  }

  async log(limit = 20): Promise<VfsGitCommit[]> {
    const commits: VfsGitCommit[] = [];
    let next = await this.readHead();
    while (next && commits.length < limit) {
      const commit = await this.readCommit(next);
      if (!commit) break;
      commits.push(commit);
      next = commit.parent;
    }
    return commits;
  }

  async pushToGitHub(options: VfsGitPushOptions): Promise<VfsGitPushResult> {
    await this.fs.initialize?.();
    const branch = options.branch ?? "main";
    const gitHub = new GitHubGitDatabaseClient(options);
    const ref = await gitHub.getRef(branch);
    const baseCommit = await gitHub.getCommit(ref.object.sha);
    const baseTree = await gitHub.getTree(baseCommit.tree.sha);
    const currentFiles = await this.currentFiles();
    const currentPaths = new Set(currentFiles.map((file) => file.path));
    const treeEntries: GitHubTreeEntry[] = [];

    for (const file of currentFiles) {
      const blob = await gitHub.createBlob(file.bytes);
      treeEntries.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    for (const remoteFile of baseTree.tree) {
      if (
        remoteFile.type === "blob" &&
        remoteFile.path &&
        !currentPaths.has(remoteFile.path)
      ) {
        treeEntries.push({
          path: remoteFile.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    }

    const tree = await gitHub.createTree(baseCommit.tree.sha, treeEntries);
    const commit = await gitHub.createCommit({
      message: options.message,
      tree: tree.sha,
      parents: [baseCommit.sha],
      author: options.author,
    });
    await gitHub.updateRef(branch, commit.sha);
    const localCommit = await this.commit({
      message: options.message,
      author: options.author,
    });
    return {
      branch,
      commitSha: commit.sha,
      localCommit,
      changedFiles: treeEntries.length,
    };
  }

  async pullFromGitHub(options: VfsGitPullOptions): Promise<VfsGitPullResult> {
    await this.fs.initialize?.();
    const branch = options.branch ?? "main";
    const gitHub = new GitHubGitDatabaseClient(options);
    const ref = await gitHub.getRef(branch);
    const commit = await gitHub.getCommit(ref.object.sha);
    const tree = await gitHub.getTree(commit.tree.sha);
    const remoteFiles = tree.tree.filter(
      (entry) => entry.type === "blob" && entry.path && entry.sha,
    );
    const remotePaths = new Set(remoteFiles.map((entry) => entry.path ?? ""));
    let filesDeleted = 0;

    if (options.reset !== false && this.fs.delete) {
      for (const file of await this.currentFiles()) {
        if (!remotePaths.has(file.path)) {
          await this.fs.delete(file.path);
          filesDeleted += 1;
        }
      }
    }

    for (const entry of remoteFiles) {
      const blob = await gitHub.getBlob(requiredString(entry.sha));
      await this.fs.writeFile(requiredString(entry.path), decodeBlob(blob));
    }

    const localCommit = await this.commit({
      message: options.commitMessage ?? `pull ${options.owner}/${options.repo}`,
    });
    return {
      branch,
      commitSha: commit.sha,
      filesWritten: remoteFiles.length,
      filesDeleted,
      localCommit,
    };
  }

  private async currentTree(): Promise<VfsGitIndex> {
    const files = await this.currentFiles();
    const tree: VfsGitIndex = {};
    for (const file of files) {
      tree[file.path] = sha256(file.bytes);
    }
    return tree;
  }

  private async currentFiles(): Promise<
    Array<{ path: string; bytes: Uint8Array }>
  > {
    const files = await this.fs.exportFiles();
    return files
      .map((file) => ({
        path: normalizeVfsPath(file.path),
        bytes: file.bytes,
      }))
      .filter((file) => !file.path.startsWith(`${VIRTUAL_GIT_ROOT}/`));
  }

  private async readIndex(): Promise<VfsGitIndex> {
    return (await this.readJson<VfsGitIndex>(INDEX_PATH)) ?? {};
  }

  private async readHead(): Promise<string | null> {
    try {
      const value = (await this.fs.readFile(HEAD_PATH)).trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private async readCommit(id: string): Promise<VfsGitCommit | null> {
    return await this.readJson<VfsGitCommit>(
      `${VIRTUAL_GIT_ROOT}/commits/${id}.json`,
    );
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await this.fs.readFile(path)) as T;
    } catch {
      return null;
    }
  }
}

class GitHubGitDatabaseClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: VfsGitRemoteOptions) {
    if (!options.auth.token) {
      throw new Error("VFS git remote sync requires GitHub auth");
    }
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getRef(branch: string): Promise<GitHubRefResponse> {
    return await this.request<GitHubRefResponse>(
      `/repos/${this.repoPath()}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
  }

  async getCommit(sha: string): Promise<GitHubCommitResponse> {
    return await this.request<GitHubCommitResponse>(
      `/repos/${this.repoPath()}/git/commits/${sha}`,
    );
  }

  async getTree(sha: string): Promise<GitHubTreeResponse> {
    return await this.request<GitHubTreeResponse>(
      `/repos/${this.repoPath()}/git/trees/${sha}?recursive=1`,
    );
  }

  async getBlob(sha: string): Promise<GitHubBlobResponse> {
    return await this.request<GitHubBlobResponse>(
      `/repos/${this.repoPath()}/git/blobs/${sha}`,
    );
  }

  async createBlob(bytes: Uint8Array): Promise<{ sha: string }> {
    return await this.request<{ sha: string }>(
      `/repos/${this.repoPath()}/git/blobs`,
      {
        method: "POST",
        body: {
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        },
      },
    );
  }

  async createTree(
    baseTree: string,
    tree: GitHubTreeEntry[],
  ): Promise<{ sha: string }> {
    return await this.request<{ sha: string }>(
      `/repos/${this.repoPath()}/git/trees`,
      {
        method: "POST",
        body: {
          base_tree: baseTree,
          tree,
        },
      },
    );
  }

  async createCommit(input: {
    message: string;
    tree: string;
    parents: string[];
    author?: { name?: string; email?: string };
  }): Promise<{ sha: string }> {
    return await this.request<{ sha: string }>(
      `/repos/${this.repoPath()}/git/commits`,
      {
        method: "POST",
        body: {
          message: input.message,
          tree: input.tree,
          parents: input.parents,
          author: input.author,
        },
      },
    );
  }

  async updateRef(branch: string, sha: string): Promise<{ ref: string }> {
    return await this.request<{ ref: string }>(
      `/repos/${this.repoPath()}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        body: {
          sha,
          force: false,
        },
      },
    );
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.options.auth.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub VFS git request failed: ${response.status} ${response.statusText} ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }

  private repoPath(): string {
    return `${encodeURIComponent(this.options.owner)}/${encodeURIComponent(
      this.options.repo,
    )}`;
  }
}

export async function resolveVfsGitAuth(
  runtime: IAgentRuntime,
  selection: GitHubAccountSelection = { role: "user" },
): Promise<VfsGitAuth> {
  const localAccounts = readGitHubAccounts(runtime);
  const allAccounts = await readGitHubAccountsWithConnectorCredentials(runtime);
  const account = resolveGitHubAccount(allAccounts, selection);
  if (!account) {
    return { source: "none", token: null };
  }
  const localAccount = resolveGitHubAccount(localAccounts, selection);
  const source =
    localAccount?.accountId === account.accountId ? "pat" : "eliza-cloud-oauth";
  return {
    source,
    token: account.token,
    accountId: account.accountId,
    role: account.role,
  };
}

function statusFor(
  current: string | undefined,
  previous: string | undefined,
): VfsGitStatus {
  if (current && !previous) return "added";
  if (!current && previous) return "deleted";
  if (current !== previous) return "modified";
  return "unchanged";
}

function normalizeVfsPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function decodeBlob(blob: GitHubBlobResponse): Uint8Array {
  if (blob.encoding !== "base64") {
    throw new Error(`Unsupported GitHub blob encoding: ${blob.encoding}`);
  }
  return Buffer.from(blob.content.replace(/\s/g, ""), "base64");
}

function requiredString(value: string | null | undefined): string {
  if (!value) throw new Error("Expected GitHub response string");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function commitId(
  parent: string | null,
  message: string,
  tree: Record<string, string>,
): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        parent,
        message,
        tree,
        nonce: crypto.randomUUID(),
      }),
    ),
  );
}
