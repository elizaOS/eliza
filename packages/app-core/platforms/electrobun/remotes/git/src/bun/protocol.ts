export const GIT_REMOTE_ID = "eliza.git" as const;

export type GitOperationId = string;

export type GitErrorCode =
	| "GIT_NOT_AVAILABLE"
	| "GIT_REPO_NOT_FOUND"
	| "GIT_INVALID_REPO"
	| "GIT_COMMAND_FAILED"
	| "GIT_OPERATION_NOT_FOUND"
	| "GIT_REQUEST_FAILED"
	| "GIT_UNKNOWN";

export type GitError = {
	code: GitErrorCode;
	message: string;
	cwd?: string;
	command?: string[];
	status?: number;
	stderr?: string;
	details?: unknown;
};

export type GitOperationStatus = "running" | "completed" | "failed";

export type GitOperation = {
	id: GitOperationId;
	name: string;
	cwd: string;
	command: string[];
	status: GitOperationStatus;
	stdout: string;
	stderr: string;
	exitCode?: number | null;
	signal?: string | null;
	startedAt: string;
	completedAt?: string;
	error?: string;
};

export type GitRepoInfo = {
	cwd: string;
	root: string;
	isRepo: boolean;
	branch?: string;
	head?: string;
	remoteUrl?: string;
};

export type GitStatusFile = {
	path: string;
	index: string;
	workingTree: string;
	raw: string;
};

export type GitStatusResult = {
	repo: GitRepoInfo;
	branch?: string;
	ahead?: number;
	behind?: number;
	files: GitStatusFile[];
	raw: string;
};

export type GitBranch = {
	name: string;
	current: boolean;
	remote: boolean;
	upstream?: string;
};

export type GitRemote = {
	name: string;
	fetchUrl?: string;
	pushUrl?: string;
};

export type GitLogEntry = {
	hash: string;
	shortHash: string;
	authorName?: string;
	authorEmail?: string;
	date?: string;
	subject: string;
	body?: string;
};

export type GitRepoParams = {
	cwd?: string;
};

export type GitPathParams = {
	cwd?: string;
	path?: string;
};

export type GitDiffParams = {
	cwd?: string;
	staged?: boolean;
	path?: string;
	ref?: string;
};

export type GitLogParams = {
	cwd?: string;
	limit?: number;
	ref?: string;
};

export type GitAddParams = {
	cwd?: string;
	paths: string[];
};

export type GitRestoreParams = {
	cwd?: string;
	paths: string[];
	staged?: boolean;
	source?: string;
};

export type GitCheckoutParams = {
	cwd?: string;
	ref: string;
	createBranch?: boolean;
};

export type GitBranchCreateParams = {
	cwd?: string;
	name: string;
	checkout?: boolean;
	startPoint?: string;
};

export type GitBranchDeleteParams = {
	cwd?: string;
	name: string;
	force?: boolean;
};

export type GitCommitParams = {
	cwd?: string;
	message: string;
	amend?: boolean;
	noVerify?: boolean;
};

export type GitRemoteOperationParams = {
	cwd?: string;
	remote?: string;
	branch?: string;
	setUpstream?: boolean;
	extraArgs?: string[];
};

export type GitCommandRunParams = {
	cwd?: string;
	args: string[];
};

export type GitCommandResult = {
	operation: GitOperation;
};

export type GitStatusPayload = {
	id: "eliza.git";
	ok: true;
	version: string;
	defaultCwd: string;
	operationCount: number;
};

export type GitMethod =
	| "git.status"
	| "git.repo.info"
	| "git.branches"
	| "git.remotes"
	| "git.log"
	| "git.diff"
	| "git.show"
	| "git.add"
	| "git.restore"
	| "git.checkout"
	| "git.branch.create"
	| "git.branch.delete"
	| "git.commit"
	| "git.fetch"
	| "git.pull"
	| "git.push"
	| "git.operation.list"
	| "git.operation.get"
	| "git.command.run";

export type GitEventName =
	| "git.operation.started"
	| "git.operation.completed"
	| "git.operation.failed";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue }
	| JsonValue[];

export type GitWorkerRequestMessage = {
	type: "request";
	requestId: string | number;
	method: GitMethod;
	params?: JsonValue;
};

export type GitResponsePayload =
	| GitStatusPayload
	| GitRepoInfo
	| GitStatusResult
	| GitBranch[]
	| GitRemote[]
	| GitLogEntry[]
	| GitCommandResult
	| GitOperation[]
	| GitOperation
	| { raw: string };

export type GitWorkerResponseMessage =
	| {
			type: "response";
			requestId: string | number;
			success: true;
			payload: GitResponsePayload;
	  }
	| {
			type: "response";
			requestId: string | number;
			success: false;
			error: GitError;
	  };

export type GitWorkerReadyMessage = {
	type: "ready";
};

export type GitWorkerEventMessage = {
	type: "event";
	name: GitEventName;
	payload: GitOperation;
};

export type GitWorkerOutboundMessage =
	| GitWorkerResponseMessage
	| GitWorkerReadyMessage
	| GitWorkerEventMessage;
