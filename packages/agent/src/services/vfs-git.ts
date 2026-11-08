/**
 * Git backend for VFS projects, running isomorphic-git against a
 * VirtualFilesystemService's on-disk filesRoot. createVfsGitService().run
 * dispatches a PostWorkbenchVfsGitRequest to one of init/clone/status/add/
 * remove/commit/log/branch/checkout/fetch/pull/push. Remotes are restricted to
 * HTTP(S), filepaths are normalized and confined (no traversal/absolute),
 * credentials come from the request or GITHUB_TOKEN/PAT, cloned URLs are
 * redacted in results, and any symlinks introduced by clone/checkout/pull are
 * removed and rejected — VFS projects hold no symlinks. URLs carrying a username
 * or password are rejected; credentials belong in `auth`.
 *
 * Network transfers have an overall deadline and an idle timeout, and stop once
 * the downloaded bytes pass the project's remaining quota. Clone runs into a
 * private staging directory outside the project lock; fetch and pull run on a
 * copy under the lock. Either way the result replaces the project's files only
 * after it passes the quota and file-size checks, so a failed transfer leaves
 * the project unchanged.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PostWorkbenchVfsGitRequest } from "@elizaos/contracts";
import git, {
  type AuthCallback,
  type GitHttpRequest,
  type GitHttpResponse,
  type HttpClient,
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

export interface VfsGitServiceOptions {
  /** Overall deadline for one network action. */
  timeoutMs?: number;
  /** Longest wait for the remote to answer or send the next chunk. */
  idleTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;

export class VfsGitError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_GIT_URL"
      | "INVALID_GIT_PATH"
      | "MISSING_ARGUMENT"
      | "SYMLINK_DENIED"
      | "PROJECT_NOT_EMPTY"
      | "GIT_TIMEOUT"
      | "QUOTA_EXCEEDED",
  ) {
    super(message);
    this.name = "VfsGitError";
  }
}

export function createVfsGitService(
  vfs: VirtualFilesystemService,
  options: VfsGitServiceOptions = {},
): VfsGitService {
  return new IsomorphicVfsGitService(vfs, options);
}

class IsomorphicVfsGitService implements VfsGitService {
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly vfs: VirtualFilesystemService,
    options: VfsGitServiceOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async run(request: PostWorkbenchVfsGitRequest): Promise<unknown> {
    if (request.action === "clone") return this.clone(request);
    return this.vfs.withProjectOperation(() => this.runUnlocked(request));
  }

  private transfer(maxBytes: number): GitTransfer {
    return new GitTransfer(maxBytes, this.timeoutMs, this.idleTimeoutMs);
  }

  /**
   * Run `operation` on a copy of the project's files, then put the copy in
   * place if it passes the quota checks. Call only inside the project lock.
   */
  private async onCopy<T>(
    operation: (dir: string, http: HttpClient) => Promise<T>,
  ): Promise<T> {
    const used = await this.vfs.measureFilesUnlocked();
    const stage = await this.makeStage();
    try {
      const dir = path.join(stage, "files");
      await fsp.cp(this.vfs.filesRoot, dir, {
        recursive: true,
        dereference: false,
      });
      const result = await this.transfer(this.vfs.quotaBytes - used.bytes).run(
        (http) => operation(dir, http),
      );
      await rejectAndRemoveSymlinks(dir);
      await this.vfs.replaceFilesUnlocked(dir);
      return result;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  }

  private async makeStage(): Promise<string> {
    return fsp.mkdtemp(path.join(this.vfs.projectRoot, ".git-stage-"));
  }

  private async runUnlocked(
    request: PostWorkbenchVfsGitRequest,
  ): Promise<unknown> {
    switch (request.action) {
      case "init":
        return this.init(request);
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
      default:
        throw new VfsGitError(
          `Unsupported Git action: ${request.action}`,
          "MISSING_ARGUMENT",
        );
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

  /**
   * Clone into a private staging directory without holding the project lock,
   * then take the lock only to check and apply the result.
   */
  private async clone(request: PostWorkbenchVfsGitRequest) {
    const url = requireUrl(request.url);
    const stage = await this.vfs.withProjectOperation(async () => {
      await this.assertProjectEmpty();
      return this.makeStage();
    });
    try {
      const dir = path.join(stage, "files");
      await this.transfer(this.vfs.quotaBytes).run((http) =>
        git.clone({
          fs,
          http,
          dir,
          url,
          singleBranch: request.singleBranch ?? true,
          depth: request.depth ?? 1,
          ref: request.ref ?? request.branch,
          onAuth: authCallback(request),
        }),
      );
      await rejectAndRemoveSymlinks(dir);
      const branch = await currentBranch(dir);
      await this.vfs.withProjectOperation(async () => {
        await this.assertProjectEmpty();
        await this.vfs.replaceFilesUnlocked(dir);
      });
      return { action: "clone", url: redactGitUrl(url), branch };
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  }

  private async assertProjectEmpty(): Promise<void> {
    if ((await fsp.readdir(this.vfs.filesRoot)).length > 0) {
      throw new VfsGitError(
        "Clone needs an empty project",
        "PROJECT_NOT_EMPTY",
      );
    }
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
    const result = await this.onCopy((dir, http) =>
      git.fetch({
        fs,
        http,
        dir,
        remote: request.remote ?? "origin",
        ref: request.ref ?? request.branch,
        singleBranch: request.singleBranch ?? true,
        depth: request.depth ?? 1,
        onAuth: authCallback(request),
      }),
    );
    return { action: "fetch", result };
  }

  private async pull(request: PostWorkbenchVfsGitRequest) {
    const result = await this.onCopy((dir, http) =>
      git.pull({
        fs,
        http,
        dir,
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
      }),
    );
    return { action: "pull", result };
  }

  private async push(request: PostWorkbenchVfsGitRequest) {
    const result = await this.transfer(this.vfs.quotaBytes).run((http) =>
      git.push({
        fs,
        http,
        dir: this.vfs.filesRoot,
        remote: request.remote ?? "origin",
        ref: request.ref ?? request.branch,
        force: request.force ?? false,
        onAuth: authCallback(request),
      }),
    );
    return { action: "push", result };
  }
}

/**
 * One network action's limits: an overall deadline, an idle timeout while
 * waiting on the remote, and a cap on downloaded bytes. Any of them aborts the
 * in-flight request and fails the action with a VfsGitError.
 */
class GitTransfer {
  private readonly controller = new AbortController();
  private readonly aborted: Promise<never>;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private received = 0;

  constructor(
    private readonly maxBytes: number,
    timeoutMs: number,
    private readonly idleTimeoutMs: number,
  ) {
    this.aborted = new Promise<never>((_, reject) => {
      this.controller.signal.addEventListener("abort", () =>
        reject(this.controller.signal.reason),
      );
    });
    this.aborted.catch(() => {});
    this.deadline = setTimeout(
      () =>
        this.fail(
          new VfsGitError(
            `Git transfer took longer than ${Math.round(timeoutMs / 1000)} s`,
            "GIT_TIMEOUT",
          ),
        ),
      timeoutMs,
    );
  }

  async run<T>(operation: (http: HttpClient) => Promise<T>): Promise<T> {
    const client: HttpClient = {
      request: (request) => this.request(request),
    };
    try {
      const result = operation(client);
      result.catch(() => {});
      return await Promise.race([result, this.aborted]);
    } catch (error) {
      // error-policy:J2 A tripped limit is the cause, whatever the client threw.
      if (this.controller.signal.aborted) throw this.controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(this.deadline);
      this.fail(undefined);
    }
  }

  private fail(reason: VfsGitError | undefined): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private async request(request: GitHttpRequest): Promise<GitHttpResponse> {
    const response = await this.wait(
      http.request({ ...request, signal: this.controller.signal }),
    );
    const body = response.body;
    if (!body) return response;
    const iterator = body[Symbol.asyncIterator]();
    const bounded: AsyncIterableIterator<Uint8Array> = {
      next: async () => {
        const chunk = await this.wait(iterator.next());
        if (!chunk.done && chunk.value) this.count(chunk.value.byteLength);
        return chunk;
      },
      return: async () => {
        await iterator.return?.();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return bounded;
      },
    };
    return { ...response, body: bounded };
  }

  /** Wait on the remote, failing after idleTimeoutMs without progress. */
  private async wait<T>(pending: Promise<T>): Promise<T> {
    const idle = setTimeout(
      () =>
        this.fail(
          new VfsGitError(
            `Git remote sent nothing for ${Math.round(this.idleTimeoutMs / 1000)} s`,
            "GIT_TIMEOUT",
          ),
        ),
      this.idleTimeoutMs,
    );
    try {
      return await Promise.race([pending, this.aborted]);
    } finally {
      clearTimeout(idle);
    }
  }

  private count(bytes: number): void {
    this.received += bytes;
    if (this.received <= this.maxBytes) return;
    const error = new VfsGitError(
      `Git transfer is larger than the project's free quota of ${this.maxBytes} bytes`,
      "QUOTA_EXCEEDED",
    );
    this.fail(error);
    throw error;
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
  if (parsed.username || parsed.password) {
    throw new VfsGitError(
      "Put Git credentials in auth, not in the URL",
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

/**
 * Request-supplied credentials go to whichever remote the request targets.
 * Host GitHub credentials (GITHUB_TOKEN, then GITHUB_PAT; empty values count
 * as unset) are only attached when isomorphic-git asks for auth on an HTTPS
 * github.com remote, so a user-supplied remote can never harvest them.
 */
function authCallback(
  request: PostWorkbenchVfsGitRequest,
): AuthCallback | undefined {
  const requestToken = nonEmpty(request.auth?.token);
  const requestPassword = request.auth?.password || undefined;
  const username = nonEmpty(request.auth?.username);
  const hostToken =
    nonEmpty(process.env.GITHUB_TOKEN) ?? nonEmpty(process.env.GITHUB_PAT);
  if (!requestToken && !requestPassword && !hostToken) return undefined;
  return (url) => {
    const token =
      requestToken ?? (isGitHubHttpsRemote(url) ? hostToken : undefined);
    const password = requestPassword ?? token;
    if (!password) return undefined;
    return {
      username: token ? (username ?? "x-access-token") : (username ?? "git"),
      password,
    };
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isGitHubHttpsRemote(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname === "github.com";
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
