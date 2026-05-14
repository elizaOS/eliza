import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  readGitHubAccounts,
  readGitHubAccountsWithConnectorCredentials,
  resolveGitHubAccount,
  type GitHubAccountSelection,
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

type VfsGitIndex = Record<string, string>;

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

  private async currentTree(): Promise<VfsGitIndex> {
    const files = await this.fs.exportFiles();
    const tree: VfsGitIndex = {};
    for (const file of files) {
      const path = normalizeVfsPath(file.path);
      if (path.startsWith(`${VIRTUAL_GIT_ROOT}/`)) continue;
      tree[path] = sha256(file.bytes);
    }
    return tree;
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
