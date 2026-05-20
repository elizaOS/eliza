import { throwGitError } from "./errors.ts";
import type { GitOperation, GitOperationId } from "./protocol.ts";

const DEFAULT_MAX_OPERATIONS = 200;

export class GitOperationHistory {
	private readonly operations: GitOperation[] = [];
	private readonly maxOperations: number;

	constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
		const env = options.env ?? process.env;
		this.maxOperations = parsePositiveInt(
			env.ELIZA_GIT_MAX_OPERATIONS,
			DEFAULT_MAX_OPERATIONS,
		);
	}

	start(name: string, cwd: string, command: string[]): GitOperation {
		const operation = {
			id: createOperationId(),
			name,
			cwd,
			command,
			status: "running" as const,
			stdout: "",
			stderr: "",
			startedAt: new Date().toISOString(),
		};
		this.operations.unshift(operation);
		this.trim();
		return operation;
	}

	complete(
		id: GitOperationId,
		stdout: string,
		stderr: string,
		exitCode: number | null,
		signal: string | null,
	): GitOperation {
		const operation = this.required(id);
		operation.status = "completed";
		operation.stdout = stdout;
		operation.stderr = stderr;
		operation.exitCode = exitCode;
		operation.signal = signal;
		operation.completedAt = new Date().toISOString();
		delete operation.error;
		return { ...operation };
	}

	fail(
		id: GitOperationId,
		error: string,
		stdout = "",
		stderr = "",
		exitCode: number | null = null,
		signal: string | null = null,
	): GitOperation {
		const operation = this.required(id);
		operation.status = "failed";
		operation.stdout = stdout;
		operation.stderr = stderr;
		operation.exitCode = exitCode;
		operation.signal = signal;
		operation.error = error;
		operation.completedAt = new Date().toISOString();
		return { ...operation };
	}

	list(limit?: number): GitOperation[] {
		const count = clampLimit(limit, this.maxOperations, this.maxOperations);
		return this.operations.slice(0, count).map((operation) => ({ ...operation }));
	}

	get(id: GitOperationId): GitOperation {
		return { ...this.required(id) };
	}

	count(): number {
		return this.operations.length;
	}

	private required(id: GitOperationId): GitOperation {
		const operation = this.operations.find((candidate) => candidate.id === id);
		if (operation) return operation;
		throwGitError({
			code: "GIT_OPERATION_NOT_FOUND",
			message: "Git operation was not found.",
			details: { operationId: id },
		});
	}

	private trim(): void {
		while (this.operations.length > this.maxOperations) this.operations.pop();
	}
}

function createOperationId(): string {
	const cryptoApi = globalThis.crypto;
	const random =
		cryptoApi && "randomUUID" in cryptoApi
			? cryptoApi.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `git-${random}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim().length === 0) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
