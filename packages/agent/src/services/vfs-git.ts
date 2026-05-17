import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PostWorkbenchVfsGitRequest } from "@elizaos/shared";
import git, {
  type AuthCallback,
  type ReadCommitResult,
  type StatusRow,
} from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { VirtualFilesystemService } from "./virtual-filesystem.ts";

export interface VfsGitStatusEntry {
  filepath: string;
  head: GitFileState;
  workdir: GitFileState;
  stage: GitFileState;
}

export type GitFileState = "absent" | "unchanged" | "modified";

export interface VfsGitService {
  run(request: PostWorkbenchVfsGitRequest): Promise<unknown>;
}

export class VfsGitError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_GIT_URL"
      | "INVALID_GIT_PATH"
      | "MISSING_ARGUMENT"
      | "SYMLINK_DENIED",
  ) {
    super(message);
    this.name = "VfsGitError";
  }
}

export function createVfsGitService(
  vfs: VirtualFilesystemService,
): VfsGitService {
  return new IsomorphicVfsGitService(vfs);
}

class IsomorphicVfsGitService implements VfsGitService {
  constructor(private readonly vfs: VirtualFilesystemService) {}

  async run(request: PostWorkbenchVfsGitRequest): Promise<unknown> {
    await this.vfs.initialize();
    switch (request.action) {
      case "init":
        return this.init(request);
      case "clone":
        return this.clone(request);
      case "status":
        return this.status();
      case "add":
        return this.add(request);
      case "remove":
        return this.remove(request);
      case "commit":
        return this.commit(request);
      case "log":
        return this.log(request);
      case "branch":
        return this.branch(request);
      case "checkout":
        return this.checkout(request);
      case "fetch":
        return this.fetch(request);
      case "pull":
        return this.pull(request);
      case "push":
        return this.push(request);
    }
  }

  private async init(request: PostWorkbenchVfsGitRequest) {
    await git.init({
      fs,
      dir: this.vfs.filesRoot,
      defaultBranch: request.defaultBranch ?? request.branch ?? "main",
    });
    return {
      action: "init",
      branch: await currentBranch(this.vfs.filesRoot),
    };
  }

  private async clone(request: PostWorkbenchVfsGitRequest) {
    const url = requireUrl(request.url);
    await git.clone({
      fs,
      http,
      dir: this.vfs.filesRoot,
      url,
      singleBranch: request.singleBranch ?? true,
      depth: request.depth ?? 1,
      ref: request.ref ?? request.branch,
      onAuth: authCallback(request),
    });
    await rejectAndRemoveSymlinks(this.vfs.filesRoot);
    return {
      action: "clone",
      url: redactGitUrl(url),
      branch: await currentBranch(this.vfs.filesRoot),
    };
  }

  private async status() {
    const matrix = await git.statusMatrix({
      fs,
      dir: this.vfs.filesRoot,
    });
    return {
      action: "status",
      branch: await currentBranch(this.vfs.filesRoot),
      clean: matrix.every((row: StatusRow) => isCleanStatus(row)),
      files: matrix.map(statusRowView),
    };
  }

  private async add(request: PostWorkbenchVfsGitRequest) {
    const paths = requestPaths(request);
    for (const filepath of paths) {
      await git.add({ fs, dir: this.vfs.filesRoot, filepath });
    }
    return { action: "add", paths };
  }

  private async remove(request: PostWorkbenchVfsGitRequest) {
    const paths = requestPaths(request);
    for (const filepath of paths) {
      await git.remove({ fs, dir: this.vfs.filesRoot, filepath });
    }
    return { action: "remove", paths };
  }

  private async commit(request: PostWorkbenchVfsGitRequest) {
    const message = requireString(request.message, "message");
    const oid = await git.commit({
      fs,
      dir: this.vfs.filesRoot,
      message,
      author: {
        name:
          request.authorName ??
          process.env.GIT_AUTHOR_NAME ??
          process.env.GITHUB_USER ??
          "eliza",
        email:
          request.authorEmail ??
          process.env.GIT_AUTHOR_EMAIL ??
          "eliza@example.local",
      },
    });
    return { action: "commit", oid };
  }

  private async log(request: PostWorkbenchVfsGitRequest) {
    const commits = await git.log({
      fs,
      dir: this.vfs.filesRoot,
      ref: request.ref,
      depth: request.depth ?? 20,
    });
    return {
      action: "log",
      commits: commits.map(commitView),
    };
  }

  private async branch(request: PostWorkbenchVfsGitRequest) {
    const ref = requireString(request.branch ?? request.ref, "branch");
    await git.branch({
      fs,
      dir: this.vfs.filesRoot,
      ref,
      checkout: true,
      force: request.force ?? false,
    });
    return {
      action: "branch",
      branch: await currentBranch(this.vfs.filesRoot),
    };
  }

  private async checkout(request: PostWorkbenchVfsGitRequest) {
    const ref = requireString(request.ref ?? request.branch, "ref");
    await git.checkout({
      fs,
      dir: this.vfs.filesRoot,
      ref,
      force: request.force ?? false,
    });
    await rejectAndRemoveSymlinks(this.vfs.filesRoot);
    return {
      action: "checkout",
      branch: await currentBranch(this.vfs.filesRoot),
    };
  }

  private async fetch(request: PostWorkbenchVfsGitRequest) {
    const result = await git.fetch({
      fs,
      http,
      dir: this.vfs.filesRoot,
      remote: request.remote ?? "origin",
      ref: request.ref ?? request.branch,
      singleBranch: request.singleBranch ?? true,
      depth: request.depth ?? 1,
      onAuth: authCallback(request),
    });
    return { action: "fetch", result };
  }

  private async pull(request: PostWorkbenchVfsGitRequest) {
    const result = await git.pull({
      fs,
      http,
      dir: this.vfs.filesRoot,
      remote: request.remote ?? "origin",
      ref: request.ref ?? request.branch,
      singleBranch: request.singleBranch ?? true,
      author: {
        name:
          request.authorName ??
          process.env.GIT_AUTHOR_NAME ??
          process.env.GITHUB_USER ??
          "eliza",
        email:
          request.authorEmail ??
          process.env.GIT_AUTHOR_EMAIL ??
          "eliza@example.local",
      },
      onAuth: authCallback(request),
    });
    await rejectAndRemoveSymlinks(this.vfs.filesRoot);
    return { action: "pull", result };
  }

  private async push(request: PostWorkbenchVfsGitRequest) {
    const result = await git.push({
      fs,
      http,
      dir: this.vfs.filesRoot,
      remote: request.remote ?? "origin",
      ref: request.ref ?? request.branch,
      force: request.force ?? false,
      onAuth: authCallback(request),
    });
    return { action: "push", result };
  }
}

function requireUrl(raw: string | undefined): string {
  const value = requireString(raw, "url");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new VfsGitError(
      "VFS Git only supports HTTP(S) remotes",
      "INVALID_GIT_URL",
    );
  }
  return value;
}

function requireString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new VfsGitError(`${name} is required`, "MISSING_ARGUMENT");
  }
  return trimmed;
}

function requestPaths(request: PostWorkbenchVfsGitRequest): string[] {
  const paths = request.paths ?? (request.filepath ? [request.filepath] : []);
  if (paths.length === 0) {
    throw new VfsGitError("paths or filepath is required", "MISSING_ARGUMENT");
  }
  return paths.map(normalizeGitFilepath);
}

function normalizeGitFilepath(input: string): string {
  const normalized = path.posix.normalize(input.trim().replace(/\\/g, "/"));
  const stripped = normalized.replace(/^\/+/, "");
  if (
    !stripped ||
    stripped === "." ||
    stripped === ".." ||
    stripped.startsWith("../") ||
    path.posix.isAbsolute(stripped)
  ) {
    throw new VfsGitError("Invalid Git filepath", "INVALID_GIT_PATH");
  }
  return stripped;
}

function authCallback(
  request: PostWorkbenchVfsGitRequest,
): AuthCallback | undefined {
  const token =
    request.auth?.token ??
    process.env.GITHUB_TOKEN?.trim() ??
    process.env.GITHUB_PAT?.trim();
  const username = request.auth?.username?.trim();
  const password = request.auth?.password ?? token;
  if (!password) return undefined;
  return () => ({
    username: token ? (username ?? "x-access-token") : (username ?? "git"),
    password,
  });
}

function statusRowView(row: StatusRow): VfsGitStatusEntry {
  return {
    filepath: `/${row[0]}`,
    head: gitState(row[1]),
    workdir: gitState(row[2]),
    stage: gitState(row[3]),
  };
}

function gitState(value: number): GitFileState {
  return value === 0 ? "absent" : value === 1 ? "unchanged" : "modified";
}

function isCleanStatus(row: StatusRow): boolean {
  return row[1] === row[2] && row[2] === row[3];
}

async function currentBranch(dir: string): Promise<string | null> {
  return git
    .currentBranch({ fs, dir, fullname: false })
    .then((branch: unknown) => (typeof branch === "string" ? branch : null))
    .catch(() => null);
}

function commitView(commit: ReadCommitResult) {
  return {
    oid: commit.oid,
    message: commit.commit.message,
    author: commit.commit.author,
    committer: commit.commit.committer,
  };
}

async function rejectAndRemoveSymlinks(root: string): Promise<void> {
  const symlinks: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await fsp.readdir(dir, { withFileTypes: true })) {
      const realPath = path.join(dir, dirent.name);
      const stat = await fsp.lstat(realPath);
      if (stat.isSymbolicLink()) {
        symlinks.push(realPath);
        continue;
      }
      if (stat.isDirectory()) await walk(realPath);
    }
  };
  await walk(root);
  for (const symlink of symlinks) {
    await fsp.rm(symlink, { force: true });
  }
  if (symlinks.length > 0) {
    throw new VfsGitError(
      "Git operation produced symlinks, which are not allowed in VFS projects",
      "SYMLINK_DENIED",
    );
  }
}

function redactGitUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}
