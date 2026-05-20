import { GitException, throwGitError } from "./errors.ts";
import { defaultCwd, GitCommandRunner } from "./git-command.ts";
import type {
	GitAddParams,
	GitBranch,
	GitBranchCreateParams,
	GitBranchDeleteParams,
	GitCheckoutParams,
	GitCommandResult,
	GitCommandRunParams,
	GitCommitParams,
	GitDiffParams,
	GitLogEntry,
	GitLogParams,
	GitOperation,
	GitRemote,
	GitRemoteOperationParams,
	GitRepoInfo,
	GitRepoParams,
	GitRestoreParams,
	GitStatusFile,
	GitStatusPayload,
	GitStatusResult,
} from "./protocol.ts";

const LOG_RECORD_SEPARATOR = "\x1e";
const LOG_FIELD_SEPARATOR = "\x1f";

export class GitSatelliteService {
	private readonly runner: GitCommandRunner;

	constructor(options: { runner?: GitCommandRunner } = {}) {
		this.runner = options.runner ?? new GitCommandRunner();
	}

	async status(): Promise<GitStatusPayload> {
		const version = await this.runner.run({
			name: "git.status",
			args: ["--version"],
			cwd: defaultCwd(),
		});
		return {
			id: "eliza.git",
			ok: true,
			version: version.stdout.trim(),
			defaultCwd: defaultCwd(),
			operationCount: this.runner.history.count(),
		};
	}

	async repoInfo(params: GitRepoParams = {}): Promise<GitRepoInfo> {
		const cwd = params.cwd?.trim() || defaultCwd();
		const root = await this.repoRoot(cwd);
		const [branchResult, headResult, remoteResult] = await Promise.allSettled([
			this.runner.run({
				name: "git.branch.current",
				cwd: root,
				args: ["rev-parse", "--abbrev-ref", "HEAD"],
			}),
			this.runner.run({
				name: "git.head",
				cwd: root,
				args: ["rev-parse", "HEAD"],
			}),
			this.runner.run({
				name: "git.remote.origin",
				cwd: root,
				args: ["remote", "get-url", "origin"],
			}),
		]);
		return {
			cwd,
			root,
			isRepo: true,
			...(branchResult.status === "fulfilled"
				? { branch: branchResult.value.stdout.trim() }
				: {}),
			...(headResult.status === "fulfilled"
				? { head: headResult.value.stdout.trim() }
				: {}),
			...(remoteResult.status === "fulfilled"
				? { remoteUrl: remoteResult.value.stdout.trim() }
				: {}),
		};
	}

	async statusRepo(params: GitRepoParams = {}): Promise<GitStatusResult> {
		const repo = await this.repoInfo(params);
		const result = await this.runner.run({
			name: "git.status",
			cwd: repo.root,
			args: ["status", "--porcelain=v1", "--branch"],
		});
		return parseStatus(repo, result.stdout);
	}

	async branches(params: GitRepoParams = {}): Promise<GitBranch[]> {
		const root = await this.repoRoot(params.cwd);
		const result = await this.runner.run({
			name: "git.branches",
			cwd: root,
			args: [
				"for-each-ref",
				"--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)",
				"refs/heads",
				"refs/remotes",
			],
		});
		return result.stdout
			.split(/\r?\n/)
			.filter((line) => line.length > 0)
			.map((line) => {
				const [refName, shortName, head, upstream] = line.split("\0");
				return {
					name: shortName ?? refName ?? "",
					current: head === "*",
					remote: refName?.startsWith("refs/remotes/") === true,
					...(upstream ? { upstream } : {}),
				};
			})
			.filter((branch) => branch.name.length > 0 && !branch.name.endsWith("/HEAD"));
	}

	async remotes(params: GitRepoParams = {}): Promise<GitRemote[]> {
		const root = await this.repoRoot(params.cwd);
		const result = await this.runner.run({
			name: "git.remotes",
			cwd: root,
			args: ["remote", "-v"],
		});
		const remotes = new Map<string, GitRemote>();
		for (const line of result.stdout.split(/\r?\n/)) {
			if (line.trim().length === 0) continue;
			const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
			if (!match) continue;
			const [, name, url, kind] = match;
			const remote = remotes.get(name) ?? { name };
			if (kind === "fetch") remote.fetchUrl = url;
			else remote.pushUrl = url;
			remotes.set(name, remote);
		}
		return [...remotes.values()];
	}

	async log(params: GitLogParams = {}): Promise<GitLogEntry[]> {
		const root = await this.repoRoot(params.cwd);
		const limit = clampLimit(params.limit, 20, 100);
		const pretty = `%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e`;
		const args = ["log", `--max-count=${limit}`, `--pretty=format:${pretty}`];
		if (params.ref) args.push(params.ref);
		const result = await this.runner.run({
			name: "git.log",
			cwd: root,
			args,
		});
		return parseLog(result.stdout);
	}

	async diff(params: GitDiffParams = {}): Promise<{ raw: string }> {
		const root = await this.repoRoot(params.cwd);
		const args = ["diff"];
		if (params.staged === true) args.push("--staged");
		if (params.ref) args.push(params.ref);
		if (params.path) args.push("--", params.path);
		const result = await this.runner.run({
			name: "git.diff",
			cwd: root,
			args,
		});
		return { raw: result.stdout };
	}

	async show(params: { cwd?: string; ref: string; path?: string }): Promise<{ raw: string }> {
		const root = await this.repoRoot(params.cwd);
		if (!params.ref || params.ref.trim().length === 0) {
			throwGitError({
				code: "GIT_REQUEST_FAILED",
				message: "git.show ref is required.",
				cwd: root,
			});
		}
		const args = ["show", params.ref.trim()];
		if (params.path) args.push("--", params.path);
		const result = await this.runner.run({
			name: "git.show",
			cwd: root,
			args,
		});
		return { raw: result.stdout };
	}

	async add(params: GitAddParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		return this.commandResult("git.add", root, ["add", "--", ...requiredPaths(params.paths)]);
	}

	async restore(params: GitRestoreParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const args = ["restore"];
		if (params.staged === true) args.push("--staged");
		if (params.source) args.push("--source", params.source);
		args.push("--", ...requiredPaths(params.paths));
		return this.commandResult("git.restore", root, args);
	}

	async checkout(params: GitCheckoutParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const ref = requiredString(params.ref, "checkout ref");
		const args = params.createBranch === true ? ["checkout", "-b", ref] : ["checkout", ref];
		return this.commandResult("git.checkout", root, args);
	}

	async branchCreate(params: GitBranchCreateParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const name = requiredString(params.name, "branch name");
		const args =
			params.checkout === true
				? ["checkout", "-b", name]
				: ["branch", name];
		if (params.startPoint) args.push(params.startPoint);
		return this.commandResult("git.branch.create", root, args);
	}

	async branchDelete(params: GitBranchDeleteParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const name = requiredString(params.name, "branch name");
		return this.commandResult("git.branch.delete", root, [
			"branch",
			params.force === true ? "-D" : "-d",
			name,
		]);
	}

	async commit(params: GitCommitParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		if (params.noVerify === true) {
			throwGitError({
				code: "GIT_REQUEST_FAILED",
				message: "noVerify commits are not supported by this Git Satellite.",
				cwd: root,
			});
		}
		const message = requiredString(params.message, "commit message");
		const args = ["commit", "-m", message];
		if (params.amend === true) args.push("--amend");
		return this.commandResult("git.commit", root, args);
	}

	async fetch(params: GitRemoteOperationParams = {}): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const args = ["fetch"];
		if (params.remote) args.push(params.remote);
		if (params.branch) args.push(params.branch);
		args.push(...safeExtraArgs(params.extraArgs));
		return this.commandResult("git.fetch", root, args);
	}

	async pull(params: GitRemoteOperationParams = {}): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const args = ["pull"];
		if (params.remote) args.push(params.remote);
		if (params.branch) args.push(params.branch);
		args.push(...safeExtraArgs(params.extraArgs));
		return this.commandResult("git.pull", root, args);
	}

	async push(params: GitRemoteOperationParams = {}): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		const args = ["push"];
		if (params.setUpstream === true) args.push("-u");
		if (params.remote) args.push(params.remote);
		if (params.branch) args.push(params.branch);
		args.push(...safeExtraArgs(params.extraArgs));
		return this.commandResult("git.push", root, args);
	}

	async commandRun(params: GitCommandRunParams): Promise<GitCommandResult> {
		const root = await this.repoRoot(params.cwd);
		if (!Array.isArray(params.args) || params.args.length === 0) {
			throwGitError({
				code: "GIT_REQUEST_FAILED",
				message: "git.command.run args must be a non-empty array.",
				cwd: root,
			});
		}
		const result = await this.runner.run({
			name: "git.command.run",
			cwd: root,
			args: params.args,
		});
		return { operation: result.operation };
	}

	operationList(params: { limit?: number } = {}): Promise<GitOperation[]> {
		return Promise.resolve(this.runner.history.list(params.limit));
	}

	operationGet(params: { operationId: string }): Promise<GitOperation> {
		return Promise.resolve(this.runner.history.get(params.operationId));
	}

	private async commandResult(
		name: string,
		cwd: string,
		args: string[],
	): Promise<GitCommandResult> {
		const result = await this.runner.run({ name, cwd, args });
		return { operation: result.operation };
	}

	private async repoRoot(cwd?: string): Promise<string> {
		const resolved = cwd?.trim() || defaultCwd();
		try {
			const result = await this.runner.run({
				name: "git.repo.root",
				cwd: resolved,
				args: ["rev-parse", "--show-toplevel"],
			});
			const root = result.stdout.trim();
			if (root.length === 0) {
				throwGitError({
					code: "GIT_INVALID_REPO",
					message: "Git returned an empty repository root.",
					cwd: resolved,
				});
			}
			return root;
		} catch (error) {
			if (error instanceof GitException) {
				throwGitError({
					code: "GIT_REPO_NOT_FOUND",
					message: "Git repository was not found.",
					cwd: resolved,
					command: error.command,
					status: error.status,
					stderr: error.stderr,
				});
			}
			throw error;
		}
	}
}

function parseStatus(repo: GitRepoInfo, raw: string): GitStatusResult {
	const files: GitStatusFile[] = [];
	let branch = repo.branch;
	let ahead: number | undefined;
	let behind: number | undefined;
	for (const line of raw.split(/\r?\n/)) {
		if (line.length === 0) continue;
		if (line.startsWith("## ")) {
			const branchLine = line.slice(3);
			branch = branchLine.split(/[.\s]/)[0] || branch;
			const aheadMatch = /ahead (\d+)/.exec(branchLine);
			const behindMatch = /behind (\d+)/.exec(branchLine);
			if (aheadMatch) ahead = Number.parseInt(aheadMatch[1], 10);
			if (behindMatch) behind = Number.parseInt(behindMatch[1], 10);
			continue;
		}
		const index = line[0] ?? " ";
		const workingTree = line[1] ?? " ";
		const filePath = line.slice(3);
		files.push({
			path: filePath,
			index,
			workingTree,
			raw: line,
		});
	}
	return {
		repo,
		...(branch === undefined ? {} : { branch }),
		...(ahead === undefined ? {} : { ahead }),
		...(behind === undefined ? {} : { behind }),
		files,
		raw,
	};
}

function parseLog(raw: string): GitLogEntry[] {
	return raw
		.split(LOG_RECORD_SEPARATOR)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const [hash, shortHash, authorName, authorEmail, date, subject, body] =
				entry.split(LOG_FIELD_SEPARATOR);
			return {
				hash: hash ?? "",
				shortHash: shortHash ?? "",
				...(authorName ? { authorName } : {}),
				...(authorEmail ? { authorEmail } : {}),
				...(date ? { date } : {}),
				subject: subject ?? "",
				...(body ? { body } : {}),
			};
		});
}

function requiredPaths(paths: string[]): string[] {
	if (!Array.isArray(paths) || paths.length === 0) {
		throwGitError({
			code: "GIT_REQUEST_FAILED",
			message: "At least one path is required.",
		});
	}
	return paths.map((path) => requiredString(path, "path"));
}

function requiredString(value: string, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throwGitError({
			code: "GIT_REQUEST_FAILED",
			message: `${label} must be a non-empty string.`,
		});
	}
	return value.trim();
}

function safeExtraArgs(args?: string[]): string[] {
	if (args === undefined) return [];
	return args.map((arg) => requiredString(arg, "extra arg"));
}

function clampLimit(
	value: number | undefined,
	defaultValue: number,
	maxValue: number,
): number {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value <= 0) return defaultValue;
	return Math.min(Math.floor(value), maxValue);
}
