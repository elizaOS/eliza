import { throwPtyError } from "./errors.ts";
import { PtyOutputBuffer } from "./output-buffer.ts";
import type {
	PtyCommandRunParams,
	PtyCommandRunResult,
	PtyCreateSessionParams,
	PtyCreateSessionResult,
	PtyKillParams,
	PtyOutputEntry,
	PtyOutputTailParams,
	PtyOutputTailResult,
	PtyResizeParams,
	PtySession,
	PtySessionId,
	PtyStatus,
	PtyWriteParams,
} from "./protocol.ts";

type BunSubprocess = Bun.Subprocess;

type ManagedSession = {
	session: PtySession;
	process: BunSubprocess | null;
	terminal: Bun.Terminal | null;
	decoder: TextDecoder;
	cols: number;
	rows: number;
	name?: string;
};

type LiveManagedSession = ManagedSession & {
	process: BunSubprocess;
	terminal: Bun.Terminal;
};

type TerminalServiceEvent =
	| { name: "pty.session.created"; payload: PtySession }
	| { name: "pty.output"; payload: PtyOutputEntry }
	| { name: "pty.session.exited"; payload: PtySession }
	| { name: "pty.session.killed"; payload: PtySession }
	| {
			name: "pty.error";
			payload: { code: "PTY_REQUEST_FAILED"; message: string; sessionId?: string };
	  };

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export class TerminalRemoteService {
	private readonly sessions = new Map<PtySessionId, ManagedSession>();
	private readonly outputBuffer: PtyOutputBuffer;
	private readonly maxSessions: number;
	private readonly commandTimeoutMs: number;
	private readonly emit?: (event: TerminalServiceEvent) => void;

	constructor(
		options: {
			env?: NodeJS.ProcessEnv;
			outputBuffer?: PtyOutputBuffer;
			emit?: (event: TerminalServiceEvent) => void;
		} = {},
	) {
		const env = options.env ?? process.env;
		this.outputBuffer = options.outputBuffer ?? new PtyOutputBuffer({ env });
		this.maxSessions = parsePositiveInt(
			env.ELIZA_PTY_MAX_SESSIONS,
			DEFAULT_MAX_SESSIONS,
		);
		this.commandTimeoutMs = parsePositiveInt(
			env.ELIZA_PTY_COMMAND_TIMEOUT_MS,
			DEFAULT_COMMAND_TIMEOUT_MS,
		);
		this.emit = options.emit;
	}

	async status(): Promise<PtyStatus> {
		return {
			id: "eliza.pty",
			ok: true,
			implementation: "bun-terminal",
			truePty: true,
			activeSessions: this.activeSessionCount(),
			totalSessions: this.sessions.size,
			limits: {
				maxSessions: this.maxSessions,
				maxOutputEntries: this.outputBuffer.limits.maxEntries,
				maxOutputBytes: this.outputBuffer.limits.maxBytes,
				commandTimeoutMs: this.commandTimeoutMs,
			},
		};
	}

	async createSession(
		params: PtyCreateSessionParams = {},
	): Promise<PtyCreateSessionResult> {
		if (this.activeSessionCount() >= this.maxSessions) {
			throwPtyError({
				code: "PTY_CREATE_FAILED",
				message: "Maximum active terminal sessions reached.",
				details: { maxSessions: this.maxSessions },
			});
		}

		const shell = defaultShell();
		const command = params.command?.trim() || shell;
		const args = params.args ? [...params.args] : [];
		const cwd = params.cwd?.trim() || defaultCwd();
		const createdAt = now();
		const session: PtySession = {
			id: createSessionId(),
			command,
			args,
			cwd,
			status: "starting",
			shell,
			createdAt,
			updatedAt: createdAt,
			exitCode: null,
			signal: null,
		};
		const managed: ManagedSession = {
			session,
			process: null,
			terminal: null,
			decoder: new TextDecoder(),
			cols: normalizeDimension(params.cols, DEFAULT_COLS),
			rows: normalizeDimension(params.rows, DEFAULT_ROWS),
			...(params.name === undefined ? {} : { name: params.name }),
		};
		this.sessions.set(session.id, managed);

		try {
			const terminalOptions = {
				cols: managed.cols,
				rows: managed.rows,
				...(managed.name === undefined ? {} : { name: managed.name }),
				data: (_terminal: Bun.Terminal, data: Uint8Array<ArrayBuffer>) => {
					const text = managed.decoder.decode(data, { stream: true });
					if (text.length > 0) this.pushOutput(session.id, text);
				},
				exit: (_terminal: Bun.Terminal, exitCode: number) => {
					if (exitCode !== 0) {
						this.markError(session.id, `Terminal stream closed with code ${exitCode}.`);
					}
				},
			};
			const process = Bun.spawn([command, ...args], {
				cwd,
				env: mergeEnv(params.env),
				terminal: terminalOptions,
			});
			managed.process = process;
			managed.terminal = process.terminal ?? null;
			managed.session = {
				...managed.session,
				status: "running",
				pid: process.pid,
				updatedAt: now(),
			};
			this.emit?.({ name: "pty.session.created", payload: { ...managed.session } });
			void process.exited
				.then((exitCode) => this.handleExit(session.id, exitCode))
				.catch((error) => this.markError(session.id, errorMessage(error)));
			return { session: { ...managed.session } };
		} catch (error) {
			const message = errorMessage(error);
			this.sessions.delete(session.id);
			throwPtyError({
				code: "PTY_CREATE_FAILED",
				message,
				sessionId: session.id,
			});
		}
	}

	async listSessions(): Promise<PtySession[]> {
		return [...this.sessions.values()].map((managed) => ({ ...managed.session }));
	}

	async getSession(sessionId: PtySessionId): Promise<PtySession> {
		return { ...this.requiredSession(sessionId).session };
	}

	async write(params: PtyWriteParams): Promise<PtySession> {
		const managed = this.requiredLiveSession(params.sessionId);
		if (typeof params.data !== "string") {
			throwPtyError({
				code: "PTY_WRITE_FAILED",
				message: "Terminal input must be a string.",
				sessionId: params.sessionId,
			});
		}
		try {
			managed.terminal.write(params.data);
			managed.session = {
				...managed.session,
				updatedAt: now(),
			};
			return { ...managed.session };
		} catch (error) {
			throwPtyError({
				code: "PTY_WRITE_FAILED",
				message: errorMessage(error),
				sessionId: params.sessionId,
			});
		}
	}

	async resize(params: PtyResizeParams): Promise<PtySession> {
		const managed = this.requiredSession(params.sessionId);
		const cols = normalizeDimension(params.cols, 0);
		const rows = normalizeDimension(params.rows, 0);
		if (cols <= 0 || rows <= 0) {
			throwPtyError({
				code: "PTY_RESIZE_FAILED",
				message: "Terminal cols and rows must be positive numbers.",
				sessionId: params.sessionId,
			});
		}
		managed.cols = cols;
		managed.rows = rows;
		if (managed.terminal) {
			managed.terminal.resize(cols, rows);
		}
		managed.session = {
			...managed.session,
			updatedAt: now(),
		};
		return { ...managed.session };
	}

	async kill(params: PtyKillParams): Promise<PtySession> {
		const managed = this.requiredLiveSession(params.sessionId);
		const signal = parseSignal(params.signal, params.sessionId);
		try {
			managed.process.kill(signal);
			if (managed.terminal && !managed.terminal.closed) {
				managed.terminal.close();
			}
			managed.session = {
				...managed.session,
				status: "killed",
				signal,
				updatedAt: now(),
				exitedAt: now(),
			};
			this.emit?.({ name: "pty.session.killed", payload: { ...managed.session } });
			return { ...managed.session };
		} catch (error) {
			throwPtyError({
				code: "PTY_KILL_FAILED",
				message: errorMessage(error),
				sessionId: params.sessionId,
			});
		}
	}

	async outputTail(
		params: PtyOutputTailParams,
	): Promise<PtyOutputTailResult> {
		this.requiredSession(params.sessionId);
		return this.outputBuffer.tail(
			params.sessionId,
			params.afterSequence,
			params.limit,
		);
	}

	async outputClear(params: { sessionId: PtySessionId }): Promise<{ ok: true }> {
		this.requiredSession(params.sessionId);
		this.outputBuffer.clear(params.sessionId);
		return { ok: true };
	}

	async commandRun(params: PtyCommandRunParams): Promise<PtyCommandRunResult> {
		if (typeof params.command !== "string" || params.command.trim().length === 0) {
			throwPtyError({
				code: "PTY_CREATE_FAILED",
				message: "Command must be a non-empty string.",
			});
		}
		const result = await this.createSession({
			command: params.command,
			args: params.args,
			cwd: params.cwd,
			env: params.env,
		});
		const timeoutMs = normalizeTimeout(params.timeoutMs, this.commandTimeoutMs);
		const timedOut = await this.waitForExitOrTimeout(result.session.id, timeoutMs);
		let session = await this.getSession(result.session.id);
		if (timedOut && session.status === "running") {
			session = await this.kill({ sessionId: session.id, signal: "SIGTERM" });
		}
		const tail = await this.outputTail({
			sessionId: result.session.id,
			limit: this.outputBuffer.limits.maxEntries,
		});
		return {
			session,
			output: tail.entries.map((entry) => entry.data).join(""),
			exitCode: session.exitCode ?? null,
			timedOut,
		};
	}

	private pushOutput(sessionId: PtySessionId, data: string): void {
		const entry = this.outputBuffer.push(sessionId, data);
		this.emit?.({ name: "pty.output", payload: entry });
	}

	private handleExit(sessionId: PtySessionId, exitCode: number): void {
		const managed = this.sessions.get(sessionId);
		if (!managed) return;
		if (managed.session.status === "killed") {
			managed.session = {
				...managed.session,
				exitCode,
				updatedAt: now(),
				exitedAt: managed.session.exitedAt ?? now(),
			};
			return;
		}
		const remainder = managed.decoder.decode();
		if (remainder.length > 0) this.pushOutput(sessionId, remainder);
		managed.session = {
			...managed.session,
			status: "exited",
			exitCode,
			signal: null,
			updatedAt: now(),
			exitedAt: now(),
		};
		this.emit?.({ name: "pty.session.exited", payload: { ...managed.session } });
	}

	private markError(sessionId: PtySessionId, message: string): void {
		const managed = this.sessions.get(sessionId);
		if (!managed) return;
		managed.session = {
			...managed.session,
			status: "error",
			error: message,
			updatedAt: now(),
			exitedAt: now(),
		};
		this.emit?.({
			name: "pty.error",
			payload: {
				code: "PTY_REQUEST_FAILED",
				message,
				sessionId,
			},
		});
	}

	private requiredSession(sessionId: PtySessionId): ManagedSession {
		const managed = this.sessions.get(sessionId);
		if (managed) return managed;
		throwPtyError({
			code: "PTY_SESSION_NOT_FOUND",
			message: "Terminal session was not found.",
			sessionId,
		});
	}

	private requiredLiveSession(sessionId: PtySessionId): ManagedSession & {
		process: BunSubprocess;
		terminal: Bun.Terminal;
	} {
		const managed = this.requiredSession(sessionId);
		this.assertLiveSession(managed, sessionId);
		return managed;
	}

	private assertLiveSession(
		managed: ManagedSession,
		sessionId: PtySessionId,
	): asserts managed is LiveManagedSession {
		if (
			managed.process &&
			managed.terminal &&
			(managed.session.status === "running" ||
				managed.session.status === "starting")
		) {
			return;
		}
		throwPtyError({
			code: "PTY_SESSION_ALREADY_EXITED",
			message: "Terminal session is no longer running.",
			sessionId,
		});
	}

	private activeSessionCount(): number {
		let count = 0;
		for (const managed of this.sessions.values()) {
			if (
				managed.session.status === "running" ||
				managed.session.status === "starting"
			) {
				count += 1;
			}
		}
		return count;
	}

	private waitForExitOrTimeout(
		sessionId: PtySessionId,
		timeoutMs: number,
	): Promise<boolean> {
		const managed = this.requiredSession(sessionId);
		if (managed.session.status !== "running" || !managed.process) {
			return Promise.resolve(false);
		}
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(true), timeoutMs);
			managed.process?.exited
				.then(() => {
					clearTimeout(timeout);
					resolve(false);
				})
				.catch(() => {
					clearTimeout(timeout);
					resolve(false);
				});
		});
	}
}

function mergeEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...process.env,
		...(overrides ?? {}),
	};
}

function defaultShell(): string {
	if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
	return process.env.SHELL ?? "/bin/sh";
}

function defaultCwd(): string {
	return (
		process.env.MILADY_REPO_DIR ?? process.env.ELIZA_REPO_DIR ?? process.cwd()
	);
}

function createSessionId(): string {
	const cryptoApi = globalThis.crypto;
	const random =
		cryptoApi && "randomUUID" in cryptoApi
			? cryptoApi.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `pty-${random}`;
}

function now(): string {
	return new Date().toISOString();
}

function normalizeDimension(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function parseSignal(
	value: string | undefined,
	sessionId: PtySessionId,
): NodeJS.Signals {
	const signal = value?.trim() || "SIGTERM";
	switch (signal) {
		case "SIGABRT":
		case "SIGALRM":
		case "SIGBUS":
		case "SIGCHLD":
		case "SIGCONT":
		case "SIGFPE":
		case "SIGHUP":
		case "SIGILL":
		case "SIGINT":
		case "SIGIO":
		case "SIGIOT":
		case "SIGKILL":
		case "SIGPIPE":
		case "SIGPOLL":
		case "SIGPROF":
		case "SIGPWR":
		case "SIGQUIT":
		case "SIGSEGV":
		case "SIGSTKFLT":
		case "SIGSTOP":
		case "SIGSYS":
		case "SIGTERM":
		case "SIGTRAP":
		case "SIGTSTP":
		case "SIGTTIN":
		case "SIGTTOU":
		case "SIGUNUSED":
		case "SIGURG":
		case "SIGUSR1":
		case "SIGUSR2":
		case "SIGVTALRM":
		case "SIGWINCH":
		case "SIGXCPU":
		case "SIGXFSZ":
			return signal;
	}
	throwPtyError({
		code: "PTY_KILL_FAILED",
		message: "Unsupported signal.",
		sessionId,
		details: { signal },
	});
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim().length === 0) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Terminal operation failed.";
}
